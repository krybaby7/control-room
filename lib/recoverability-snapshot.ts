import {REFERENCE_LIMITS} from './workspace-references.ts';
import {prepareHistoricalAuditRows} from './audit-import.ts';
import type {Workspace} from './types.ts';
import type {SqlDatabase} from './workspace-store.ts';
import {readCurrent} from './workspace-store.ts';
import {OWNER_TABLES,ownerReader,ownerTable,type GuardedWrite,type ModuleRow,type OwnerScopedReader,type RegisteredOwnerTable} from './workspace-modules.ts';
import type {AuditEventDraft,JsonValue} from './workspace-protocol.ts';
import type {ModuleReplacement,MutationPlan} from './workspace-transaction.ts';
import {moduleProjection} from './module-columns.ts';
import {BUNDLE_LIMITS,boundedPages} from './workspace-export-core.ts';
import {buildWorkspaceBundle,exportRegistry,exportWorkspaceBundle,moduleTables,serializePortableAuditRow,type WorkspaceBundle} from './workspace-export.ts';
import {canonical,contentHash} from './canonical-json.ts';
import {measureRecoverability,type RecoverabilityMeasurement,type RecoverabilityTableInput} from './recoverability-measure.ts';
import {readOperationalWatermarks,validateOperationalWatermarks} from './operational-watermarks.ts';
import {canonicalJsonValue} from './audit-events.ts';
import {parseWorkspaceExport} from './workspace-validation.ts';
const streams:Partial<Record<RegisteredOwnerTable,string>>={source_observations:'sources',source_sync_runs:'sources',integration_history:'sources',review_snapshots:'reviews',review_analysis_runs:'reviews',notification_events:'notifications',automation_occurrences:'automations'};
export interface ProspectiveRecoverabilityInput {
 now:string;planningAfter?:Workspace;writes?:GuardedWrite[];replacements?:ModuleReplacement[];
 events?:AuditEventDraft[];historyImports?:MutationPlan['historyImports'];
 operationalWrites?:Array<{table:RegisteredOwnerTable;value:JsonValue;streamSequence:number}>;
 operationalEvents?:Array<{event:AuditEventDraft;streamId:string;sequence:number}>;
 operationalWatermarksAfter?:Record<string,number>;
}
export interface ProspectiveRecoverabilityResult {measurement:RecoverabilityMeasurement;boundaryRevision:number;boundaryWatermarks:Record<string,number>;boundaryRows:Array<{table:RegisteredOwnerTable;rows:Array<{id:string;row_revision:number;content_hash:string}>}>}
/** Read-only exact serializer measurement. The writer must atomically guard the returned
 * editor/operational boundary AND its complete normalized row-set preconditions.
 * An allowed measurement does not itself authorize a write, restoration or paid action.
 */
export async function measureProspectiveRecoverability(db:SqlDatabase,owner:string,input:ProspectiveRecoverabilityInput):Promise<ProspectiveRecoverabilityResult>{
 if(!owner||!Number.isFinite(Date.parse(input.now)))throw new Error('An owner and valid measurement timestamp are required.');
 if(REFERENCE_LIMITS.rows!==BUNDLE_LIMITS.rows)throw new Error('Reference and recovery row bounds require an explicit serializer update.');
 if((input.writes?.length??0)>200||(input.events?.length??0)>2000||(input.replacements?.length??0)>OWNER_TABLES.length||(input.historyImports?.length??0)>BUNDLE_LIMITS.rows||(input.operationalWrites?.length??0)>BUNDLE_LIMITS.rows||(input.operationalEvents?.length??0)>BUNDLE_LIMITS.rows)throw new Error('Prospective operation count exceeds its bounded serializer scope.');
 const original=await exportWorkspaceBundle(db,owner,{now:()=>input.now});
 const boundaryRevision=original.source.workspaceRevision,boundaryWatermarks=original.source.operationalWatermarks??{};
 const watermarks={...(input.operationalWatermarksAfter??boundaryWatermarks)};validateOperationalWatermarks(watermarks);
 for(const [stream,sequence]of Object.entries(boundaryWatermarks))if((watermarks[stream]??-1)<sequence)throw new Error('Prospective operational watermarks cannot move backwards.');
 const reader=ownerReader(db,owner),physical=new Map<RegisteredOwnerTable,Map<string,ModuleRow>>(),beforeRows=new Map<RegisteredOwnerTable,ModuleRow[]>(),sequences=new Map<string,number>();
 let retainedBytes=0;
 for(const table of OWNER_TABLES){
  const rows=await boundedPages(after=>reader.list(table,{after,limit:BUNDLE_LIMITS.pageSize}));
  for(const row of rows){retainedBytes+=new TextEncoder().encode(row.payload_json).length;if(retainedBytes>BUNDLE_LIMITS.bytes)throw new Error('Physical snapshot byte bound exceeded.');if(await contentHash(canonical(JSON.parse(row.payload_json)))!==row.content_hash)throw new Error('Current normalized content hash differs.');}
  beforeRows.set(table,rows);physical.set(table,new Map(rows.map(row=>[row.id,{...row}])));
  const stream=streams[table];if(stream){const indexed=await boundedPages(async after=>(await db.prepare(`SELECT id,stream_sequence FROM ${table} WHERE user_id=? AND id>? ORDER BY id LIMIT ?`).bind(owner,after,BUNDLE_LIMITS.pageSize).all<{id:string;stream_sequence:number}>()).results);if(indexed.length!==rows.length||indexed.some((row,i)=>row.id!==rows[i].id||!Number.isSafeInteger(row.stream_sequence)||row.stream_sequence<0||row.stream_sequence>(boundaryWatermarks[stream]??0)))throw new Error('Operational physical snapshot changed or exceeds boundary.');for(const row of indexed)sequences.set(`${table}:${row.id}`,row.stream_sequence);}
 }
 const virtual:OwnerScopedReader={async get(table,id){return physical.get(ownerTable(table))!.get(id)??null;},async list(table,options={}){const key=ownerTable(table),limit=options.limit??100;if(!Number.isSafeInteger(limit)||limit<1||limit>BUNDLE_LIMITS.pageSize)throw new Error('Invalid virtual page bound.');const stream=streams[key];return [...physical.get(key)!.values()].filter(row=>row.id>(options.after??'')&&(!stream||(sequences.get(`${key}:${row.id}`)??0)<=(watermarks[stream]??0))).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0).slice(0,limit);}};
 // Omit operationalWatermarks intentionally: the virtual owner reader already filters
 // stream rows. Adapter serializers therefore never need an SQL imitation.
 const blockedDb:SqlDatabase={prepare(){throw new Error('Prospective serializer unexpectedly requested SQL.');},async batch(){throw new Error('Prospective measurement cannot write.');}};
 const serializeModules=async()=>{const modules:WorkspaceBundle['modules']={};for(const adapter of exportRegistry.entries()){if(adapter.key==='audit_events')continue;modules[adapter.key]={schemaVersion:adapter.schemaVersion,records:await adapter.exportRows({userId:owner,sourceRevision:boundaryRevision,query:virtual,db:blockedDb})};}return modules;};
 const baseline=await serializeModules();
 for(const [key,module]of Object.entries(baseline))if(canonical(module)!==canonical(original.modules[key]))throw new Error('Normalized snapshot changed during measurement.');
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
 const modules=await serializeModules(),planning=input.planningAfter===undefined?original.planning:parseWorkspaceExport(input.planningAfter,input.now);
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
 modules.audit_events={schemaVersion:exportRegistry.get('audit_events').schemaVersion,records:[...audit.values()].sort((a,b)=>(a as {id:string}).id<(b as {id:string}).id?-1:1)};
 const bundle=await buildWorkspaceBundle({planning,modules,workspaceRevision:prospectiveRevision,operationalWatermarks:watermarks,...(original.source.auditNamespace?{auditNamespace:original.source.auditNamespace}:{}),exportedAt:input.now},{enforceByteLimit:false});
 const tables:RecoverabilityTableInput[]=[],expandedRecords:string[]=[],futureTableArguments:Array<{name:string;serialized:string}>=[];
 for(const table of OWNER_TABLES){const before=beforeRows.get(table)!,after=[...physical.get(table)!.values()].sort((a,b)=>a.id<b.id?-1:1),expanded=[];
  for(const row of after){const value=JSON.parse(row.payload_json) as JsonValue;expandedRecords.push(JSON.stringify({id:row.id,value}));expanded.push({...row,...await moduleProjection(table,row.id,value)});}
  tables.push({table,beforeRowsJson:canonical(before.map(({id,row_revision,content_hash})=>({id,row_revision,content_hash}))),expandedAfterPayloadJson:canonical(expanded),beforeRowCount:before.length,afterRowCount:after.length});
  const futureExpanded=expanded.map(row=>{if(!Number.isSafeInteger(row.row_revision+1))throw new Error('Future restore row revision exceeds supported capacity.');return {...row,row_revision:row.row_revision+1};});
  futureTableArguments.push({name:`future-restore:${table}:before`,serialized:canonical(after.map(({id,row_revision,content_hash})=>({id,row_revision,content_hash})))},{name:`future-restore:${table}:after`,serialized:canonical(futureExpanded)});
 }
 const futureHistory=await prepareHistoricalAuditRows(modules.audit_events.records,bundle.source.auditNamespace??null,await contentHash(JSON.stringify(bundle)));
 const futureCompiled=futureHistory.map((entry,index)=>({id:entry.id,ordinal:index+1,payload:canonical({id:entry.id,kind:'imported-history',entityType:'historical-claim',entityId:null,changes:[{path:['sourceClaim'],before:{exists:false,value:null},after:{exists:true,value:entry.source}}],origin:'owner',actorId:owner,occurredAt:input.now,sourceRef:entry.importHash,undoOf:null})}));
 const measurement=measureRecoverability({serializedBundle:JSON.stringify(bundle),serializedExpandedImport:expandedRecords.join(''),tables,sqlArguments:[...futureTableArguments,{name:'future-restore:history-input',serialized:JSON.stringify(modules.audit_events.records)},{name:'future-restore:history-prepared',serialized:JSON.stringify(futureHistory)},{name:'future-restore:history-compiled',serialized:canonical(futureCompiled)}],...(input.historyImports?{historicalAudit:{preparedJson:canonical(input.historyImports),compiledWrappedJson:canonical(compiledHistory),rowCount:input.historyImports.length}}:{}),counts:[{name:'normalized-owner-reference-rows',rows:OWNER_TABLES.reduce((total,table)=>total+physical.get(table)!.size,0)},...Object.entries(modules).map(([name,module])=>({name:`module:${name}`,rows:module.records.length})),{name:'future-restore:history-prepared',rows:futureHistory.length}]});
 const current=await readCurrent(db,owner,input.now);
 if(current.revision!==boundaryRevision||canonical(current.workspace)!==canonical(original.planning)||canonical(await readOperationalWatermarks(db,owner))!==canonical(boundaryWatermarks))throw new Error('Workspace boundary changed during recoverability measurement.');
 // Re-read all physical sets: the returned revision/vector alone does not detect an
 // unguarded same-revision mutation, and must never certify a stale normalized set.
 for(const table of OWNER_TABLES){const latest=await boundedPages(after=>reader.list(table,{after,limit:BUNDLE_LIMITS.pageSize}));if(canonical(latest)!==canonical(beforeRows.get(table)))throw new Error('Normalized row set changed during recoverability measurement.');}
 return {measurement,boundaryRevision,boundaryWatermarks:{...boundaryWatermarks},boundaryRows:OWNER_TABLES.map(table=>({table,rows:beforeRows.get(table)!.map(({id,row_revision,content_hash})=>({id,row_revision,content_hash}))}))};
}
