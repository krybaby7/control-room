import {z} from 'zod';
import type {SqlDatabase} from '../workspace-store.ts';
import type {ModuleRow} from '../workspace-modules.ts';
import type {AttachmentRecord} from '../evidence-contract.ts';
import type {DevicePrincipal} from '../devices/contracts.ts';
import {deviceAuthorityGuard,type DeviceSqlGuard} from '../devices/auth.ts';
import {canonical,contentHash} from '../canonical-json.ts';
import {evidenceDateSchema} from '../evidence-validation.ts';
import {attachmentRecordSchema} from '../evidence-module.ts';
import {agentIdSchema,agentDigestSchema,agentApprovalEnvelopeSchema,type AgentJobRecordV1,type AgentExecutionBindingV1} from './contracts.ts';
import {validateAgentJobRecord,validateAgentApprovalEnvelope} from './policy.ts';
import {agentFrozenAdmissionSchema} from './store.ts';
import {agentArtifactTypeSchema,AGENT_ARTIFACT_LIMITS,type AgentArtifactType} from './artifacts.ts';
export interface AgentArtifactMaterial {attemptId:string;logicalType:AgentArtifactType;sha256:string;bytes:number;guard:DeviceSqlGuard}
export class AgentArtifactStoreError extends Error {readonly status:number;readonly code:string;constructor(code:string,status=409){super('Private agent artifact is unavailable.');this.name='AgentArtifactStoreError';this.code=code;this.status=status;}}
const leaseSchema=z.object({attemptId:agentIdSchema,leaseToken:z.string().regex(/^[a-f0-9]{64}$/u)}).strict();
type Row=Record<string,string|number|null>;
const text=(row:Row,key:string)=>{const value=row[key];if(typeof value!=='string')throw new AgentArtifactStoreError('stored_identity_invalid');return value;};
const number=(row:Row,key:string)=>{const value=row[key];if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)throw new AgentArtifactStoreError('stored_identity_invalid');return value;};
const positive=(row:Row,key:string)=>{const value=number(row,key);if(value<1)throw new AgentArtifactStoreError('stored_identity_invalid');return value;};
const fail=(code:string,status=409):never=>{throw new AgentArtifactStoreError(code,status);};
export interface AgentArtifactAuthorization {attemptId:string;record:AgentJobRecordV1;binding:AgentExecutionBindingV1;guard:DeviceSqlGuard}
/** Private authentication is performed by HTTP first. This read creates the exact
 * current owner/device/attempt SQL proof that the later write must assert atomically. */
export async function authorizeAgentArtifactAttempt(db:SqlDatabase,principal:DevicePrincipal,raw:unknown,now:string):Promise<AgentArtifactAuthorization>{
 const input=leaseSchema.parse(raw);evidenceDateSchema.parse(now);
 if(!principal.scopes.includes('jobs:poll')||!principal.scopes.includes('jobs:report'))fail('device_scope_unavailable',403);
 const auth=await deviceAuthorityGuard(db,principal,now);if(!auth)fail('device_authority_unavailable',401);
 const row=await db.prepare(`SELECT a.*,s.operational_revision state_revision,s.status state_status,s.spec_hash state_spec_hash,s.task_hash state_task_hash,s.cancel_requested_at state_cancel,s.device_id state_device,s.approval_id state_approval,s.execution_epoch state_epoch,s.attempt_id state_attempt,j.intent_id job_intent,s.intent_id state_intent,j.row_revision job_revision,j.payload_json job_payload,j.content_hash job_hash,i.payload_json intent_payload,i.status intent_status,i.execution_epoch intent_epoch,i.cancel_requested intent_cancel,sl.reserved_at slot_reserved,sl.released_at slot_released,p.payload_json approval_payload,p.binding_hash approval_binding_hash,p.spec_hash approval_spec_hash,p.consumed_at approval_consumed,p.revoked_at approval_revoked,p.expires_at approval_expires FROM job_attempts a JOIN agent_job_state s ON s.user_id=a.user_id AND s.job_id=a.job_id JOIN agent_jobs j ON j.user_id=a.user_id AND j.id=a.job_id JOIN workspace_job_intents i ON i.user_id=a.user_id AND i.id=j.intent_id JOIN agent_device_slots sl ON sl.user_id=a.user_id AND sl.device_id=a.device_id AND sl.attempt_id=a.id JOIN job_approvals p ON p.user_id=a.user_id AND p.id=a.approval_id AND p.job_id=a.job_id AND p.device_id=a.device_id WHERE a.user_id=? AND a.id=? AND a.device_id=?`).bind(principal.ownerId,input.attemptId,principal.deviceId).first<Row>();
 if(!row||row.lease_token_hash!==await contentHash(input.leaseToken))fail('attempt_unavailable',404);
 const epoch=await db.prepare('SELECT epoch FROM workspace_execution_state WHERE user_id=?').bind(principal.ownerId).first<{epoch:number}>();
 const currentEpoch=epoch?.epoch??0;
 if(number(row,'execution_epoch')!==currentEpoch||row.state_epoch!==currentEpoch||row.intent_epoch!==currentEpoch||row.state_device!==principal.deviceId||row.state_attempt!==input.attemptId||row.state_approval!==row.approval_id||!['leased','running'].includes(text(row,'state_status'))||row.state_cancel!==null||row.intent_status!=='running'||row.intent_cancel!==0||row.slot_released!==null||row.result_json!==null||row.reconciled_at!==null||row.approval_revoked!==null||row.approval_consumed===null)fail('attempt_not_current');
 for(const key of ['lease_expires_at','deadline_at'])if(Date.parse(evidenceDateSchema.parse(row[key]))<=Date.parse(now))fail('attempt_expired');
 if(Date.parse(evidenceDateSchema.parse(row.approval_consumed))>Date.parse(now))fail('approval_identity_invalid');
 let identity:{record:AgentJobRecordV1;executionBinding:AgentExecutionBindingV1;approvalEnvelope:unknown;taskInput:unknown;frozenAdmission:unknown};
 if(new TextEncoder().encode(text(row,'identity_json')).byteLength>524288)fail('stored_identity_invalid');
 try{identity=JSON.parse(text(row,'identity_json')) as typeof identity;}catch{fail('stored_identity_invalid');}
 const frozen=agentFrozenAdmissionSchema.parse(identity.frozenAdmission);
 const originalEnvelope=agentApprovalEnvelopeSchema.parse(identity.approvalEnvelope);if(Date.parse(originalEnvelope.approval.approvedAt)>Date.parse(now))fail('approval_identity_invalid');
 const record=await validateAgentJobRecord(identity.record),envelope=await validateAgentApprovalEnvelope(record.spec,originalEnvelope,originalEnvelope.approval.approvedAt),binding=envelope.executionBinding;
 if(frozen.ownerContextHash!==await contentHash(principal.ownerId)||canonical(frozen.artifactRefs)!==canonical(binding.artifactRefs)||await contentHash(canonical(identity.taskInput))!==record.spec.taskSnapshotSha256||record.historical||record.id!==row.job_id||record.intentId!==row.job_intent||row.state_intent!==row.job_intent||canonical(record)!==row.job_payload||await contentHash(canonical(record))!==row.job_hash||canonical(binding)!==canonical(identity.executionBinding)||canonical(envelope)!==row.approval_payload||envelope.approval.origin!=='native-owner'||envelope.approverId!==principal.ownerId||envelope.approval.id!==row.approval_id||envelope.approval.deviceId!==principal.deviceId||envelope.approval.jobId!==record.id||envelope.bindingSha256!==row.approval_binding_hash||record.specSha256!==row.approval_spec_hash||record.specSha256!==row.state_spec_hash||record.spec.taskSnapshotSha256!==row.state_task_hash||canonical({jobId:record.id,specSha256:record.specSha256})!==row.intent_payload)fail('native_binding_differs');
 const clauses=[
  'a.user_id=?','a.id=?','a.device_id=?','a.lease_token_hash=?','a.operational_revision=?','a.execution_epoch=?','a.identity_json=?','a.lease_expires_at=?','a.deadline_at=?','a.result_json IS NULL','a.reconciled_at IS NULL','a.execution_epoch=COALESCE((SELECT epoch FROM workspace_execution_state WHERE user_id=a.user_id),0)','julianday(a.lease_expires_at)>julianday(?)','julianday(a.deadline_at)>julianday(?)',
  's.intent_id=j.intent_id','s.operational_revision=?','s.status=?','s.spec_hash=?','s.task_hash=?','s.device_id=a.device_id','s.approval_id=a.approval_id','s.attempt_id=a.id','s.execution_epoch=a.execution_epoch','s.cancel_requested_at IS NULL',
  'j.row_revision=?','j.content_hash=?','j.payload_json=?','i.kind=\'agent.execute\'','i.payload_json=?','i.status=\'running\'','i.execution_epoch=a.execution_epoch','i.cancel_requested=0',
  'sl.attempt_id=a.id','sl.released_at IS NULL','sl.reserved_at=?','p.payload_json=?','p.binding_hash=?','p.spec_hash=?','p.consumed_at=?','p.revoked_at IS NULL','p.expires_at=?'
 ];
 const guard:DeviceSqlGuard={sql:'('+auth.sql+') AND EXISTS(SELECT 1 FROM job_attempts a JOIN agent_job_state s ON s.user_id=a.user_id AND s.job_id=a.job_id JOIN agent_jobs j ON j.user_id=a.user_id AND j.id=a.job_id JOIN workspace_job_intents i ON i.user_id=a.user_id AND i.id=j.intent_id JOIN agent_device_slots sl ON sl.user_id=a.user_id AND sl.device_id=a.device_id JOIN job_approvals p ON p.user_id=a.user_id AND p.id=a.approval_id AND p.job_id=a.job_id AND p.device_id=a.device_id WHERE '+clauses.join(' AND ')+')',bindings:[...auth.bindings,principal.ownerId,input.attemptId,principal.deviceId,row.lease_token_hash,positive(row,'operational_revision'),currentEpoch,row.identity_json,row.lease_expires_at,row.deadline_at,now,now,positive(row,'state_revision'),row.state_status,row.state_spec_hash,row.state_task_hash,positive(row,'job_revision'),row.job_hash,row.job_payload,row.intent_payload,row.slot_reserved,row.approval_payload,row.approval_binding_hash,row.approval_spec_hash,row.approval_consumed,row.approval_expires]};
 if(!await db.prepare('SELECT 1 WHERE '+guard.sql).bind(...guard.bindings).first())fail('attempt_changed');
 return {attemptId:input.attemptId,record,binding,guard};
}
const storedBinding=z.object({artifact_id:z.string().uuid(),logical_type:agentArtifactTypeSchema,sha256:agentDigestSchema,bytes:z.number().int().nonnegative().max(AGENT_ARTIFACT_LIMITS.packageBytes),created_at:evidenceDateSchema}).strict().refine(row=>row.logical_type!=='transcript'||row.bytes<=AGENT_ARTIFACT_LIMITS.transcriptBytes);
export interface OwnedAgentArtifact {authorization:AgentArtifactAuthorization;material:AgentArtifactMaterial;row:ModuleRow;attachment:AttachmentRecord}
export async function readOwnedAgentArtifact(db:SqlDatabase,principal:DevicePrincipal,lease:unknown,artifactId:string,now:string):Promise<OwnedAgentArtifact>{
 z.string().uuid().parse(artifactId);const authorization=await authorizeAgentArtifactAttempt(db,principal,lease,now);
 const rawBinding=await db.prepare('SELECT artifact_id,logical_type,sha256,bytes,created_at FROM agent_artifacts WHERE user_id=? AND attempt_id=? AND artifact_id=?').bind(principal.ownerId,authorization.attemptId,artifactId).first();if(!rawBinding)fail('artifact_unavailable',404);const binding=storedBinding.parse(rawBinding);
 const row=await db.prepare('SELECT id,row_revision,payload_json,content_hash FROM attachments WHERE user_id=? AND id=?').bind(principal.ownerId,artifactId).first<ModuleRow>();if(!row)fail('artifact_unavailable',404);
 if(!Number.isSafeInteger(row.row_revision)||row.row_revision<1)fail('artifact_binding_differs');const attachment=attachmentRecordSchema.parse(JSON.parse(row.payload_json));if(attachment.id!==artifactId||await contentHash(canonical(attachment))!==row.content_hash||!['reserved','ready'].includes(attachment.status)||attachment.expectedBytes!==binding.bytes||attachment.status==='ready'&&(attachment.actualBytes!==binding.bytes||attachment.sha256!==binding.sha256))fail('artifact_binding_differs');
 const guard:DeviceSqlGuard={sql:'('+authorization.guard.sql+') AND EXISTS(SELECT 1 FROM agent_artifacts b WHERE b.user_id=? AND b.attempt_id=? AND b.artifact_id=? AND b.logical_type=? AND b.sha256=? AND b.bytes=? AND b.created_at=?) AND EXISTS(SELECT 1 FROM attachments a WHERE a.user_id=? AND a.id=? AND a.row_revision=? AND a.content_hash=? AND a.payload_json=?)',bindings:[...authorization.guard.bindings,principal.ownerId,authorization.attemptId,artifactId,binding.logical_type,binding.sha256,binding.bytes,binding.created_at,principal.ownerId,artifactId,row.row_revision,row.content_hash,row.payload_json]};
 if(!await db.prepare('SELECT 1 WHERE '+guard.sql).bind(...guard.bindings).first())fail('artifact_changed');
 return {authorization,material:{attemptId:authorization.attemptId,logicalType:binding.logical_type,sha256:binding.sha256,bytes:binding.bytes,guard},row,attachment};
}

/** Read-only UX classification; the compiler must still assert count/bytes atomically. */
export async function assertAgentArtifactReservationCapacity(db:SqlDatabase,ownerId:string,attemptId:string,bytes:number,mutationId:string):Promise<void>{
 agentIdSchema.parse(attemptId);z.number().int().nonnegative().max(AGENT_ARTIFACT_LIMITS.packageBytes).parse(bytes);
 const quota=await db.prepare('SELECT COUNT(*) files,COALESCE(SUM(bytes),0) bytes,EXISTS(SELECT 1 FROM workspace_mutations m WHERE m.user_id=? AND m.mutation_id=?) replay FROM agent_artifacts WHERE user_id=? AND attempt_id=?').bind(ownerId,mutationId,ownerId,attemptId).first<{files:number;bytes:number;replay:number}>();
 if(!quota||!Number.isSafeInteger(quota.files)||quota.files<0||!Number.isSafeInteger(quota.bytes)||quota.bytes<0)fail('artifact_quota_unavailable',503);
 if(quota.replay===1)return; // Existing receipt is hash-checked by the central executor; no new reservation is admitted.
 if(quota.files>=AGENT_ARTIFACT_LIMITS.count||quota.bytes+bytes>AGENT_ARTIFACT_LIMITS.packageBytes)fail('artifact_capacity',409);
}
