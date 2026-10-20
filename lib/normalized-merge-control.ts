import {z} from 'zod';
import {canonical,contentHash} from './canonical-json.ts';
import {OWNER_TABLES,ownerReader,type RegisteredOwnerTable} from './workspace-modules.ts';
import {moduleProjection} from './module-columns.ts';
import {attachmentRecordSchema,attachmentUsageSchema} from './evidence-module.ts';
import {attachmentGenerationSql} from './attachment-generation.ts';
import {RECOVERABILITY_SQL_ARGUMENT_BYTES} from './recoverability-measure.ts';
import type {MutationPlan} from './workspace-transaction.ts';
import type {WorkspaceCommand,JsonValue} from './workspace-protocol.ts';
import type {SqlDatabase,SqlStatement} from './workspace-store.ts';
import {CommandValidationError} from './workspace-errors.ts';
const digest=z.string().regex(/^[a-f0-9]{64}$/u),id=z.string().min(1).max(128).refine(value=>value.trim()===value),table=z.enum(OWNER_TABLES);
const coverage:Record<string,readonly RegisteredOwnerTable[]>={
 weekly_plans:['weekly_plans'],weekly_reviews:['weekly_reviews'],recurrence_rules:['recurrence_rules'],recurrence_occurrences:['recurrence_occurrences'],
 evidence:['evidence_records','evidence_versions','evidence_mappings'],decisions:['decision_records','decision_versions','decisions'],
 evidence_links:['evidence_links'],evidence_requirements:['evidence_requirements'],acceptance_records:['acceptance_records'],attachments:['attachments'],attachment_usage:['attachment_usage'],
 source_connections:['source_connections'],source_targets:['source_targets'],source_observations:['source_observations'],source_sync_runs:['source_sync_runs'],source_proposals:['source_proposals'],integration_history:['integration_history'],
 review_snapshots:['review_snapshots'],review_acknowledgements:['review_acknowledgements'],automation_schedules:['automation_schedules'],automation_occurrences:['automation_occurrences'],notification_events:['notification_events'],review_settings:['review_settings'],review_analysis_runs:['review_analysis_runs'],
 project_baseline_revisions:['project_baseline_revisions'],devices:['devices'],runtime_adapter_configurations:['runtime_adapter_configurations'],runtime_evidence:['runtime_evidence'],agent_jobs:['agent_jobs'],agent_results:['agent_results'],evaluation_runs:['evaluation_runs']
};
export const normalizedMergeRowSchema=z.object({module:z.string().min(1).max(80),table,id,beforeHash:digest.nullable(),afterHash:digest,disposition:z.enum(['insert','deduplicate','derived-quota'])}).strict();
export const normalizedMergeProofSchema=z.object({id,storageKey:z.string().min(1).max(500),bytes:z.number().int().nonnegative().safe(),sha256:digest}).strict();
export const normalizedMergeControlSchema=z.object({importHash:digest,reviewHash:digest,rows:z.array(normalizedMergeRowSchema).min(1).max(10000),verifiedAttachments:z.array(normalizedMergeProofSchema).max(200)}).strict();
export type NormalizedMergeControl=z.infer<typeof normalizedMergeControlSchema>;
function reject(message:string):never{throw new CommandValidationError(message);}
function key(table:string,id:string){return table+'\u0000'+id;}
function object(value:JsonValue):Record<string,JsonValue>{if(!value||typeof value!=='object'||Array.isArray(value))reject('Normalized merge requires typed object records.');return value as Record<string,JsonValue>;}
function inert(table:RegisteredOwnerTable,id:string,value:JsonValue):void{
 const row=object(value);
 if(table==='workspace_configuration')reject('Configuration authority cannot be merged.');
 if(table==='weekly_plans'&&(!Array.isArray(row.taskIds)||row.taskIds.length||row.capacityMinutes!==null))reject('Imported weekly rows cannot create commitments or capacity.');
 if(['recurrence_rules','source_connections','automation_schedules'].includes(table)&&row.enabled!==false)reject('Imported execution settings must remain disabled.');
 if(['evidence_requirements','devices'].includes(table)&&(row.archivedAt===null||typeof row.archivedAt!=='string'))reject('Imported criteria and devices must remain archived.');
 if(table==='runtime_evidence'&&row.origin!=='historical-import')reject('Imported observations must remain historical claims.');
 if(table==='source_proposals'&&(row.state!=='pending'||row.decision!==null))reject('Imported source proposals cannot become owner decisions.');
 if(table==='runtime_adapter_configurations'&&object(row.manifest).enabled!==false)reject('Imported runtime configurations must remain disabled.');
 if(table==='agent_jobs'&&row.historical!==true||table==='agent_results'&&(row.historical!==true||object(row.frozenJob).historical!==true))reject('Imported execution records cannot create runnable authority.');
 if(table==='review_settings'){
  if(id==='analysis'){if(row.enabled!==false)reject('Imported analysis must remain disabled.');}
  else if(id==='notifications'){if(object(row.quietHours).enabled!==false||row.externalDelivery!=='disabled'||!Array.isArray(row.mutedKinds)||row.mutedKinds.length||!Array.isArray(row.mutedSourceIds)||row.mutedSourceIds.length)reject('Imported notification preferences must remain inactive.');}
  else reject('Unknown imported review settings identity.');
 }
}
/** Compiler validation is independent of preview callbacks. It grants no blob,
 * queue, assessment, decision, baseline or provider authority. */
export async function validateNormalizedMergePlan(db:SqlDatabase,owner:string,revision:number,command:WorkspaceCommand,plan:MutationPlan):Promise<NormalizedMergeControl>{
 const control=normalizedMergeControlSchema.parse(plan.normalizedMerge);
 const approved=new Set(['normalizedMerge','referenceSnapshot','importSource','planningAfter','writes','preconditions','events','backup','jobs','historyImports','restoreEpoch']);
 if(Object.keys(plan).some(field=>!approved.has(field))||command.type!=='workspace.import.commit'||command.mode!=='merge'||command.targetRevision!==revision||command.hash!==control.importHash||command.normalizedReviewHash!==control.reviewHash||typeof command.importId!=='string'||!command.importId||plan.importSource?.id!==command.importId||plan.importSource?.hash!==control.importHash||!plan.restoreEpoch||(!plan.backup||canonical(plan.backup)!==canonical({reason:'restore'}))||plan.jobs.length||!plan.writes.length||plan.writes.length>200||plan.events.length!==1||plan.events[0].kind!=='workspace.import.commit'||plan.events[0].sourceRef!==control.importHash||!plan.referenceSnapshot)reject('Normalized merge requires one exact reviewed inert import boundary.');
 if(plan.historyImports?.some(entry=>entry.importHash!==control.importHash))reject('Normalized merge provenance differs from its reviewed source.');
 const snapshot=plan.referenceSnapshot;
 if(canonical(snapshot.coveredModules)!==canonical(OWNER_TABLES)||snapshot.rows.length>10000||new Set(snapshot.rows.map(row=>key(row.module,row.id))).size!==snapshot.rows.length)reject('Normalized merge requires a complete immutable owner snapshot.');
 for(const row of snapshot.rows){table.parse(row.module);id.parse(row.id);digest.parse(row.contentHash);if(!Number.isSafeInteger(row.rowRevision)||row.rowRevision<1||row.references.length)reject('Invalid normalized merge snapshot.');}
 if(await contentHash(canonical({coveredModules:snapshot.coveredModules,rows:snapshot.rows}))!==snapshot.digest)reject('Normalized merge snapshot digest differs.');
 const before=new Map(snapshot.rows.map(row=>[key(row.module,row.id),row])),writes=new Map(plan.writes.map(write=>[key(write.table,write.id),write])),reviews=new Map(control.rows.map(row=>[key(row.table,row.id),row]));
 if(writes.size!==plan.writes.length||reviews.size!==control.rows.length)reject('Duplicate normalized merge physical identity.');
 for(const row of control.rows){
  if(!Object.hasOwn(coverage,row.module)||!coverage[row.module].includes(row.table))reject('Normalized merge module coverage differs.');
  const existing=before.get(key(row.table,row.id)),write=writes.get(key(row.table,row.id));
  if(row.disposition==='deduplicate'){
   if(write||!existing||row.beforeHash!==existing.contentHash||row.afterHash!==existing.contentHash)reject('Normalized deduplication must preserve the exact existing physical body.');
  }else if(row.disposition==='insert'){
   if(existing||row.beforeHash!==null||!write||write.operation!=='insert'||write.expectedRowRevision!==null||write.value===undefined||await contentHash(canonical(write.value))!==row.afterHash)reject('Normalized additions must insert an absent exact reviewed body.');
  }else{
   if(row.module!=='attachment_usage'||row.table!=='attachment_usage'||row.id!=='quota'||!write||write.value===undefined||write.operation!==(existing?'update':'insert')||write.expectedRowRevision!==(existing?.rowRevision??null)||row.beforeHash!==(existing?.contentHash??null)||await contentHash(canonical(write.value))!==row.afterHash)reject('Only the exact derived attachment quota may update an existing row.');
  }
 }
 const proofById=new Map(control.verifiedAttachments.map(proof=>[proof.id,proof]));if(proofById.size!==control.verifiedAttachments.length||new Set(control.verifiedAttachments.map(proof=>proof.storageKey)).size!==control.verifiedAttachments.length)reject('Duplicate verified attachment merge proof.');
 const insertedAttachments:Array<z.infer<typeof attachmentRecordSchema>>=[];
 for(const write of plan.writes){
  const row=reviews.get(key(write.table,write.id));if(!row||row.disposition==='deduplicate'||write.value===undefined||write.operation==='delete'||write.table==='attachment_usage'&&row.disposition!=='derived-quota')reject('A normalized write is outside the exact reviewed insert or quota set.');
  await moduleProjection(write.table,write.id,write.value);inert(write.table,write.id,write.value);
  if(write.table==='attachments'){
   const file=attachmentRecordSchema.parse(write.value);if(file.id!==write.id||file.status==='reserved')reject('Imported files cannot create upload reservations.');
   const proof=proofById.get(write.id);
   if(file.status==='ready'){
    if(!proof||proof.storageKey!==file.storageKey||proof.bytes!==file.expectedBytes||file.actualBytes!==proof.bytes||proof.sha256!==file.sha256)reject('Every imported ready file needs one exact owned physical proof.');
   }else if(proof)reject('Only ready imported files may carry a byte proof.');
   insertedAttachments.push(file);
  }
 }
 if(control.verifiedAttachments.some(proof=>!insertedAttachments.some(file=>file.id===proof.id&&file.status==='ready')))reject('Unbound normalized attachment proof.');
 const quotaRows=control.rows.filter(row=>row.disposition==='derived-quota');if(quotaRows.length>1||quotaRows.length&&!insertedAttachments.length)reject('A derived quota is valid only for the combined attachment set.');
 if(insertedAttachments.length){
  const query=ownerReader(db,owner),files:Array<z.infer<typeof attachmentRecordSchema>>=[];let after='',bytes=0;
  for(;;){const page=await query.list('attachments',{after,limit:200});for(const row of page){if(row.id<=after)reject('Invalid current attachment page.');after=row.id;bytes+=new TextEncoder().encode(row.payload_json).length;if(files.length>=10000||bytes>RECOVERABILITY_SQL_ARGUMENT_BYTES)reject('Current attachment snapshot exceeds merge bounds.');const expected=before.get(key('attachments',row.id));if(!expected||expected.rowRevision!==row.row_revision||expected.contentHash!==row.content_hash||await contentHash(canonical(JSON.parse(row.payload_json)))!==row.content_hash)reject('Current attachment snapshot changed.');files.push(attachmentRecordSchema.parse(JSON.parse(row.payload_json)));}if(page.length<200)break;}
  files.push(...insertedAttachments);const charged=files.filter(file=>file.status!=='deleted'),quota=attachmentUsageSchema.parse({bytes:charged.reduce((sum,file)=>sum+file.expectedBytes,0),files:charged.length}),existing=await query.get('attachment_usage','quota'),quotaWrite=writes.get(key('attachment_usage','quota'));
  if(existing&&await contentHash(canonical(JSON.parse(existing.payload_json)))!==existing.content_hash)reject('Current quota digest differs.');
  const changed=!existing||canonical(JSON.parse(existing.payload_json))!==canonical(quota);
  if(changed?!quotaWrite||canonical(quotaWrite.value)!==canonical(quota):!!quotaWrite)reject('Normalized quota must be exactly derived from retained and newly inserted nondeleted files.');
 }
 return control;
}
/** Materialize private proof outside CASE to fit deployed D1 expression depth.
 * Preview verifiers cannot mint a ledger, namespace or cleanup grant. */
export function normalizedMergeAttachmentAssertions(db:SqlDatabase,owner:string,mutationId:string,control:NormalizedMergeControl,source:{id:string;hash:string},revision:number,now:string,claim:string,guard:(string|number|null)[]):SqlStatement[]{
 return control.verifiedAttachments.map(proof=>{
  const fields={owner:'merge_file.owner',attachmentId:'merge_file.id',storageKey:'merge_file.storage_key',bytes:'merge_file.bytes',sha256:'merge_file.sha256'},review={id:'merge_file.import_id',hash:'merge_file.import_hash',targetRevision:'merge_file.revision',now:'merge_file.now'};
  const generation=attachmentGenerationSql(fields,review);
  const sql="WITH merge_file AS MATERIALIZED(SELECT ? owner,? id,? storage_key,? bytes,? sha256,? import_id,? import_hash,? revision,? now), "+
  "merge_owned_object AS MATERIALIZED(SELECT 1 FROM merge_file JOIN attachment_blob_objects o ON (o.user_id,o.storage_key,o.attachment_id,o.bytes,o.sha256)=(merge_file.owner,merge_file.storage_key,merge_file.id,merge_file.bytes,merge_file.sha256) WHERE o.verified_at IS NOT NULL AND julianday(o.verified_at) IS NOT NULL AND julianday(o.verified_at)<=julianday(merge_file.now) AND o.purged_at IS NULL), "+
  "merge_base AS MATERIALIZED(SELECT 1 FROM merge_file JOIN workspace_source_namespaces n ON n.user_id=merge_file.owner WHERE merge_file.storage_key='attachments/'||n.blob_namespace||'/'||merge_file.id AND NOT EXISTS(SELECT 1 FROM attachment_blob_fences f WHERE f.storage_key=merge_file.storage_key OR (f.user_id=merge_file.owner AND f.attachment_id=merge_file.id)) AND NOT EXISTS(SELECT 1 FROM attachment_upload_attempts a WHERE a.user_id=merge_file.owner AND a.attachment_id=merge_file.id AND a.settled_at IS NULL) AND NOT EXISTS(SELECT 1 FROM attachment_archive_cleanup_claims c WHERE c.storage_key=merge_file.storage_key)), "+
  "merge_generation AS MATERIALIZED(SELECT 1 FROM merge_file WHERE "+generation+") "+
  "INSERT INTO workspace_assertions(user_id,mutation_id,valid) SELECT ?,?,CASE WHEN EXISTS(SELECT 1 FROM merge_owned_object) AND (EXISTS(SELECT 1 FROM merge_base) OR EXISTS(SELECT 1 FROM merge_generation)) THEN 1 ELSE 0 END WHERE "+claim;
  return db.prepare(sql).bind(owner,proof.id,proof.storageKey,proof.bytes,proof.sha256,source.id,source.hash,revision,now,owner,mutationId,...guard);
 });
}
