import {z} from 'zod';
import {canonical,contentHash} from './canonical-json.ts';
import {readCurrent,type SqlDatabase} from './workspace-store.ts';
import {readOperationalWatermarks} from './operational-watermarks.ts';
import {agentJobEventSchema,agentJobResultSchema,agentApprovalEnvelopeSchema} from './agents/contracts.ts';
import {validateAgentJobRecord,validateAgentExecutionBinding} from './agents/policy.ts';
import {parseAuditEvent} from './audit-events.ts';

/** Private inspection format, deliberately NOT portable data, installation permission or a source-freeze proof. */
export const PRIVATE_CONTINUITY_LIMITS=Object.freeze({bytes:64*1024*1024,rows:100000,page:8});
const digest=z.string().regex(/^[a-f0-9]{64}$/),integer=z.number().int().nonnegative().safe(),positive=integer.min(1),stamp=z.string().datetime({offset:true}),nullableStamp=stamp.nullable(),id=z.string().min(1).max(500),json=z.string().max(1800000),flag=z.union([z.literal(0),z.literal(1)]);
const schemas={
 workspace_recovery:z.object({content:z.string().max(1250000),revision:positive,updated_at:stamp}).strict(),
 workspace_backups:z.object({id,source_revision:positive,created_at:stamp,reason:id,bytes:integer.max(8000000),sha256:digest,content:z.string().max(8000000),status:z.enum(['preparing','ready','failed','expired']),pinned:flag}).strict(),
 backup_archive_cleanup_claims:z.object({storage_key:id,archive_id:id,part_number:integer.max(4),token:id,claimed_at:stamp,purged_at:nullableStamp}).strict(),
 attachment_blob_fences:z.object({storage_key:id,attachment_id:id,namespace:id,token:id,created_at:stamp,purged_at:nullableStamp}).strict(),
 attachment_blob_objects:z.object({storage_key:id,attachment_id:id,namespace:id,bytes:integer,sha256:digest.nullable(),created_at:stamp,verified_at:nullableStamp,purged_at:nullableStamp}).strict(),
 attachment_upload_attempts:z.object({token:id,attachment_id:id,storage_key:id,created_at:stamp,settled_at:nullableStamp}).strict(),
 attachment_blob_namespaces:z.object({namespace:id,created_at:stamp,purpose:id,source_import_id:id.nullable()}).strict(),
 attachment_archive_cleanup_claims:z.object({storage_key:id,stage_id:id,namespace:id,token:id,created_at:stamp,purged_at:nullableStamp}).strict(),
 workspace_mutation_epochs:z.object({epoch:z.string().regex(/^[a-f0-9]{32}$/),status:z.enum(['active','retired']),created_at:stamp,retired_at:nullableStamp}).strict(),
 workspace_mutations:z.object({mutation_id:id,command_hash:digest,revision:positive,committed_at:stamp}).strict(),
 workspace_job_intents:z.object({id,kind:id,dedupe_key:id,payload_json:json,not_before:stamp,status:id,execution_epoch:integer,cancel_requested:flag}).strict(),
 agent_job_state:z.object({job_id:id,intent_id:id,status:z.enum(['awaiting_approval','queued','leased','running','cancelling','succeeded','failed','cancelled','blocked','reconcile_required','rejected']),operational_revision:positive,spec_hash:digest,task_hash:digest,device_id:id.nullable(),approval_id:id.nullable(),attempt_id:id.nullable(),execution_epoch:integer,cancel_requested_at:nullableStamp,cancel_request_id:id.nullable(),updated_at:stamp,result_json:json.nullable(),accepted_at:nullableStamp,accepted_task_hash:digest.nullable()}).strict(),
 job_approvals:z.object({id,job_id:id,device_id:id,spec_hash:digest,binding_hash:digest,payload_json:json,created_at:stamp,expires_at:stamp,consumed_at:nullableStamp,revoked_at:nullableStamp,reserved_seconds:integer}).strict(),
 job_attempts:z.object({id,job_id:id,device_id:id,approval_id:id,execution_epoch:integer,journal_nonce_hash:digest,lease_token_hash:digest,lease_expires_at:stamp,deadline_at:stamp,created_at:stamp,launched_at:nullableStamp,exited_at:nullableStamp,cancel_acknowledged_at:nullableStamp,last_applied_sequence:integer,operational_revision:positive,identity_json:json,result_json:json.nullable(),reconciled_at:nullableStamp}).strict(),
 job_events:z.object({attempt_id:id,epoch:integer,sequence:positive,payload_hash:digest,payload_json:json,receipt_json:json,received_at:stamp,applied_at:nullableStamp}).strict(),
 agent_device_slots:z.object({device_id:id,attempt_id:id,reserved_at:stamp,released_at:nullableStamp}).strict(),
 agent_budgets:z.object({id,operational_revision:positive,payload_json:json,maximum_jobs:integer.max(12),maximum_seconds:integer.max(7200),reserved_jobs:integer,reserved_seconds:integer,charged_seconds:integer,enabled:flag,updated_at:stamp}).strict(),
 backup_archives:z.object({id,namespace:z.string().uuid(),intent_id:id,source_revision:positive,source_sha256:digest,metadata_content:z.string().max(8000000).nullable(),metadata_bytes:integer.max(8000000),execution_epoch:integer,status:z.enum(['preparing','ready','failed','retired']),created_at:stamp,updated_at:stamp,zip_bytes:integer.max(20*1024*1024),files:integer.max(500),file_bytes:integer.max(20*1024*1024),chunk_count:integer.max(5),index_json:z.string().max(1800000).nullable(),index_sha256:digest.nullable()}).strict(),
 backup_archive_objects:z.object({archive_id:id,part_number:integer.max(4),storage_key:id,bytes:integer.max(4194304),sha256:digest.nullable(),created_at:stamp,verified_at:nullableStamp,purged_at:nullableStamp,pending_token:id.nullable(),settled_at:nullableStamp}).strict(),
 agent_artifacts:z.object({attempt_id:id,artifact_id:id,logical_type:id,sha256:digest,bytes:integer,created_at:stamp}).strict(),
};
type Table=keyof typeof schemas;
export const PRIVATE_CONTINUITY_TABLES=Object.freeze(Object.keys(schemas) as Table[]);
const keys:Record<Table,readonly string[]>={workspace_recovery:['revision'],workspace_backups:['id'],backup_archive_cleanup_claims:['storage_key'],attachment_blob_fences:['storage_key'],attachment_blob_objects:['storage_key'],attachment_upload_attempts:['token'],attachment_blob_namespaces:['namespace'],attachment_archive_cleanup_claims:['storage_key'],workspace_mutation_epochs:['epoch'],workspace_mutations:['mutation_id'],workspace_job_intents:['id'],agent_job_state:['job_id'],job_approvals:['id'],job_attempts:['id'],job_events:['attempt_id','epoch','sequence'],agent_device_slots:['device_id'],agent_budgets:['id'],agent_artifacts:['attempt_id','artifact_id'],backup_archives:['id'],backup_archive_objects:['archive_id','part_number']};
const sourceContextSchema=z.object({workspaceRevision:positive,executionEpoch:integer,operationalWatermarks:z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),integer).refine(value=>Object.keys(value).length<=32)}).strict();
const deletionSchema=z.object({event_id:id,kind:z.literal('entity.delete'),entity_type:z.enum(['task','capture']),entity_id:id,occurred_at:stamp,payload_json:json}).strict();
const tablesSchema=z.object(Object.fromEntries(PRIVATE_CONTINUITY_TABLES.map(table=>[table,z.array(schemas[table]).max(PRIVATE_CONTINUITY_LIMITS.rows)])) as unknown as {[K in Table]:z.ZodArray<typeof schemas[K]>}).strict();
export const recoveryPrivateContinuitySchema=z.object({format:z.literal('control-room-private-continuity'),version:z.literal(1),authority:z.literal('inspection-only'),manifestSha256:digest,ownerContextHash:digest,sourceContext:sourceContextSchema,capturedAt:stamp,sourceNamespaces:z.object({audit_namespace:z.string().uuid(),blob_namespace:z.string().uuid()}).strict(),tables:tablesSchema,baselineRemovalFences:z.array(deletionSchema).max(PRIVATE_CONTINUITY_LIMITS.rows),sha256:digest}).strict();
export type RecoveryPrivateContinuity=z.infer<typeof recoveryPrivateContinuitySchema>;
export interface PrivateContinuityExpected {manifestSha256:string;ownerContextHash:string;sourceContext:z.infer<typeof sourceContextSchema>;sha256:string;ownerId:string}
type Row=Record<string,string|number|null>;
const encoder=new TextEncoder();
function compare(a:string|number|null,b:string|number|null):number{
 if(typeof a==='number'&&typeof b==='number')return a-b;
 if(typeof a!=='string'||typeof b!=='string')throw new Error('Invalid continuity ordering identity.');
 const left=encoder.encode(a),right=encoder.encode(b);for(let i=0;i<Math.min(left.length,right.length);i++)if(left[i]!==right[i])return left[i]-right[i];return left.length-right.length;
}
function ordered(rows:Row[],columns:readonly string[]){
 for(let i=1;i<rows.length;i++){let order=0;for(const column of columns){order=compare(rows[i-1][column],rows[i][column]);if(order)break;}if(order>=0)throw new Error('Duplicate or out-of-order private continuity identity.');}
}
function parseJson(value:string):unknown{return JSON.parse(value);}
function checkedObjectKey(value:{storage_key:string;attachment_id:string;namespace:string}){
 if(value.storage_key!=='attachments/'+value.namespace+'/'+value.attachment_id)throw new Error('Physical attachment identity differs.');
}
export async function validateRecoveryPrivateContinuity(raw:unknown,expected:PrivateContinuityExpected):Promise<RecoveryPrivateContinuity>{
 const trusted=structuredClone(expected);digest.parse(trusted.sha256);digest.parse(trusted.manifestSha256);digest.parse(trusted.ownerContextHash);id.parse(trusted.ownerId);sourceContextSchema.parse(trusted.sourceContext);
 const value=recoveryPrivateContinuitySchema.parse(raw),{sha256,...body}=value;
 if(value.sourceNamespaces.audit_namespace===value.sourceNamespaces.blob_namespace)throw new Error('Source audit/blob namespaces must be distinct.');
 if(encoder.encode(canonical(value)).byteLength>PRIVATE_CONTINUITY_LIMITS.bytes)throw new Error('Private continuity byte limit exceeded.');
 if(value.manifestSha256!==trusted.manifestSha256||value.ownerContextHash!==trusted.ownerContextHash||canonical(value.sourceContext)!==canonical(trusted.sourceContext)||sha256!==trusted.sha256||await contentHash(canonical(body))!==sha256)throw new Error('Trusted private continuity identity/hash differs.');
 for(const logical of value.tables.workspace_backups){
  if(encoder.encode(logical.content).length!==logical.bytes||(logical.content!==''||logical.status==='ready')&&await contentHash(logical.content)!==logical.sha256)throw new Error('Logical backup metadata digest differs.');
 }
 for(const claim of value.tables.backup_archive_cleanup_claims){
  const archive=value.tables.backup_archives.find(row=>row.id===claim.archive_id);
  if(!archive||claim.storage_key!=='backups/'+archive.namespace+'/part-'+String(claim.part_number).padStart(4,'0'))throw new Error('Backup cleanup physical identity differs.');
 }
 let count=value.baselineRemovalFences.length;
 for(const table of PRIVATE_CONTINUITY_TABLES){const rows=value.tables[table] as unknown as Row[];count+=rows.length;ordered(rows,keys[table]);}
 if(count>PRIVATE_CONTINUITY_LIMITS.rows)throw new Error('Private continuity row limit exceeded.');
 for(const row of [...value.tables.attachment_blob_fences,...value.tables.attachment_blob_objects])checkedObjectKey(row);
 for(const claim of value.tables.attachment_archive_cleanup_claims){const object=value.tables.attachment_blob_objects.find(row=>row.storage_key===claim.storage_key&&row.namespace===claim.namespace);if(!object)throw new Error('Archive cleanup physical identity is unavailable.');checkedObjectKey(object);}
 for(const upload of value.tables.attachment_upload_attempts)if(!value.tables.attachment_blob_objects.some(row=>row.storage_key===upload.storage_key&&row.attachment_id===upload.attachment_id))throw new Error('Retained upload physical identity is unavailable.');
 for(const row of value.tables.workspace_mutation_epochs)if((row.status==='active')!==(row.retired_at===null))throw new Error('Mutation epoch retirement metadata differs.');
 const attempts=new Map(value.tables.job_attempts.map(row=>[row.id,row])),states=new Map(value.tables.agent_job_state.map(row=>[row.job_id,row])),approvals=new Map(value.tables.job_approvals.map(row=>[row.id,row])),budgets=new Map(value.tables.agent_budgets.map(row=>[row.id,row]));
 const identities=new Map<string,{budgetId:string;timeoutSeconds:number}>();
 for(const attempt of attempts.values()){
  const state=states.get(attempt.job_id),approval=approvals.get(attempt.approval_id);
  if(!state||state.attempt_id!==attempt.id||state.execution_epoch!==attempt.execution_epoch||!approval||approval.job_id!==attempt.job_id||approval.device_id!==attempt.device_id||approval.consumed_at===null)throw new Error('Retained attempt/state/approval identity differs.');
  const identity=z.object({record:z.unknown(),executionBinding:z.unknown(),budgetId:id}).strict().parse(parseJson(attempt.identity_json)),record=await validateAgentJobRecord(identity.record),binding=validateAgentExecutionBinding(record.spec,identity.executionBinding);
  if(record.id!==attempt.job_id||record.intentId!==state.intent_id||record.specSha256!==approval.spec_hash||canonical(binding)!==canonical(agentApprovalEnvelopeSchema.parse(parseJson(approval.payload_json)).executionBinding)||record.specSha256!==state.spec_hash||record.spec.taskSnapshotSha256!==state.task_hash||!budgets.has(identity.budgetId)||binding.budget.timeoutSeconds!==approval.reserved_seconds)throw new Error('Retained journal execution identity differs.');
  identities.set(attempt.id,{budgetId:identity.budgetId,timeoutSeconds:record.spec.timeoutSeconds});
  if(attempt.result_json!==null){const result=agentJobResultSchema.parse(parseJson(attempt.result_json));if(result.attemptId!==attempt.id||result.epoch!==attempt.execution_epoch||state.result_json!==attempt.result_json)throw new Error('Retained terminal result differs.');}
 }
 for(const approval of approvals.values()){const envelope=agentApprovalEnvelopeSchema.parse(parseJson(approval.payload_json));if(envelope.approval.id!==approval.id||envelope.approval.jobId!==approval.job_id||envelope.approval.deviceId!==approval.device_id||envelope.approval.specSha256!==approval.spec_hash||envelope.approval.origin!=='native-owner'||envelope.approverId!==trusted.ownerId||envelope.bindingSha256!==approval.binding_hash||await contentHash(canonical(envelope.executionBinding))!==approval.binding_hash||!budgets.has(envelope.reservationId))throw new Error('Private approval reservation identity differs.');}
 for(const slot of value.tables.agent_device_slots){const attempt=attempts.get(slot.attempt_id);if(!attempt||attempt.device_id!==slot.device_id)throw new Error('Retained slot/journal identity differs.');}
 for(const attempt of attempts.values())if(attempt.result_json===null&&attempt.reconciled_at===null&&!value.tables.agent_device_slots.some(slot=>slot.attempt_id===attempt.id&&slot.released_at===null))throw new Error('Unknown attempt must retain its occupied slot.');
 for(const budget of budgets.values()){
  let requiredSeconds=0,requiredJobs=0;
  for(const attempt of attempts.values())if(attempt.result_json===null&&attempt.reconciled_at===null&&identities.get(attempt.id)?.budgetId===budget.id){requiredSeconds+=identities.get(attempt.id)!.timeoutSeconds;requiredJobs++;}
  for(const approval of approvals.values())if(approval.consumed_at===null&&approval.revoked_at===null&&agentApprovalEnvelopeSchema.parse(parseJson(approval.payload_json)).reservationId===budget.id){requiredSeconds+=approval.reserved_seconds;requiredJobs++;}
  if(budget.reserved_seconds<requiredSeconds||budget.reserved_jobs<requiredJobs)throw new Error('Unknown/queued work lost its finite reservation.');
 }
 for(const event of value.tables.job_events){
  const attempt=attempts.get(event.attempt_id),payload=agentJobEventSchema.parse(parseJson(event.payload_json)),receipt=z.object({attemptId:id,epoch:integer,sequence:positive,payloadSha256:digest,receivedAt:stamp}).strict().parse(parseJson(event.receipt_json));
  if(!attempt||attempt.execution_epoch!==event.epoch||payload.attemptId!==attempt.id||payload.epoch!==event.epoch||payload.sequence!==event.sequence||await contentHash(canonical(payload))!==event.payload_hash||receipt.attemptId!==attempt.id||receipt.epoch!==event.epoch||receipt.sequence!==event.sequence||receipt.payloadSha256!==event.payload_hash||receipt.receivedAt!==event.received_at)throw new Error('Retained event/receipt identity differs.');
 }
 for(const artifact of value.tables.agent_artifacts)if(!attempts.has(artifact.attempt_id))throw new Error('Retained result artifact attempt is missing.');
 for(const budget of budgets.values())if(canonical(parseJson(budget.payload_json))!==canonical({maximumJobs:budget.maximum_jobs,maximumSeconds:budget.maximum_seconds,enabled:budget.enabled===1})||budget.reserved_seconds+budget.charged_seconds>budget.maximum_seconds||budget.reserved_jobs>budget.maximum_jobs)throw new Error('Retained finite budget differs.');
 for(const state of states.values()){
  const intent=value.tables.workspace_job_intents.find(row=>row.id===state.intent_id);
  if(!intent||intent.kind!=='agent.execute'||(parseJson(intent.payload_json) as {jobId?:unknown}).jobId!==state.job_id||state.attempt_id!==null&&!attempts.has(state.attempt_id))throw new Error('Retained queue/state identity differs.');
 }
 const archiveIndex=z.object({format:z.literal('workspace-archive-chunks'),version:z.literal(1),archiveId:id,metadataSha256:digest,manifestSha256:digest,zipBytes:positive.max(20*1024*1024),files:integer.max(500),fileBytes:integer.max(20*1024*1024),chunks:z.array(z.object({part:integer.max(4),bytes:positive.max(4194304),sha256:digest}).strict()).min(1).max(5)}).strict();
 for(const archive of value.tables.backup_archives){
  if((archive.index_json===null)!==(archive.index_sha256===null))throw new Error('Backup archive index identity is incomplete.');
  if(archive.status==='retired'&&(archive.metadata_content!==null||archive.metadata_bytes!==0))throw new Error('Retired backup metadata differs.');
  if(archive.metadata_content!==null&&(encoder.encode(archive.metadata_content).byteLength!==archive.metadata_bytes||await contentHash(archive.metadata_content)!==archive.source_sha256))throw new Error('Backup source metadata digest differs.');
  if(archive.index_json!==null){
   const index=archiveIndex.parse(parseJson(archive.index_json));
   if(index.archiveId!==archive.id||index.metadataSha256!==archive.source_sha256||await contentHash(canonical(index))!==archive.index_sha256||index.zipBytes!==archive.zip_bytes||index.files!==archive.files||index.fileBytes!==archive.file_bytes||index.chunks.length!==archive.chunk_count||index.chunks.reduce((total,chunk)=>total+chunk.bytes,0)!==index.zipBytes||index.chunks.some((chunk,position)=>chunk.part!==position||(position<index.chunks.length-1&&chunk.bytes!==4194304)))throw new Error('Backup archive index digest/count differs.');
   if(archive.status==='ready')for(const chunk of index.chunks){const object=value.tables.backup_archive_objects.find(row=>row.archive_id===archive.id&&row.part_number===chunk.part);if(!object||object.bytes!==chunk.bytes||object.sha256!==chunk.sha256||object.verified_at===null||object.purged_at!==null)throw new Error('Ready backup chunk proof is incomplete.');}
  }else if(archive.status==='ready')throw new Error('Ready backup index is unavailable.');
 }
 for(const object of value.tables.backup_archive_objects){
  const archive=value.tables.backup_archives.find(row=>row.id===object.archive_id);
  if(!archive||object.storage_key!=='backups/'+archive.namespace+'/part-'+String(object.part_number).padStart(4,'0')||(object.pending_token===null&&object.settled_at!==null))throw new Error('Backup physical identity differs.');
 }
 ordered(value.baselineRemovalFences,['event_id']);
 for(const fence of value.baselineRemovalFences){const event=parseAuditEvent(parseJson(fence.payload_json));if(event.id!==fence.event_id||event.kind!=='entity.delete'||event.entityType!==fence.entity_type||event.entityId!==fence.entity_id||event.origin!=='owner'||event.actorId!==trusted.ownerId||event.occurredAt!==fence.occurred_at)throw new Error('Baseline removal must be an original owner deletion, not imported history.');}
 return value;
}
async function sourceContext(db:SqlDatabase,owner:string,now:string){
 const current=await readCurrent(db,owner,now),epoch=await db.prepare('SELECT epoch FROM workspace_execution_state WHERE user_id=?').bind(owner).first<{epoch:number}>();
 return sourceContextSchema.parse({workspaceRevision:current.revision,executionEpoch:epoch?.epoch??0,operationalWatermarks:await readOperationalWatermarks(db,owner)});
}
/** Privileged read-only capture. Equal scans detect drift but DO NOT establish a source freeze. */
export async function captureRecoveryPrivateContinuity(db:SqlDatabase,owner:string,input:{manifestSha256:string;ownerContextHash:string;sourceContext:z.infer<typeof sourceContextSchema>},now:string):Promise<RecoveryPrivateContinuity>{
 const request=structuredClone(input);id.parse(owner);stamp.parse(now);digest.parse(request.manifestSha256);digest.parse(request.ownerContextHash);sourceContextSchema.parse(request.sourceContext);
 if(canonical(await sourceContext(db,owner,now))!==canonical(request.sourceContext))throw new Error('Source context changed.');
 const namespaces=await db.prepare('SELECT audit_namespace,blob_namespace FROM workspace_source_namespaces WHERE user_id=?').bind(owner).first<{audit_namespace:string;blob_namespace:string}>();if(!namespaces)throw new Error('Original source namespaces are unavailable.');
 const tables={} as RecoveryPrivateContinuity['tables'];let rows=0,bytes=0;
 async function scan(table:Table,onRow:(row:Row,index:number)=>void){
  const columns=Object.keys(schemas[table].shape),physical=(await db.prepare('PRAGMA table_info('+table+')').all<{name:string}>()).results.map(row=>row.name).sort();
  if(canonical(physical)!==canonical(['user_id',...columns].sort()))throw new Error('Unsupported private continuity table schema: '+table);
  let after:Row|null=null,index=0;
  for(;;){
   const where=after?' AND ('+keys[table].join(',')+')>('+keys[table].map(()=>'?').join(',')+')':'',bindings=after?keys[table].map(key=>after![key]):[];
   const page=(await db.prepare('SELECT '+columns.join(',')+' FROM '+table+' WHERE user_id=?'+where+' ORDER BY '+keys[table].join(',')+' LIMIT ?').bind(owner,...bindings,PRIVATE_CONTINUITY_LIMITS.page).all<Row>()).results;
   for(const raw of page){const row=schemas[table].parse(raw) as unknown as Row;onRow(row,index++);after=row;}if(page.length<PRIVATE_CONTINUITY_LIMITS.page)break;
  }
  return index;
 }
 for(const table of PRIVATE_CONTINUITY_TABLES){
  const values:Row[]=[];await scan(table,row=>{rows++;bytes+=encoder.encode(canonical(row)).byteLength;if(rows>PRIVATE_CONTINUITY_LIMITS.rows||bytes>PRIVATE_CONTINUITY_LIMITS.bytes)throw new Error('Private continuity capacity exceeded.');values.push(row);});
  (tables as unknown as Record<string,Row[]>)[table]=values;
 }
 async function removals(onRow:(row:z.infer<typeof deletionSchema>,index:number)=>void){
  let after='',index=0;
  for(;;){const page=(await db.prepare("SELECT event_id,kind,entity_type,entity_id,occurred_at,payload_json FROM audit_events WHERE user_id=? AND kind='entity.delete' AND entity_type IN('task','capture') AND event_id>? ORDER BY event_id LIMIT ?").bind(owner,after,PRIVATE_CONTINUITY_LIMITS.page).all()).results;
   for(const raw of page){const row=deletionSchema.parse(raw);onRow(row,index++);after=row.event_id;}if(page.length<PRIVATE_CONTINUITY_LIMITS.page)break;
  }return index;
 }
 const baselineRemovalFences:z.infer<typeof deletionSchema>[]=[];
 await removals(row=>{rows++;bytes+=encoder.encode(canonical(row)).byteLength;if(rows>PRIVATE_CONTINUITY_LIMITS.rows||bytes>PRIVATE_CONTINUITY_LIMITS.bytes)throw new Error('Private deletion continuity capacity exceeded.');baselineRemovalFences.push(row);});
 const body={format:'control-room-private-continuity' as const,version:1 as const,authority:'inspection-only' as const,manifestSha256:request.manifestSha256,ownerContextHash:request.ownerContextHash,sourceContext:request.sourceContext,capturedAt:now,sourceNamespaces:namespaces,tables,baselineRemovalFences},sha256=await contentHash(canonical(body));
 const value=await validateRecoveryPrivateContinuity({...body,sha256},{...request,sha256,ownerId:owner});
 for(const table of PRIVATE_CONTINUITY_TABLES){const original=value.tables[table] as unknown as Row[];const count=await scan(table,(row,index)=>{if(canonical(row)!==canonical(original[index]))throw new Error('Private source rows changed during capture.');});if(count!==original.length)throw new Error('Private source rows changed during capture.');}
 const removalCount=await removals((row,index)=>{if(canonical(row)!==canonical(baselineRemovalFences[index]))throw new Error('Private deletion source changed during capture.');});
 const finalNamespaces=await db.prepare('SELECT audit_namespace,blob_namespace FROM workspace_source_namespaces WHERE user_id=?').bind(owner).first();
 if(removalCount!==baselineRemovalFences.length||canonical(finalNamespaces)!==canonical(namespaces)||canonical(await sourceContext(db,owner,now))!==canonical(request.sourceContext))throw new Error('Source context changed during capture.');
 return value;
}
export function assessPrivateRecoveryContinuity(value:RecoveryPrivateContinuity):{installable:false;blockers:string[];nextExecutionEpoch:number;retainedUnknownAttempts:number}{
 const parsed=recoveryPrivateContinuitySchema.parse(value),blockers=['source_freeze_unverified','inactive_target_and_cutover_authority_unimplemented'];
 if(parsed.sourceContext.executionEpoch===Number.MAX_SAFE_INTEGER)throw new Error('Execution epoch exhausted.');
 if(parsed.tables.attachment_upload_attempts.some(row=>row.settled_at===null))blockers.push('unsettled_upload_attempts');
 if(parsed.tables.backup_archive_objects.some(row=>row.pending_token!==null&&row.settled_at===null))blockers.push('unsettled_backup_archive_put');
 if(parsed.tables.backup_archive_objects.some(row=>row.purged_at===null))blockers.push('backup_archive_namespace_handoff_required');
 if(parsed.tables.attachment_blob_objects.some(row=>row.purged_at===null))blockers.push('physical_namespace_handoff_unsupported');
 if(parsed.tables.attachment_blob_fences.some(fence=>fence.purged_at!==null&&!parsed.tables.attachment_blob_objects.some(object=>object.storage_key===fence.storage_key&&object.attachment_id===fence.attachment_id&&object.purged_at!==null&&object.sha256!==null&&object.verified_at!==null)))blockers.push('purged_identity_unverified');
 return {installable:false,blockers,nextExecutionEpoch:parsed.sourceContext.executionEpoch+1,retainedUnknownAttempts:parsed.tables.job_attempts.filter(row=>row.result_json===null&&row.reconciled_at===null).length};
}
