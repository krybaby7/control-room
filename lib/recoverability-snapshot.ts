import {verifyRecoverabilityRowHashes} from './recoverability-row-hashes.ts';
import {startRecoverabilityPhase} from './recoverability-diagnostics.ts';
import {compareSqliteText} from './sqlite-text-order.ts';
import {REFERENCE_LIMITS} from './workspace-references.ts';
import {prepareHistoricalAuditRows} from './audit-import.ts';
import type {Workspace} from './types.ts';
import type {SqlDatabase,SqlStatement} from './workspace-store.ts';
import {readRecoverabilityAuxiliary} from './recoverability-auxiliary.ts';
import {OWNER_TABLES,ownerTable,type GuardedWrite,type ModuleRow,type OwnerScopedReader,type RegisteredOwnerTable} from './workspace-modules.ts';
import type {AuditEventDraft,JsonValue} from './workspace-protocol.ts';
import type {ModuleReplacement,MutationPlan} from './workspace-transaction.ts';
import {moduleProjection} from './module-columns.ts';
import {BUNDLE_LIMITS,boundedPages} from './workspace-export-core.ts';
import {buildWorkspaceBundle,exportRegistry,moduleTables,serializePortableAuditRow,type WorkspaceBundle} from './workspace-export.ts';
import {canonical,contentHash} from './canonical-json.ts';
import {measureRecoverability,type RecoverabilityMeasurement,type RecoverabilityTableInput} from './recoverability-measure.ts';
import {validateOperationalWatermarks} from './operational-watermarks.ts';
import {canonicalJsonValue} from './audit-events.ts';
import {getWorkspaceNamespaces} from './workspace-namespaces.ts';
import {parseWorkspaceExport} from './workspace-validation.ts';
const streams:Partial<Record<RegisteredOwnerTable,string>>={agent_results:'agents',evaluation_runs:'agents',source_observations:'sources',source_sync_runs:'sources',integration_history:'sources',review_snapshots:'reviews',review_analysis_runs:'reviews',notification_events:'notifications',automation_occurrences:'automations'};

type CapturedPhysicalRow=ModuleRow&{stream_sequence?:number};
/** Closed read-only batches retain independent key cursors, exact row shapes,
 * source sequence, page and row bounds. No JSON aggregate exceeds a row limit. */
async function readPhysicalImage(db:SqlDatabase,owner:string,auditStatement:SqlStatement):Promise<{physical:Map<RegisteredOwnerTable,CapturedPhysicalRow[]>;auditPage:Record<string,unknown>[]} >{
 // One compiled batch of 36 physical tables plus one audit page. Adding
 // tables or sidecar reads requires an explicit bound review.
 if(OWNER_TABLES.length>36)throw new Error('Physical snapshot table batch bound exceeded.');
 const image=new Map<RegisteredOwnerTable,CapturedPhysicalRow[]>(),after=new Map<RegisteredOwnerTable,string>();
 let pending=[...OWNER_TABLES],retainedBytes=0,auditPage:Record<string,unknown>[]|undefined;
 for(const table of pending){image.set(table,[]);after.set(table,'');}
 while(pending.length){
  const following:RegisteredOwnerTable[]=[];
  for(let offset=0;offset<pending.length;offset+=36){
   const tables=pending.slice(offset,offset+36),statements=tables.map(table=>db.prepare(`SELECT id, row_revision, payload_json, content_hash${streams[table]?', stream_sequence':''} FROM ${ownerTable(table)} WHERE user_id = ? AND id > ? ORDER BY id LIMIT ?`).bind(owner,after.get(table)!,BUNDLE_LIMITS.pageSize));
   // One fixed audit SELECT shares the first physical batch. Its frozen vector,
   // own cursor, page cap and later complete-rowset verification remain separate.
   const includesAudit=auditPage===undefined;
   if(includesAudit)statements.push(auditStatement);
   const batches=await db.batch(statements);
   if(!Array.isArray(batches)||batches.length!==tables.length+(includesAudit?1:0))throw new Error('Invalid physical snapshot batch.');
   if(includesAudit){
    const page=batches[tables.length]?.results;
    if(!Array.isArray(page)||page.length>BUNDLE_LIMITS.pageSize)throw new Error('Invalid audit snapshot batch rows.');
    const keys=['event_id','workspace_revision','ordinal','stream_id','stream_sequence','kind','entity_type','entity_id','occurred_at','payload_json'].sort();
    const retained:Record<string,unknown>[]=[];
    for(const raw of page){
     if(!raw||typeof raw!=='object'||Array.isArray(raw)||canonical(Object.keys(raw).sort())!==canonical(keys))throw new Error('Invalid audit snapshot batch row shape.');
     // Object/closed-column validation supplies a real Record; field values
     // still pass the existing portable-audit decoder before any proof exists.
     const row:Record<string,unknown>={};for(const [key,value]of Object.entries(raw))row[key]=value;retained.push(row);
    }
    auditPage=retained;
   }
   for(const [index,table]of tables.entries()){
    const page=batches[index].results;
    if(!Array.isArray(page)||page.length>BUNDLE_LIMITS.pageSize)throw new Error('Physical snapshot batch must return bounded rows.');
    const rows=image.get(table)!,keys=['content_hash','id','payload_json','row_revision',...(streams[table]?['stream_sequence']:[])].sort();
    for(const raw of page){
     if(!raw||typeof raw!=='object'||Array.isArray(raw)||canonical(Object.keys(raw).sort())!==canonical(keys))throw new Error('Invalid physical snapshot row shape.');
     const row=raw as CapturedPhysicalRow;
     if(typeof row.id!=='string'||compareSqliteText(row.id,after.get(table)!)<=0||!Number.isSafeInteger(row.row_revision)||row.row_revision<1||typeof row.payload_json!=='string'||typeof row.content_hash!=='string'||!/^[a-f0-9]{64}$/u.test(row.content_hash)||streams[table]&&(!Number.isSafeInteger(row.stream_sequence)||row.stream_sequence!<0))throw new Error('Invalid physical snapshot row.');
     retainedBytes+=new TextEncoder().encode(row.payload_json).byteLength;if(retainedBytes>BUNDLE_LIMITS.bytes)throw new Error('Physical snapshot byte bound exceeded.');
     rows.push({...row});after.set(table,row.id);if(rows.length>BUNDLE_LIMITS.rows)throw new Error('Export row limit exceeded.');
    }
    if(page.length===BUNDLE_LIMITS.pageSize)following.push(table);
   }
  }
  pending=following;
 }
 if(auditPage===undefined)throw new Error('Missing audit snapshot batch.');
 return {physical:image,auditPage};
}

export interface ProspectiveRecoverabilityInput {
 agentTerminalReserveDelta?:number;
 now:string;planningAfter?:Workspace;writes?:GuardedWrite[];replacements?:ModuleReplacement[];
 events?:AuditEventDraft[];historyImports?:MutationPlan['historyImports'];
 operationalWrites?:Array<{table:RegisteredOwnerTable;value:JsonValue;streamSequence:number}>;
 operationalEvents?:Array<{event:AuditEventDraft;streamId:string;sequence:number}>;
 operationalWatermarksAfter?:Record<string,number>;
}
export interface ProspectiveRecoverabilityResult {agentTerminalReserveRows?:Array<{job_id:string;operational_revision:number;status:string;approval_id:string}>;measurement:RecoverabilityMeasurement;boundaryRevision:number;boundaryWatermarks:Record<string,number>;boundaryRows:Array<{table:RegisteredOwnerTable;rows:Array<{id:string;row_revision:number;content_hash:string}>}>}
/** Read-only exact serializer measurement. The writer must atomically guard the returned
 * editor/operational boundary AND its complete normalized row-set preconditions.
 * An allowed measurement does not itself authorize a write, restoration or paid action.
 */
export async function measureProspectiveRecoverability(db:SqlDatabase,owner:string,input:ProspectiveRecoverabilityInput):Promise<ProspectiveRecoverabilityResult>{
 if(!owner||!Number.isFinite(Date.parse(input.now)))throw new Error('An owner and valid measurement timestamp are required.');
 if(REFERENCE_LIMITS.rows!==BUNDLE_LIMITS.rows)throw new Error('Reference and recovery row bounds require an explicit serializer update.');
 if((input.writes?.length??0)>200||(input.events?.length??0)>2000||(input.replacements?.length??0)>OWNER_TABLES.length||(input.historyImports?.length??0)>BUNDLE_LIMITS.rows||(input.operationalWrites?.length??0)>BUNDLE_LIMITS.rows||(input.operationalEvents?.length??0)>BUNDLE_LIMITS.rows)throw new Error('Prospective operation count exceeds its bounded serializer scope.');
 const auxiliary=await readRecoverabilityAuxiliary(db,owner,input.now,{includeTerminalReserve:true}),terminalReserveRows=auxiliary.terminalReserveRows;
 if(terminalReserveRows.length>12||!Number.isSafeInteger(input.agentTerminalReserveDelta??0)||Math.abs(input.agentTerminalReserveDelta??0)>12)throw new Error('Invalid finite terminal reserve.');
 const terminalReserveCount=terminalReserveRows.length+(input.agentTerminalReserveDelta??0);if(terminalReserveCount<0||terminalReserveCount>12)throw new Error('Terminal reserve exceeds the finite batch.');
 const captured=auxiliary.current,namespaces=auxiliary.namespaces;
 const boundaryRevision=captured.revision,boundaryWatermarks=auxiliary.watermarks;
 // Every serializer below reads this one captured physical image, never a second
 // independent live export. The final read verifies the whole image before the
 // caller receives exact atomic row-set preconditions.
 const auditColumns='event_id,workspace_revision,ordinal,stream_id,stream_sequence,kind,entity_type,entity_id,occurred_at,payload_json';
 const auditStatement=(after:string)=>db.prepare(`SELECT ${auditColumns} FROM audit_events WHERE user_id=? AND event_id>? AND NOT EXISTS(SELECT 1 FROM json_each(?) frozen WHERE frozen.key=audit_events.stream_id AND audit_events.stream_sequence>frozen.value) ORDER BY event_id LIMIT ?`).bind(owner,after,canonical(boundaryWatermarks),BUNDLE_LIMITS.pageSize);
 const readAudit=(firstPage:Record<string,unknown>[])=>boundedPages<Record<string,unknown>&{id:string}>(async after=>{
  const page=after===''?firstPage:(await auditStatement(after).all<Record<string,unknown>>()).results;
  return page.map(row=>({id:row.event_id as string,...row}));
 });

 const watermarks={...(input.operationalWatermarksAfter??boundaryWatermarks)};validateOperationalWatermarks(watermarks);
 for(const [stream,sequence]of Object.entries(boundaryWatermarks))if((watermarks[stream]??-1)<sequence)throw new Error('Prospective operational watermarks cannot move backwards.');
 const capturedRows=await readPhysicalImage(db,owner,auditStatement('')),capturedPhysical=capturedRows.physical,capturedAudit=await readAudit(capturedRows.auditPage);
 const physical=new Map<RegisteredOwnerTable,Map<string,ModuleRow>>(),beforeRows=new Map<RegisteredOwnerTable,ModuleRow[]>(),sequences=new Map<string,number>();
 const finishHashCurrent=startRecoverabilityPhase(db,'hash-current');
 await verifyRecoverabilityRowHashes([...capturedPhysical.values()].flat());
 for(const table of OWNER_TABLES){
  const rawRows=capturedPhysical.get(table)!,rows:ModuleRow[]=rawRows.map(({id,row_revision,payload_json,content_hash})=>({id,row_revision,payload_json,content_hash}));
  beforeRows.set(table,rows);physical.set(table,new Map(rows.map(row=>[row.id,{...row}])));
  const stream=streams[table];if(stream){const indexed=rawRows.map(row=>({id:row.id,stream_sequence:row.stream_sequence!}));if(indexed.some(row=>row.stream_sequence>(boundaryWatermarks[stream]??0)))throw new Error('Operational physical snapshot changed or exceeds boundary.');for(const row of indexed)sequences.set(`${table}:${row.id}`,row.stream_sequence);}
 }
 const virtual:OwnerScopedReader={async get(table,id){return physical.get(ownerTable(table))!.get(id)??null;},async list(table,options={}){const key=ownerTable(table),limit=options.limit??100;if(!Number.isSafeInteger(limit)||limit<1||limit>BUNDLE_LIMITS.pageSize)throw new Error('Invalid virtual page bound.');const stream=streams[key];return [...physical.get(key)!.values()].filter(row=>compareSqliteText(row.id,options.after??'')>0&&(!stream||(sequences.get(`${key}:${row.id}`)??0)<=(watermarks[stream]??0))).sort((a,b)=>compareSqliteText(a.id,b.id)).slice(0,limit);}};
 // Omit operationalWatermarks intentionally: the virtual owner reader already filters
 // stream rows. Adapter serializers therefore never need an SQL imitation.
 const blockedDb:SqlDatabase={prepare(){throw new Error('Prospective serializer unexpectedly requested SQL.');},async batch(){throw new Error('Prospective measurement cannot write.');}};
 const serializeModules=async()=>{const modules:WorkspaceBundle['modules']={};for(const adapter of exportRegistry.entries()){if(adapter.key==='audit_events')continue;modules[adapter.key]={schemaVersion:adapter.schemaVersion,records:await adapter.exportRows({userId:owner,sourceRevision:boundaryRevision,query:virtual,db:blockedDb})};}return modules;};
 for(const table of OWNER_TABLES)if(beforeRows.get(table)!.length&&!exportRegistry.entries().some(adapter=>moduleTables(adapter).includes(table)))throw new Error('Current populated module has no export adapter.');
 finishHashCurrent();
 const finishOriginalSerializer=startRecoverabilityPhase(db,'originalserializer');
 const baseline=await serializeModules();
 baseline.audit_events={schemaVersion:exportRegistry.get('audit_events').schemaVersion,records:capturedAudit.map(({id:_,...row})=>{void _;return serializePortableAuditRow(row as Record<string,unknown>&{event_id:string;payload_json:string});})};
 finishOriginalSerializer();
 const finishBundleOriginal=startRecoverabilityPhase(db,'bundleoriginal');
 const original=await buildWorkspaceBundle({planning:captured.workspace,modules:baseline,workspaceRevision:boundaryRevision,operationalWatermarks:boundaryWatermarks,...(namespaces?{auditNamespace:namespaces.auditNamespace}:{}),exportedAt:input.now});
 finishBundleOriginal();
 const finishProjectPlan=startRecoverabilityPhase(db,'projectplan');
 const replaced=new Set<RegisteredOwnerTable>(),changed=new Set<string>();
 for(const replacement of input.replacements??[]){const table=ownerTable(replacement.table);if(replaced.has(table))throw new Error('Duplicate replacement scope.');replaced.add(table);
  const actual=beforeRows.get(table)!;if(canonical(replacement.beforeRows)!==canonical(actual))throw new Error('Replacement before rows differ from current owner snapshot.');
  if(new Set(replacement.records.map(row=>row.id)).size!==replacement.records.length)throw new Error('Duplicate physical replacement identity.');
  const index=new Map(actual.map(row=>[row.id,row.row_revision])),after=new Map<string,ModuleRow>();
  for(const row of replacement.records){await moduleProjection(table,row.id,row.value);after.set(row.id,{id:row.id,row_revision:(index.get(row.id)??0)+1,payload_json:canonical(row.value),content_hash:await contentHash(canonical(row.value))});sequences.set(`${table}:${row.id}`,0);}
  physical.set(table,after);
 }
 for(const write of input.writes??[]){const table=ownerTable(write.table),key=`${table}:${write.id}`;if(replaced.has(table)||changed.has(key))throw new Error('Overlapping prospective row operations.');changed.add(key);const rows=physical.get(table)!,before=rows.get(write.id);
  if(write.operation==='insert'?before!==undefined||write.expectedRowRevision!==null:!before||before.row_revision!==write.expectedRowRevision)throw new Error('Prospective row precondition differs.');
  if(write.operation==='delete'){rows.delete(write.id);continue;}
  if(write.operation!=='insert'&&write.operation!=='update'||write.value===undefined)throw new Error('Invalid prospective row operation.');await moduleProjection(table,write.id,write.value);
  rows.set(write.id,{id:write.id,row_revision:(before?.row_revision??0)+1,payload_json:canonical(write.value),content_hash:await contentHash(canonical(write.value))});if(!before)sequences.set(key,0);
 }
 for(const write of input.operationalWrites??[]){const table=ownerTable(write.table),stream=streams[table]??(table==='source_proposals'?'sources':undefined),id=(write.value as {id?:unknown})?.id;if(!stream||typeof id!=='string'||!Number.isSafeInteger(write.streamSequence)||write.streamSequence<1||write.streamSequence<=(boundaryWatermarks[stream]??0)||write.streamSequence>(watermarks[stream]??0))throw new Error('Operational insert is outside its prospective watermark.');const key=`${table}:${id}`;if(replaced.has(table)||changed.has(key)||physical.get(table)!.has(id))throw new Error('Duplicate operational physical identity.');changed.add(key);await moduleProjection(table,id,write.value);physical.get(table)!.set(id,{id,row_revision:1,payload_json:canonical(write.value),content_hash:await contentHash(canonical(write.value))});sequences.set(key,write.streamSequence);}
 for(const table of OWNER_TABLES)if(physical.get(table)!.size&&!exportRegistry.entries().some(adapter=>moduleTables(adapter).includes(table)))throw new Error('Prospective populated module has no export adapter.');
 finishProjectPlan();
 const finishAfterSerializer=startRecoverabilityPhase(db,'afterserializer');
 const modules=await serializeModules();
 finishAfterSerializer();
 const finishBundleAfter=startRecoverabilityPhase(db,'bundleafter');
 const planning=input.planningAfter===undefined?original.planning:parseWorkspaceExport(input.planningAfter,input.now);
 const editorMutation=input.planningAfter!==undefined||!!input.writes?.length||!!input.replacements?.length||!!input.events?.length||!!input.historyImports?.length;
 const prospectiveRevision=boundaryRevision+(editorMutation?1:0),audit=new Map((original.modules.audit_events?.records??[]).map(raw=>[(raw as {id:string}).id,raw]));
 function eventRow(event:AuditEventDraft,revision:number|null,ordinal:number|null,stream:string|null,sequence:number|null){canonicalJsonValue(event);return serializePortableAuditRow({event_id:event.id,workspace_revision:revision,ordinal,stream_id:stream,stream_sequence:sequence,kind:event.kind,entity_type:event.entityType,entity_id:event.entityId,occurred_at:input.now,payload_json:canonical(event)});}
 for(const [ordinal,event]of (input.events??[]).entries()){if(audit.has(event.id))throw new Error('Duplicate prospective owner event.');audit.set(event.id,eventRow(event,prospectiveRevision,ordinal,null,null));}
 const compiledHistory=[];
 for(const [index,entry]of (input.historyImports??[]).entries()){
  const event:AuditEventDraft={id:entry.id,kind:'imported-history',entityType:'historical-claim',entityId:null,changes:[{path:['sourceClaim'],before:{exists:false,value:null},after:{exists:true,value:entry.source}}],origin:'owner',actorId:owner,occurredAt:input.now,sourceRef:entry.importHash,undoOf:null};
  const ordinal=(input.events?.length??0)+index;compiledHistory.push({id:entry.id,ordinal,payload:canonical(event)});
  if(!audit.has(entry.id))audit.set(entry.id,eventRow(event,prospectiveRevision,ordinal,null,null)); // Actual compiler uses ON CONFLICT DO NOTHING.
 }
 for(const {event,streamId,sequence}of input.operationalEvents??[]){if(!/^[a-z][a-z0-9_-]{0,63}$/.test(streamId)||!Number.isSafeInteger(sequence)||sequence<1||sequence<=(boundaryWatermarks[streamId]??0)||sequence>(watermarks[streamId]??0)||audit.has(event.id))throw new Error('Operational audit is outside its prospective watermark.');audit.set(event.id,eventRow(event,null,null,streamId,sequence));}
 modules.audit_events={schemaVersion:exportRegistry.get('audit_events').schemaVersion,records:[...audit.values()].sort((a,b)=>compareSqliteText((a as {id:string}).id,(b as {id:string}).id))};
 const bundle=await buildWorkspaceBundle({planning,modules,workspaceRevision:prospectiveRevision,operationalWatermarks:watermarks,...(original.source.auditNamespace?{auditNamespace:original.source.auditNamespace}:{}),exportedAt:input.now},{enforceByteLimit:false});
 finishBundleAfter();
 const finishExpandFuture=startRecoverabilityPhase(db,'expandfuture');
 const tables:RecoverabilityTableInput[]=[],expandedRecords:string[]=[],futureTableArguments:Array<{name:string;serialized:string}>=[];
 for(const table of OWNER_TABLES){const before=beforeRows.get(table)!,after=[...physical.get(table)!.values()].sort((a,b)=>compareSqliteText(a.id,b.id)),expanded=[];
  for(const row of after){const value=JSON.parse(row.payload_json) as JsonValue;expandedRecords.push(JSON.stringify({id:row.id,value}));expanded.push({...row,...await moduleProjection(table,row.id,value)});}
  tables.push({table,beforeRowsJson:canonical(before.map(({id,row_revision,content_hash})=>({id,row_revision,content_hash}))),expandedAfterPayloadJson:canonical(expanded),beforeRowCount:before.length,afterRowCount:after.length});
  const futureExpanded=expanded.map(row=>{if(!Number.isSafeInteger(row.row_revision+1))throw new Error('Future restore row revision exceeds supported capacity.');return {...row,row_revision:row.row_revision+1};});
  futureTableArguments.push({name:`future-restore:${table}:before`,serialized:canonical(after.map(({id,row_revision,content_hash})=>({id,row_revision,content_hash})))},{name:`future-restore:${table}:after`,serialized:canonical(futureExpanded)});
 }
 const futureHistory=await prepareHistoricalAuditRows(modules.audit_events.records,bundle.source.auditNamespace??null,await contentHash(JSON.stringify(bundle)));
 const futureCompiled=futureHistory.map((entry,index)=>({id:entry.id,ordinal:index+1,payload:canonical({id:entry.id,kind:'imported-history',entityType:'historical-claim',entityId:null,changes:[{path:['sourceClaim'],before:{exists:false,value:null},after:{exists:true,value:entry.source}}],origin:'owner',actorId:owner,occurredAt:input.now,sourceRef:entry.importHash,undoOf:null})}));
 finishExpandFuture();
 const finishMeasure=startRecoverabilityPhase(db,'measure');
 const measurement=measureRecoverability({serializedBundle:JSON.stringify(bundle),serializedExpandedImport:expandedRecords.join(''),tables,sqlArguments:[...futureTableArguments,{name:'future-restore:history-input',serialized:JSON.stringify(modules.audit_events.records)},{name:'future-restore:history-prepared',serialized:JSON.stringify(futureHistory)},{name:'future-restore:history-compiled',serialized:canonical(futureCompiled)}],...(input.historyImports?{historicalAudit:{preparedJson:canonical(input.historyImports),compiledWrappedJson:canonical(compiledHistory),rowCount:input.historyImports.length}}:{}),counts:[{name:'normalized-owner-reference-rows',rows:OWNER_TABLES.reduce((total,table)=>total+physical.get(table)!.size,0)},...Object.entries(modules).map(([name,module])=>({name:`module:${name}`,rows:module.records.length})),{name:'future-restore:history-prepared',rows:futureHistory.length}]});
 // Keep bounded terminal metadata recoverable before a process is admitted. This
 // conservative reserve is separate from the exact current serializer measurement.
 // Result schema <=16KiB plus immutable row/audit and escaped restore envelopes <=64KiB.
 const reserveBytes=terminalReserveCount*65536;
 const serializedMaximum=Math.max(measurement.measurements.d1BackupBytes??Infinity,...measurement.measurements.sqlArguments.map(item=>item.bytes??Infinity));
 if(serializedMaximum+reserveBytes>1_800_000)measurement.reasons.push({code:'d1_backup_bytes',scope:'agent-terminal-headroom',actual:serializedMaximum+reserveBytes,limit:1_800_000});
 if((modules.agent_results?.records.length??0)+terminalReserveCount>500)measurement.reasons.push({code:'row_limit',scope:'agent-terminal-history-headroom',actual:(modules.agent_results?.records.length??0)+terminalReserveCount,limit:500});
 measurement.allowed=measurement.reasons.length===0;
 finishMeasure();
 const finishFinalReads=startRecoverabilityPhase(db,'finalreads');
 const latestAuxiliary=await readRecoverabilityAuxiliary(db,owner,input.now,{includeNamespaces:false}),current=latestAuxiliary.current;
 if(current.revision!==boundaryRevision||canonical(current.workspace)!==canonical(original.planning)||canonical(latestAuxiliary.watermarks)!==canonical(boundaryWatermarks))throw new Error('Workspace boundary changed during recoverability measurement.');
 // Re-read all physical sets: the returned revision/vector alone does not detect an
 // unguarded same-revision mutation, and must never certify a stale normalized set.
 const latestRows=await readPhysicalImage(db,owner,auditStatement('')),latestPhysical=latestRows.physical;
 for(const table of OWNER_TABLES)if(canonical(latestPhysical.get(table))!==canonical(capturedPhysical.get(table)))throw new Error('Normalized row set changed (including operational sequence) during recoverability measurement.');
 if(canonical(await readAudit(latestRows.auditPage))!==canonical(capturedAudit))throw new Error('Audit row set changed during recoverability measurement.');
 if((await getWorkspaceNamespaces(db,owner))?.auditNamespace!==namespaces?.auditNamespace)throw new Error('Audit namespace changed during recoverability measurement.');
 finishFinalReads();
 return {agentTerminalReserveRows:terminalReserveRows,measurement,boundaryRevision,boundaryWatermarks:{...boundaryWatermarks},boundaryRows:OWNER_TABLES.map(table=>({table,rows:beforeRows.get(table)!.map(({id,row_revision,content_hash})=>({id,row_revision,content_hash}))}))};
}
