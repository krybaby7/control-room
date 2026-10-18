import {z} from 'zod';
import {canonical,contentHash} from '../canonical-json.ts';
import {canonicalJsonValue} from '../audit-events.ts';
import {devicePrincipalSchema} from '../devices/validation.ts';
import {deviceAuthorityGuard} from '../devices/auth.ts';
import type {DevicePrincipal} from '../devices/contracts.ts';
import {evidenceDateSchema} from '../evidence-validation.ts';
import type {SqlDatabase,SqlStatement} from '../workspace-store.ts';
import type {AuditEventDraft} from '../workspace-protocol.ts';
import {readOperationalWatermarks} from '../operational-watermarks.ts';
import {recoverabilityAssertions,RecoverabilityCapacityError} from '../recoverability-admission.ts';
import type {ProspectiveRecoverabilityInput} from '../recoverability-snapshot.ts';
import {normalizeEvaluationSummary,validateEvaluationObservation,type EvaluationRunObservation} from './evaluation-import.ts';
export const evaluationUploadSchema=z.object({schemaVersion:z.literal(1),sourceFormatVersion:z.literal(1),sourceInstance:z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),version:z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/),runs:z.array(z.unknown()).max(200)}).strict();
export type EvaluationUpload=z.infer<typeof evaluationUploadSchema>;
export type EvaluationCommitResult={status:'committed'|'replayed'|'unchanged';batchId:string;observationIds:string[];inserted:number}|{status:'conflict'};
interface Stored {id:string;row_revision:number;payload_json:string;content_hash:string}
const sameOutcome=(left:EvaluationRunObservation,right:EvaluationRunObservation)=>{const {observedAt:leftAt,...a}=left,{observedAt:rightAt,...b}=right;void leftAt;void rightAt;return canonical(a)===canonical(b);};
/** An authenticated device summary appends historical source claims only. It
 * never schedules Lab work, changes planning, accepts a task, or grants access.
 */
export async function commitEvaluationSummary(db:SqlDatabase,rawPrincipal:DevicePrincipal,untrusted:EvaluationUpload,now:string):Promise<EvaluationCommitResult>{
 const principal=devicePrincipalSchema.parse(rawPrincipal),upload=evaluationUploadSchema.parse(untrusted);evidenceDateSchema.parse(now);
 if(!principal.scopes.includes('evaluations:write'))throw new Error('Evaluation scope is required.');
 if(new TextEncoder().encode(canonical(upload)).byteLength>65536)throw new Error('Evaluation request exceeds sixty-four KiB.');
 const authority=await deviceAuthorityGuard(db,principal,now);if(!authority)return {status:'conflict'};
 const epochRow=await db.prepare('SELECT epoch FROM workspace_execution_state WHERE user_id=?').bind(principal.ownerId).first<{epoch:number}>(),executionEpoch=epochRow?.epoch??0;if(!Number.isSafeInteger(executionEpoch)||executionEpoch<0)throw new Error('Evaluation execution boundary differs.');
 const candidates=await normalizeEvaluationSummary({version:upload.version,runs:upload.runs},{ownerId:principal.ownerId,deviceId:principal.deviceId,sourceInstance:upload.sourceInstance,observedAt:now,sourceFormatVersion:1});
 const batchHash=await contentHash(canonical({ownerId:principal.ownerId,deviceId:principal.deviceId,sourceInstance:upload.sourceInstance,executionEpoch,outcomes:candidates.map(row=>[row.identityKey,row.outcomeHash])})),batchId='evaluation_batch_'+batchHash;
 const replay=async():Promise<EvaluationCommitResult|null>=>{
  if(!await deviceAuthorityGuard(db,principal,now))return {status:'conflict'};
  const row=await db.prepare("SELECT payload_json FROM audit_events WHERE user_id=? AND event_id=? AND kind='agent.evaluations.imported' AND stream_id='agents'").bind(principal.ownerId,batchId).first<{payload_json:string}>();if(!row)return null;
  const event=JSON.parse(row.payload_json),summary=event.changes?.[0]?.after?.value;
  if(summary?.batchHash!==batchHash||summary.deviceId!==principal.deviceId||summary.sourceInstance!==upload.sourceInstance||canonical(summary.observationIds)!==canonical(candidates.map(value=>value.id))||!Number.isSafeInteger(summary.inserted)||summary.inserted<0||summary.inserted>candidates.length)throw new Error('Evaluation receipt differs.');
  for(const candidate of candidates){const stored=await db.prepare('SELECT payload_json,content_hash FROM evaluation_runs WHERE user_id=? AND id=?').bind(principal.ownerId,candidate.id).first<{payload_json:string;content_hash:string}>();if(!stored)return null;const value=await validateEvaluationObservation(JSON.parse(stored.payload_json));if(await contentHash(canonical(value))!==stored.content_hash||!sameOutcome(value,candidate))throw new Error('Evaluation replay data differs.');}
  return {status:'replayed',batchId,observationIds:summary.observationIds,inserted:summary.inserted};
 };
 const prior=await replay();if(prior)return prior;
 const additions:EvaluationRunObservation[]=[],existing:Stored[]=[];
 for(const candidate of candidates){
  const row=await db.prepare('SELECT id,row_revision,payload_json,content_hash FROM evaluation_runs WHERE user_id=? AND id=?').bind(principal.ownerId,candidate.id).first<Stored>();
  if(!row){additions.push(candidate);continue;}
  const value=await validateEvaluationObservation(JSON.parse(row.payload_json));if(row.id!==value.id||!Number.isSafeInteger(row.row_revision)||row.row_revision<1||await contentHash(canonical(value))!==row.content_hash||!sameOutcome(value,candidate))throw new Error('Immutable evaluation observation differs.');existing.push(row);
 }
 if(!additions.length)return {status:'unchanged',batchId,observationIds:candidates.map(row=>row.id),inserted:0};
 const stream=await db.prepare("SELECT revision,last_sequence FROM operational_stream_heads WHERE user_id=? AND stream_id='agents'").bind(principal.ownerId).first<{revision:number;last_sequence:number}>();
 if(stream&&(!Number.isSafeInteger(stream.revision)||stream.revision<1||!Number.isSafeInteger(stream.last_sequence)||stream.last_sequence<0))throw new Error('Agent stream boundary differs.');
 const sequence=(stream?.last_sequence??0)+1;if(!Number.isSafeInteger(sequence)||stream&&!Number.isSafeInteger(stream.revision+1))throw new Error('Agent stream capacity reached.');
 const token=crypto.randomUUID(),guard='EXISTS(SELECT 1 FROM workspace_command_guards WHERE user_id=? AND mutation_id=? AND claim_token=? AND valid=1)',binds=[principal.ownerId,batchId,token],statements:SqlStatement[]=[];
 statements.push(db.prepare('WITH evaluation_authority AS MATERIALIZED(SELECT 1 WHERE '+authority.sql+') INSERT INTO workspace_command_guards(user_id,mutation_id,claim_token,valid) SELECT ?,?,?,1 WHERE EXISTS(SELECT 1 FROM evaluation_authority) AND NOT EXISTS(SELECT 1 FROM audit_events WHERE user_id=? AND event_id=?)').bind(...authority.bindings,...binds,principal.ownerId,batchId));
 const assert=(sql:string,values:(string|number|null)[])=>statements.push(db.prepare('INSERT INTO workspace_assertions(user_id,mutation_id,valid) SELECT ?,?,CASE WHEN '+sql+' THEN 1 ELSE 0 END WHERE '+guard).bind(principal.ownerId,batchId,...values,...binds));
 if(stream)assert("EXISTS(SELECT 1 FROM operational_stream_heads WHERE user_id=? AND stream_id='agents' AND revision=? AND last_sequence=?)",[principal.ownerId,stream.revision,stream.last_sequence]);else assert("NOT EXISTS(SELECT 1 FROM operational_stream_heads WHERE user_id=? AND stream_id='agents')",[principal.ownerId]);
 for(const row of existing)assert('EXISTS(SELECT 1 FROM evaluation_runs WHERE user_id=? AND id=? AND row_revision=? AND content_hash=? AND payload_json=?)',[principal.ownerId,row.id,row.row_revision,row.content_hash,row.payload_json]);
 const operationalWrites:NonNullable<ProspectiveRecoverabilityInput['operationalWrites']>=[];
 for(const value of additions){
  assert('NOT EXISTS(SELECT 1 FROM evaluation_runs WHERE user_id=? AND id=?)',[principal.ownerId,value.id]);const payload=canonical(value);
  statements.push(db.prepare('INSERT INTO evaluation_runs(user_id,id,row_revision,payload_json,content_hash,device_id,run_id,observed_at,cohort_hash,stream_sequence) SELECT ?,?,1,?,?,?,?,?,?,? WHERE '+guard).bind(principal.ownerId,value.id,payload,await contentHash(payload),value.deviceId,value.runId,value.observedAt,value.cohortHash,sequence,...binds));
  operationalWrites.push({table:'evaluation_runs',value:canonicalJsonValue(value),streamSequence:sequence});
 }
 const summary={batchHash,deviceId:principal.deviceId,sourceInstance:upload.sourceInstance,observationIds:candidates.map(row=>row.id),inserted:additions.length};
 const event:AuditEventDraft={id:batchId,kind:'agent.evaluations.imported',entityType:'agent-evaluation',entityId:null,changes:[{path:['evaluations'],before:{exists:false,value:null},after:{exists:true,value:summary}}],origin:'connector',actorId:'device-evaluations',occurredAt:now,sourceRef:batchHash,undoOf:null};
 statements.push(db.prepare("INSERT INTO audit_events(user_id,event_id,workspace_revision,ordinal,stream_id,stream_sequence,kind,entity_type,entity_id,occurred_at,payload_json,origin,actor_id,source_ref,undo_of) SELECT ?,?,NULL,NULL,'agents',?,'agent.evaluations.imported','agent-evaluation',NULL,?,?,'connector','device-evaluations',?,NULL WHERE "+guard).bind(principal.ownerId,batchId,sequence,now,canonical(event),batchHash,...binds));
 statements.push(db.prepare("INSERT INTO operational_stream_heads(user_id,stream_id,revision,last_sequence) SELECT ?,'agents',1,? WHERE "+guard+" ON CONFLICT(user_id,stream_id) DO UPDATE SET revision=revision+1,last_sequence=excluded.last_sequence").bind(principal.ownerId,sequence,...binds));
 statements.push(db.prepare('DELETE FROM workspace_assertions WHERE user_id=? AND mutation_id=?').bind(principal.ownerId,batchId),db.prepare('DELETE FROM workspace_command_guards WHERE user_id=? AND mutation_id=? AND claim_token=?').bind(...binds));
 const watermarks=await readOperationalWatermarks(db,principal.ownerId),{measureProspectiveRecoverability}=await import('../recoverability-snapshot.ts');
 const quote=await measureProspectiveRecoverability(db,principal.ownerId,{now,operationalWrites,operationalEvents:[{event,streamId:'agents',sequence}],operationalWatermarksAfter:{...watermarks,agents:sequence}});
 if(!quote.measurement.allowed)throw new RecoverabilityCapacityError();
 // Every exact prestate/vector/normalized-rowset assertion precedes our inserts.
 statements.splice(1,0,...recoverabilityAssertions(db,principal.ownerId,batchId,quote,guard,binds));
 try{const result=await db.batch(statements);if(result[0]?.meta.changes!==1)return await replay()??{status:'conflict'};return {status:'committed',batchId,observationIds:summary.observationIds,inserted:additions.length};}
 catch(error){const applied=await replay();if(applied)return applied;throw error;}
}
