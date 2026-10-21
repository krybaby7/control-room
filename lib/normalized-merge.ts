import {validatePersonalState} from '../shared/personal-repository.mjs';
import {z} from 'zod';
import type {Workspace} from './types.ts';
import type {JsonValue} from './workspace-protocol.ts';
import {OWNER_TABLES,type OwnerScopedReader,type ModuleRow,type GuardedWrite,type RegisteredOwnerTable} from './workspace-modules.ts';
import {exportRegistry,moduleTables,type ExportRegistry,type WorkspaceBundle,type PhysicalImportRows} from './workspace-export.ts';
import {BUNDLE_LIMITS,assertPortable} from './workspace-export-core.ts';
import {canonical,contentHash} from './canonical-json.ts';
import type {ReferenceSnapshot} from './workspace-references.ts';
import type {SqlDatabase} from './workspace-store.ts';
import {attachmentRecordSchema,attachmentUsageSchema} from './evidence-module.ts';
import type {AttachmentRecord} from './evidence-contract.ts';
import type {VerifiedAttachment} from './evidence-requirements.ts';
const wrapper=z.object({id:z.string().min(1).max(128),rowRevision:z.number().int().positive().safe(),contentHash:z.string().regex(/^[a-f0-9]{64}$/),value:z.unknown()}).strict();
const closedKeys=new Set(['weekly_plans','weekly_reviews','recurrence_rules','recurrence_occurrences','evidence','decisions','evidence_links','evidence_requirements','acceptance_records','attachments','attachment_usage','source_connections','source_targets','source_observations','source_sync_runs','source_proposals','integration_history','review_snapshots','review_acknowledgements','automation_schedules','automation_occurrences','notification_events','review_settings','review_analysis_runs','project_baseline_revisions','devices','runtime_adapter_configurations','runtime_evidence','agent_jobs','agent_results','evaluation_runs','personal_repository_state']);
export interface NormalizedMergeRow {module:string;table:RegisteredOwnerTable;id:string;beforeHash:string|null;afterHash:string;disposition:'insert'|'deduplicate'|'derived-quota'}
export interface NormalizedMergeConflict {module:string;id:string;reason:'different-body'|'physical-identity';currentHash:string;incomingHash:string}
export interface NormalizedMergeReview {version:1;importHash:string;targetRevision:number;beforeDigest:string;rows:NormalizedMergeRow[];conflicts:NormalizedMergeConflict[];warnings:string[];reviewHash:string}
export interface NormalizedMergeProof {id:string;storageKey:string;bytes:number;sha256:string}
export interface NormalizedMergeControl {importHash:string;reviewHash:string;rows:NormalizedMergeRow[];verifiedAttachments:NormalizedMergeProof[]}
export interface NormalizedMergeInput {query:OwnerScopedReader;userId:string;workspaceRevision:number;planningAfter:Workspace;bundle:WorkspaceBundle;importHash:string;importedAt:string;verificationMs?:number;verifyAttachment?:(record:AttachmentRecord)=>Promise<VerifiedAttachment|null>}
export interface NormalizedMergePrepared {writes:GuardedWrite[];referenceSnapshot:ReferenceSnapshot;review:NormalizedMergeReview;historyClaims:Array<{module:string;id:string;sourceHash:string;storedHash:string;sourceValue:JsonValue}>;verifiedAttachments:NormalizedMergeProof[]}
const sort=<T extends {id:string}>(rows:T[])=>rows.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
function reader(physical:Map<RegisteredOwnerTable,ModuleRow[]>):OwnerScopedReader{return {async get(table,id){return physical.get(table)?.find(row=>row.id===id)??null;},async list(table,options={}){const limit=options.limit??100;if(!Number.isSafeInteger(limit)||limit<1||limit>BUNDLE_LIMITS.pageSize)throw new Error('Invalid merge page bound.');return (physical.get(table)??[]).filter(row=>row.id>(options.after??'')).slice(0,limit);}};}
const noSql:SqlDatabase={prepare(){throw new Error('Merge serializers must use their frozen owner reader.');},async batch(){throw new Error('Merge preview is read-only.');}};
async function portable(registry:ExportRegistry,query:OwnerScopedReader,userId:string,revision:number):Promise<WorkspaceBundle['modules']>{
 const modules:WorkspaceBundle['modules']={};
 for(const adapter of registry.entries())if(adapter.policy!=='append-only')modules[adapter.key]={schemaVersion:adapter.schemaVersion,records:await adapter.exportRows({query,db:noSql,userId,sourceRevision:revision})};
 return modules;
}
function physicalIdentity(key:string,tables:RegisteredOwnerTable[],row:z.infer<typeof wrapper>):{table:RegisteredOwnerTable;id:string}{
 if(tables.length===1)return {table:tables[0],id:row.id};
 if(key!=='evidence'&&key!=='decisions')throw new Error('This composite module needs an explicit merge contract.');
 const value=z.object({kind:z.enum(['head','version','mapping','legacy']),physicalId:z.string().min(1).max(128),record:z.unknown()}).strict().parse(row.value);
 const map=key==='evidence'?{head:'evidence_records',version:'evidence_versions',mapping:'evidence_mappings',legacy:'evidence_records'}:{head:'decision_records',version:'decision_versions',mapping:'decisions',legacy:'decisions'};
 const table=map[value.kind] as RegisteredOwnerTable;if(!tables.includes(table))throw new Error('Composite merge physical identity differs.');return {table,id:value.physicalId};
}
async function inert(table:RegisteredOwnerTable,id:string,value:JsonValue,input:NormalizedMergeInput,proofs:NormalizedMergeProof[],warnings:Set<string>,proofDeadline:number):Promise<JsonValue>{
 const row=value as {[key:string]:JsonValue};let result=value;
 if(table==='weekly_plans'){result={...row,taskIds:[],capacityMinutes:null};warnings.add('Imported weekly plans retain their identity but create no commitments or capacity settings; original source bodies remain in import history.');}
 else if(table==='recurrence_rules'||table==='source_connections'||table==='automation_schedules')result={...row,enabled:false};
 else if(table==='evidence_requirements')result={...row,archivedAt:row.archivedAt??input.importedAt};
 else if(table==='devices')result={...row,archivedAt:row.archivedAt??input.importedAt};
 else if(table==='source_observations')warnings.add('Imported source timestamps and origin remain historical provenance only. Disabled connections and absent private grants or cursors do not establish current freshness.');
 else if(table==='source_proposals')result={...row,state:'pending',decision:null};
 else if(table==='runtime_adapter_configurations')result={...row,manifest:{...(row.manifest as {[key:string]:JsonValue}),enabled:false}};
 else if(table==='personal_repository_state'){const state=validatePersonalState(value);state.connected=false;for(const request of state.requests)if(['queued','claimed'].includes(request.status)){request.status='failed';request.error='interrupted';}result=state as unknown as JsonValue;}
 else if(table==='runtime_evidence')result={...row,origin:'historical-import'};
 else if(table==='agent_jobs')result={...row,historical:true};
 else if(table==='agent_results')result={...row,historical:true,frozenJob:{...(row.frozenJob as {[key:string]:JsonValue}),historical:true}};
 else if(table==='review_settings'&&id==='analysis')result={...row,enabled:false};
 else if(table==='review_settings'&&id==='notifications')result={...row,mutedKinds:[],mutedSourceIds:[],quietHours:{...(row.quietHours as {[key:string]:JsonValue}),enabled:false},externalDelivery:'disabled'};
 else if(table==='attachments'){
  const file=attachmentRecordSchema.parse(value);
  if(file.status!=='deleted'){
   let proof:VerifiedAttachment|null=null;
   if(file.status==='ready'&&input.verifyAttachment&&Date.now()<proofDeadline){
    let timer:ReturnType<typeof setTimeout>|undefined;try{proof=await Promise.race([input.verifyAttachment(file),new Promise<null>(resolve=>{timer=setTimeout(()=>resolve(null),Math.max(1,proofDeadline-Date.now()));})]);}catch{/* Missing/corrupt physical bytes are not a ready-file proof. */}finally{if(timer!==undefined)clearTimeout(timer);}
   }
   if(proof&&proof.signatureVerified&&proof.verifiedBytes===file.expectedBytes&&proof.verifiedSha256===file.sha256&&canonical(proof.record)===canonical(file)){
    proofs.push({id,storageKey:file.storageKey,bytes:file.expectedBytes,sha256:file.sha256!});
   }else{
    result={...file,status:'quarantined',readyAt:null,quarantineReason:'Imported metadata only; private file bytes require explicit verified recovery.'};
    warnings.add('New attachment metadata without an actual private byte proof is quarantined. No upload, readable file or cleanup authority is created.');
   }
  }
 }
 if(canonical(result)!==canonical(value))warnings.add('New authority-bearing records are imported disabled, archived, historical or pending. Existing owner records are retained unchanged.');
 return result;
}
/** Explicit all-disjoint-record merge proposal. The returned quote grants no write
 * authority; the shared compiler must bind its entire row set, hashes and private
 * verified-file proof under the reviewed owner mutation/backup/epoch boundary. */
export async function prepareNormalizedMerge(input:NormalizedMergeInput,registry:ExportRegistry=exportRegistry):Promise<NormalizedMergePrepared>{
 if(input.verificationMs!==undefined&&(!Number.isSafeInteger(input.verificationMs)||input.verificationMs<1||input.verificationMs>15000))throw new Error('Invalid private verification deadline.');
 if(!input.userId||!Number.isSafeInteger(input.workspaceRevision)||input.workspaceRevision<1||!/^[a-f0-9]{64}$/.test(input.importHash)||!Number.isFinite(Date.parse(input.importedAt)))throw new Error('Invalid reviewed merge boundary.');
 const physical=new Map<RegisteredOwnerTable,ModuleRow[]>(),coverage=new Map<RegisteredOwnerTable,string>();let total=0,bytes=0;
 for(const adapter of registry.entries())for(const table of moduleTables(adapter)){if(coverage.has(table))throw new Error('Overlapping merge module coverage.');coverage.set(table,adapter.key);}
 for(const table of OWNER_TABLES){const rows:ModuleRow[]=[];let after='';for(;;){const page=await input.query.list(table,{after,limit:BUNDLE_LIMITS.pageSize});if(page.length>BUNDLE_LIMITS.pageSize)throw new Error('Invalid merge snapshot page.');for(const row of page){if(row.id<=after||!Number.isSafeInteger(row.row_revision)||row.row_revision<1||await contentHash(canonical(JSON.parse(row.payload_json)))!==row.content_hash)throw new Error('Current merge snapshot identity or digest differs.');after=row.id;rows.push({...row});total++;bytes+=new TextEncoder().encode(row.payload_json).byteLength;if(total>BUNDLE_LIMITS.rows||bytes>BUNDLE_LIMITS.bytes)throw new Error('Merge snapshot exceeds bounded capacity.');}if(page.length<BUNDLE_LIMITS.pageSize)break;}if(rows.length&&!coverage.has(table))throw new Error('Populated owner data has no merge adapter.');physical.set(table,rows);}
 const snapshot:ReferenceSnapshot={coveredModules:[...OWNER_TABLES],rows:OWNER_TABLES.flatMap(table=>physical.get(table)!.map(row=>({module:table,id:row.id,rowRevision:row.row_revision,contentHash:row.content_hash,references:[]}))),digest:''};
 snapshot.digest=await contentHash(canonical({coveredModules:snapshot.coveredModules,rows:snapshot.rows}));
 const retainedRuleIds=new Set(physical.get('recurrence_rules')!.map(row=>row.id));
 const originalModules=await portable(registry,reader(physical),input.userId,input.workspaceRevision),reviewRows:NormalizedMergeRow[]=[],conflicts:NormalizedMergeConflict[]=[],historyClaims:NormalizedMergePrepared['historyClaims']=[],proofs:NormalizedMergeProof[]=[],warnings=new Set<string>(),writes:GuardedWrite[]=[];
 const pending:Array<{key:string;rows:z.infer<typeof wrapper>[];tables:RegisteredOwnerTable[];deduplicated:Set<string>}>=[];
 for(const [key,source]of Object.entries(input.bundle.modules)){
  const adapter=registry.get(key);if(adapter.policy==='append-only'){if(key!=='audit_events')throw new Error('Unsupported append-only merge.');continue;}
  if(!closedKeys.has(key)||!moduleTables(adapter).length)throw new Error('Module has no explicit inert merge contract.');
  const migrated=adapter.parseAndMigrate(source),rows=migrated.map(raw=>wrapper.parse(raw));if(rows.length>BUNDLE_LIMITS.rows||new Set(rows.map(row=>row.id)).size!==rows.length)throw new Error('Invalid normalized merge identities.');
  const current=new Map((originalModules[key]?.records??[]).map(raw=>{const row=wrapper.parse(raw);return [row.id,row] as const;})),deduplicated=new Set<string>(),tables=moduleTables(adapter);
  for(const row of rows){
   assertPortable(row.value);if(await contentHash(canonical(row.value))!==row.contentHash)throw new Error('Incoming merge record digest differs.');
   if(key==='attachment_usage')continue;
   if(key==='personal_repository_state'&&current.size&&!current.has(row.id)){const retained=[...current.values()][0];conflicts.push({module:key,id:row.id,reason:'physical-identity',currentHash:retained.contentHash,incomingHash:row.contentHash});continue;}const prior=current.get(row.id);if(!prior)continue;
   if(canonical(prior.value)!==canonical(row.value)){conflicts.push({module:key,id:row.id,reason:'different-body',currentHash:prior.contentHash,incomingHash:row.contentHash});continue;}
   const target=physicalIdentity(key,tables,row);deduplicated.add(target.table+':'+target.id);const physicalHash=physical.get(target.table)!.find(item=>item.id===target.id)?.content_hash;if(!physicalHash)throw new Error('Portable duplicate lacks its exact physical owner row.');reviewRows.push({module:key,table:target.table,id:target.id,beforeHash:physicalHash,afterHash:physicalHash,disposition:'deduplicate'});
  }
  pending.push({key,rows,tables,deduplicated});
 }
 // Never reinterpret an incoming singleton ledger as quota authority. Its typed
 // source consistency was checked at quarantine; the resulting ledger is derived.
 const allIncoming={planning:input.planningAfter,modules:input.bundle.modules},proofDeadline=Date.now()+(input.verificationMs??15000);
 if(!conflicts.length)for(const {key,rows,tables,deduplicated}of pending){
  if(key==='attachment_usage')continue;
  const adapter=registry.get(key),split=adapter.prepareReplace?await adapter.prepareReplace(allIncoming,rows):tables.length===1?[{table:tables[0],records:rows.map(row=>({id:row.id,value:row.value as JsonValue}))}]:null;
  if(!split||split.length!==tables.length||new Set(split.map(item=>item.table)).size!==tables.length||split.some(item=>!tables.includes(item.table)))throw new Error('Merge adapter must split every declared physical table.');
  const originals=new Map(rows.map(row=>{const target=physicalIdentity(key,tables,row),body=tables.length>1?(row.value as {record:JsonValue}).record:row.value as JsonValue;return [target.table+':'+target.id,body] as const;}));
  for(const part of split as PhysicalImportRows[])for(const source of part.records){
   if(deduplicated.has(part.table+':'+source.id))continue;
   if(part.table==='recurrence_occurrences'&&retainedRuleIds.has((source.value as {ruleId:string}).ruleId))throw new Error('New recurrence history requires a new disabled rule identity; retained owner occurrence semantics cannot be changed by import.');
   const natural=(value:JsonValue)=>{const v=value as {[key:string]:JsonValue};return part.table==='source_observations'?canonical([v.sourceId,v.externalId,v.sourceRevision,v.contentDigest]):part.table==='agent_results'?canonical(v.attemptId):null;},sourceNatural=natural(source.value);
   const prior=physical.get(part.table)!.find(row=>row.id===source.id||sourceNatural!==null&&natural(JSON.parse(row.payload_json))===sourceNatural);if(prior){conflicts.push({module:key,id:source.id,reason:'physical-identity',currentHash:prior.content_hash,incomingHash:await contentHash(canonical(source.value))});continue;}
   const originalValue=originals.get(part.table+':'+source.id);if(originalValue===undefined)throw new Error('Physical merge row lacks its exact original portable body.');
   const value=await inert(part.table,source.id,source.value,input,proofs,warnings,proofDeadline),hash=await contentHash(canonical(value));
   writes.push({table:part.table,id:source.id,operation:'insert',expectedRowRevision:null,value});physical.get(part.table)!.push({id:source.id,row_revision:1,payload_json:canonical(value),content_hash:hash});
   reviewRows.push({module:key,table:part.table,id:source.id,beforeHash:null,afterHash:hash,disposition:'insert'});
   if(part.table==='source_observations'||canonical(value)!==canonical(originalValue))historyClaims.push({module:key,id:source.id,sourceHash:await contentHash(canonical(originalValue)),storedHash:hash,sourceValue:originalValue});
  }
 }
 if(!conflicts.length&&writes.some(row=>row.table==='attachments')){
  const files=physical.get('attachments')!.map(row=>attachmentRecordSchema.parse(JSON.parse(row.payload_json))),charged=files.filter(row=>row.status!=='deleted'),value=attachmentUsageSchema.parse({bytes:charged.reduce((sum,row)=>sum+row.expectedBytes,0),files:charged.length}),prior=physical.get('attachment_usage')!.find(row=>row.id==='quota'),hash=await contentHash(canonical(value));
  if(!prior||prior.content_hash!==hash){writes.push({table:'attachment_usage',id:'quota',operation:prior?'update':'insert',expectedRowRevision:prior?.row_revision??null,value});physical.set('attachment_usage',[{id:'quota',row_revision:(prior?.row_revision??0)+1,payload_json:canonical(value),content_hash:hash}]);reviewRows.push({module:'attachment_usage',table:'attachment_usage',id:'quota',beforeHash:prior?.content_hash??null,afterHash:hash,disposition:'derived-quota'});}
 }
 if(!conflicts.length){
  for(const rows of physical.values())sort(rows);
  const combined=await portable(registry,reader(physical),input.userId,input.workspaceRevision),context={planning:input.planningAfter,modules:combined};
  for(const adapter of registry.entries())if(adapter.policy!=='append-only')adapter.validateReferences?.(context,combined[adapter.key]?.records??[]);
 }
 const intent={version:1 as const,importHash:input.importHash,targetRevision:input.workspaceRevision,beforeDigest:snapshot.digest,rows:reviewRows.sort((a,b)=>a.table<b.table?-1:a.table>b.table?1:a.id<b.id?-1:a.id>b.id?1:0),conflicts:conflicts.sort((a,b)=>a.module.localeCompare(b.module)||a.id.localeCompare(b.id)),warnings:[...warnings].sort()},review={...intent,reviewHash:await contentHash(canonical(intent))};
 if(writes.length>200||new TextEncoder().encode(canonical(writes)).byteLength>BUNDLE_LIMITS.bytes)throw new Error('Selective merge exceeds one bounded atomic batch; review a smaller disjoint bundle.');
 return {writes:conflicts.length?[]:writes,referenceSnapshot:snapshot,review,historyClaims:conflicts.length?[]:historyClaims,verifiedAttachments:conflicts.length?[]:proofs};
}

