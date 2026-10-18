import {z} from 'zod';
import type {SqlDatabase,SqlStatement} from '../workspace-store.ts';
import {readCurrent} from '../workspace-store.ts';
import {OWNER_TABLES} from '../workspace-modules.ts';
import {canonical,contentHash} from '../canonical-json.ts';
import {evidenceDateSchema} from '../evidence-validation.ts';
import {deviceAuthorityGuard,type DeviceSqlGuard} from '../devices/auth.ts';
import type {DevicePrincipal} from '../devices/contracts.ts';
import type {AgentCommandContext} from './command-contracts.ts';
import {AGENT_LIMITS,agentIdSchema,agentCapabilitySchema,agentApprovalEnvelopeSchema,agentJobEventSchema,agentJobResultSchema,type AgentJobRecordV1,type AgentApprovalEnvelopeV1,type AgentExecutionBindingV1,type AgentJobResultV1,type AgentJobEventV1} from './contracts.ts';
import {validateAgentJobRecord,validateAgentApprovalEnvelope,validateAgentExecutionBinding,agentTaskSemanticProjection,parseAgentEventBatch,validateAgentDependencyGraph,validateAgentResult} from './policy.ts';
import {measureProspectiveRecoverability} from '../recoverability-snapshot.ts';
import {recoverabilityAssertions} from '../recoverability-admission.ts';
import {readOperationalWatermarks} from '../operational-watermarks.ts';
import {parseAuditEvent} from '../audit-events.ts';
import type {JsonValue} from '../workspace-protocol.ts';

type Bind=string|number|null;
type Row=Record<string,Bind>;
export class AgentStoreError extends Error {readonly status:number;constructor(code:string,status=409){super(code);this.name='AgentStoreError';this.status=status;}}
export interface AgentLease {attemptId:string;jobId:string;executionEpoch:number;leaseToken:string;leaseExpiresAt:string;deadlineAt:string;operationalRevision:number;record:AgentJobRecordV1;executionBinding:AgentExecutionBindingV1;approvalEnvelope:AgentApprovalEnvelopeV1;taskInput:JsonValue;serverNow:string;resumed:boolean}
export interface AgentEventReceipt {attemptId:string;epoch:number;sequence:number;payloadSha256:string;receivedAt:string}
export interface AgentStoreOptions {
 now:string;context:AgentCommandContext;
 /** Trusted server resolver only; never map a request boolean into this callback. */
 verifyResult?:(input:{principal:DevicePrincipal;record:AgentJobRecordV1;attemptId:string;result:AgentJobResultV1;executionBinding:AgentExecutionBindingV1})=>Promise<{adapterChecksPassed:boolean;guard?:DeviceSqlGuard}>;
 verifyNoLaunch?:(input:{principal:DevicePrincipal;attemptId:string;journalNonce:string})=>Promise<DeviceSqlGuard|null>;
}
const leaseInput=z.object({attemptId:agentIdSchema,leaseToken:z.string().regex(/^[a-f0-9]{64}$/u)}).strict();
const claimInput=z.object({jobId:agentIdSchema,journalNonce:z.string().min(32).max(128).regex(/^[A-Za-z0-9_-]+$/u)}).strict();
function all(parts:string[]):string {if(!parts.length)return '1';if(parts.length===1)return parts[0];const m=Math.floor(parts.length/2);return '('+all(parts.slice(0,m))+' AND '+all(parts.slice(m))+')';}
function token(){return Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,'0')).join('');}
function fail(code:string,status=409):never {throw new AgentStoreError(code,status);}
function time(now:string){evidenceDateSchema.parse(now);}
function scope(p:DevicePrincipal){if(!p.scopes.includes('jobs:poll')||!p.scopes.includes('jobs:report'))fail('agent_scopes_required',403);}
function text(row:Row,key:string):string {const value=row[key];if(typeof value!=='string')fail('stored_agent_identity_invalid');return value;}
function integer(row:Row,key:string):number {const value=row[key];if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)fail('stored_agent_counter_invalid');return value;}
async function authority(db:SqlDatabase,p:DevicePrincipal,now:string){scope(p);time(now);const proof=await deviceAuthorityGuard(db,p,now);if(!proof)fail('device_authority_unavailable',401);return proof;}
async function one(db:SqlDatabase,table:string,owner:string,field:string,id:string):Promise<Row|null>{return db.prepare('SELECT * FROM '+table+' WHERE user_id=? AND '+field+'=?').bind(owner,id).first<Row>();}
interface Snapshot {sql:string;bindings:Bind[]}
/** Complete row sets, including payload bytes, guard absent-row insertion races.
 * Table/column identifiers originate only in this closed server implementation. */
async function snapshot(db:SqlDatabase,owner:string,tables:readonly string[]):Promise<Snapshot[]>{
 let bytes=0;const proofs:Snapshot[]=[];
 for(const table of [...new Set(tables)]){
  const rows=(await db.prepare('SELECT * FROM '+table+' WHERE user_id=? LIMIT 10001').bind(owner).all<Row>()).results;
  if(rows.length>10000)fail('agent_snapshot_capacity');
  const serialized=canonical(rows);bytes+=new TextEncoder().encode(serialized).length;if(bytes>8000000||new TextEncoder().encode(serialized).length>1800000)fail('agent_snapshot_capacity');
  if(!rows.length){proofs.push({sql:'NOT EXISTS(SELECT 1 FROM '+table+' WHERE user_id=?)',bindings:[owner]});continue;}
  const keys=Object.keys(rows[0]).sort();if(keys.some(k=>!/^[a-z_]+$/u.test(k)))fail('invalid_server_schema');
  const left=keys.map(k=>'"'+k+'"').join(','),right=keys.map(k=>"json_extract(value,'$."+k+"')").join(',');
  proofs.push({sql:'(SELECT COUNT(*) FROM '+table+' WHERE user_id=?)=? AND NOT EXISTS(SELECT '+left+' FROM '+table+' WHERE user_id=? EXCEPT SELECT '+right+' FROM json_each(?))',bindings:[owner,rows.length,owner,serialized]});
 }
 return proofs;
}
const privateSnapshots=['attachment_blob_objects','attachment_blob_fences','attachment_blob_namespaces','attachment_archive_stages','job_events','agent_job_state','job_approvals','job_attempts','agent_device_slots','agent_budgets','agent_capabilities','workspace_job_intents','acceptance_owner_grants','decision_owner_grants'] as const;
async function atomic(db:SqlDatabase,p:DevicePrincipal,guard:DeviceSqlGuard,proofs:Snapshot[],build:(gate:string,bindings:Bind[],id:string)=>SqlStatement[]):Promise<boolean>{
 const id=crypto.randomUUID(),secret=crypto.randomUUID(),binds:Bind[]=[p.ownerId,id,secret],gate='EXISTS(SELECT 1 FROM agent_protocol_claims WHERE user_id=? AND id=? AND claim_token=?)';
 const statements=[db.prepare('WITH authorized AS MATERIALIZED(SELECT 1 WHERE '+guard.sql+') INSERT INTO agent_protocol_claims(user_id,id,claim_token,created_at) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM authorized)').bind(...guard.bindings,...binds,new Date().toISOString())];
 for(const proof of proofs)statements.push(db.prepare('INSERT INTO workspace_assertions(user_id,mutation_id,valid) SELECT ?,?,CASE WHEN '+proof.sql+' THEN 1 ELSE 0 END WHERE '+gate).bind(p.ownerId,id,...proof.bindings,...binds));
 statements.push(...build(gate,binds,id),db.prepare('DELETE FROM workspace_assertions WHERE user_id=? AND mutation_id=?').bind(p.ownerId,id),db.prepare('DELETE FROM agent_protocol_claims WHERE user_id=? AND id=? AND claim_token=?').bind(...binds));
 try{return (await db.batch(statements))[0]?.meta.changes===1;}catch{throw new AgentStoreError('agent_atomic_conflict');}
}
async function active(db:SqlDatabase,p:DevicePrincipal,jobId:string,options:AgentStoreOptions,full=true){
 const auth=await authority(db,p,options.now),proofs=await snapshot(db,p.ownerId,full?[...OWNER_TABLES,...privateSnapshots]:privateSnapshots);
 const raw=await one(db,'agent_jobs',p.ownerId,'id',jobId),state=await one(db,'agent_job_state',p.ownerId,'job_id',jobId);
 if(!raw||!state)fail('owner_job_unavailable');
 const execution=await db.prepare('SELECT epoch FROM workspace_execution_state WHERE user_id=?').bind(p.ownerId).first<{epoch:number}>();if(state.execution_epoch!==(execution?.epoch??0))fail('job_execution_epoch_retired');
 const record=await validateAgentJobRecord(JSON.parse(text(raw,'payload_json')));if(record.id!==jobId||record.historical||await contentHash(canonical(record))!==raw.content_hash||raw.spec_hash!==record.specSha256||state.spec_hash!==record.specSha256||state.task_hash!==record.spec.taskSnapshotSha256||state.intent_id!==record.intentId)fail('job_identity_differs');
 const workspace=await db.prepare('SELECT content,revision,updated_at FROM workspaces WHERE user_id=?').bind(p.ownerId).first<Row>();if(!workspace)fail('owner_workspace_unavailable');
 proofs.push({sql:'EXISTS(SELECT 1 FROM workspaces WHERE user_id=? AND content=? AND revision=? AND updated_at=?)',bindings:[p.ownerId,workspace.content,workspace.revision,workspace.updated_at]});
 const current=await readCurrent(db,p.ownerId,options.now),task=current.workspace.tasks.find(t=>t.id===record.spec.taskId),project=current.workspace.projects.find(v=>v.id===record.spec.projectId);
 if(current.revision!==workspace.revision||!project||project.archivedAt||!task||task.projectId!==project.id||task.status==='archived')fail('approved_task_changed');
 const taskInput=agentTaskSemanticProjection(task,await options.context.taskInputs(task.id));
 if(await contentHash(canonical(taskInput))!==record.spec.taskSnapshotSha256)fail('approved_task_changed');
 const approval=await one(db,'job_approvals',p.ownerId,'id',text(state,'approval_id'));if(!approval||approval.device_id!==p.deviceId||approval.job_id!==jobId||approval.revoked_at!==null)fail('approval_unavailable');
 const envelope=await validateAgentApprovalEnvelope(record.spec,JSON.parse(text(approval,'payload_json')),options.now);
 if(envelope.approval.id!==approval.id||envelope.approval.jobId!==jobId||envelope.approval.deviceId!==p.deviceId||envelope.approverId!==p.ownerId||approval.spec_hash!==record.specSha256||approval.binding_hash!==envelope.bindingSha256||approval.expires_at!==envelope.approval.expiresAt||approval.created_at!==envelope.approval.approvedAt||approval.reserved_seconds!==record.spec.timeoutSeconds)fail('approval_identity_differs');
 const capability=await one(db,'agent_capabilities',p.ownerId,'device_id',p.deviceId);if(!capability||capability.revoked_at!==null)fail('capability_unavailable');
 const cap=agentCapabilitySchema.parse(JSON.parse(text(capability,'payload_json')));
 if(cap.deviceId!==p.deviceId||await contentHash(canonical(cap))!==capability.manifest_hash||capability.manifest_hash!==envelope.approval.capabilitySha256||Date.parse(cap.observedAt)>Date.parse(options.now)||Date.parse(cap.expiresAt)<=Date.parse(options.now)||text(capability,'reported_at')>options.now||Date.parse(options.now)-Date.parse(text(capability,'reported_at'))>AGENT_LIMITS.capabilityMs)fail('capability_stale_or_changed');
 const candidate=await options.context.candidate(record,p.deviceId,envelope.reservationId);
 if(!candidate||candidate.capabilityHash!==envelope.approval.capabilitySha256||candidate.bindingHash!==envelope.bindingSha256||candidate.budgetId!==envelope.reservationId||canonical(candidate.binding)!==canonical(envelope.executionBinding))fail('execution_binding_changed');
 const budget=await one(db,'agent_budgets',p.ownerId,'id',envelope.reservationId);if(!budget||budget.enabled!==1||integer(budget,'reserved_jobs')<1||integer(budget,'reserved_seconds')<record.spec.timeoutSeconds||integer(budget,'reserved_jobs')>integer(budget,'maximum_jobs')||integer(budget,'reserved_seconds')+integer(budget,'charged_seconds')>integer(budget,'maximum_seconds'))fail('finite_budget_unavailable');
 const dependencies=await options.context.dependencies(record),root={id:record.id,ownerId:p.ownerId,dependsOnJobIds:record.spec.dependsOnJobIds,status:'queued' as const};
 for(const entry of dependencies.filter(row=>row.id===record.id))if(entry.ownerId!==p.ownerId||canonical(entry.dependsOnJobIds)!==canonical(root.dependsOnJobIds))fail('dependency_root_identity_differs');
 validateAgentDependencyGraph(record.id,p.ownerId,[...dependencies.filter(row=>row.id!==record.id),root],true);
 const artifacts=await options.context.artifacts(record.spec.inputArtifactIds);if(canonical([...artifacts].sort((a,b)=>a.id.localeCompare(b.id)))!==canonical([...envelope.executionBinding.artifactRefs].sort((a,b)=>a.id.localeCompare(b.id))))fail('input_artifacts_changed');
 if(new TextEncoder().encode(canonical(taskInput)).length+artifacts.reduce((n,row)=>n+row.bytes,0)>envelope.executionBinding.budget.inputBytesLimit)fail('frozen_task_input_capacity');
 const intent=await one(db,'workspace_job_intents',p.ownerId,'id',record.intentId);
 if(!intent||intent.kind!=='agent.execute'||intent.cancel_requested!==0||!['pending','claimed','running'].includes(text(intent,'status'))||intent.execution_epoch!==state.execution_epoch||Date.parse(text(intent,'not_before'))>Date.parse(options.now)||canonical(JSON.parse(text(intent,'payload_json')))!==canonical({jobId:record.id,specSha256:record.specSha256}))fail('job_intent_unavailable');
 return {auth,proofs,record,state,approval,envelope,budget,capability,intent,taskInput};
}
async function lease(a:Row,record:AgentJobRecordV1,binding:AgentExecutionBindingV1,leaseToken:string,resumed:boolean,serverNow:string):Promise<AgentLease>{
 const identity=JSON.parse(text(a,'identity_json')) as {approvalEnvelope:unknown;taskInput:JsonValue;budgetId:string},approvalEnvelope=agentApprovalEnvelopeSchema.parse(identity.approvalEnvelope);
 if(identity.taskInput===undefined||await contentHash(canonical(identity.taskInput))!==record.spec.taskSnapshotSha256||new TextEncoder().encode(canonical(identity.taskInput)).length+binding.artifactRefs.reduce((n,row)=>n+row.bytes,0)>binding.budget.inputBytesLimit||canonical(approvalEnvelope.executionBinding)!==canonical(binding)||approvalEnvelope.approval.jobId!==record.id||approvalEnvelope.approval.deviceId!==a.device_id||approvalEnvelope.approval.specSha256!==record.specSha256||approvalEnvelope.reservationId!==identity.budgetId)fail('frozen_lease_input_differs');
 return {attemptId:text(a,'id'),jobId:record.id,executionEpoch:integer(a,'execution_epoch'),leaseToken,leaseExpiresAt:text(a,'lease_expires_at'),deadlineAt:text(a,'deadline_at'),operationalRevision:integer(a,'operational_revision'),record,executionBinding:binding,approvalEnvelope,taskInput:identity.taskInput,serverNow,resumed};
}
export async function claimAgentJob(db:SqlDatabase,p:DevicePrincipal,raw:unknown,options:AgentStoreOptions):Promise<AgentLease|null>{
 const input=claimInput.parse(raw),auth=await authority(db,p,options.now),recoveryProofs=await snapshot(db,p.ownerId,['job_attempts','agent_job_state','agent_device_slots','workspace_job_intents']),prior=await one(db,'job_attempts',p.ownerId,'job_id',input.jobId),nonce=await contentHash(input.journalNonce),secret=token(),hash=await contentHash(secret);
 if(prior){
  const identity=JSON.parse(text(prior,'identity_json')) as {record:AgentJobRecordV1;executionBinding:AgentExecutionBindingV1},record=await validateAgentJobRecord(identity.record),state=await one(db,'agent_job_state',p.ownerId,'job_id',input.jobId),slot=await one(db,'agent_device_slots',p.ownerId,'device_id',p.deviceId);
  if(!state||!slot||slot.attempt_id!==prior.id||slot.released_at!==null||state.attempt_id!==prior.id||state.cancel_requested_at!==null||record.id!==input.jobId||prior.device_id!==p.deviceId||prior.journal_nonce_hash!==nonce||prior.result_json!==null||prior.reconciled_at!==null||prior.execution_epoch!==state.execution_epoch||!['leased','running'].includes(text(state,'status'))||Date.parse(text(prior,'lease_expires_at'))<=Date.parse(options.now)||Date.parse(text(prior,'deadline_at'))<=Date.parse(options.now))fail('attempt_requires_reconciliation');
  const expires=new Date(Math.min(Date.parse(options.now)+AGENT_LIMITS.leaseMs,Date.parse(text(prior,'deadline_at')))).toISOString();
  const ok=await atomic(db,p,attemptGuard(auth,p,prior,options.now),recoveryProofs,(gate,b)=>[db.prepare('UPDATE job_attempts SET lease_token_hash=?,lease_expires_at=?,operational_revision=operational_revision+1 WHERE user_id=? AND id=? AND '+gate).bind(hash,expires,p.ownerId,prior.id,...b)]);
  if(!ok)return null;return lease({...prior,lease_expires_at:expires,operational_revision:integer(prior,'operational_revision')+1},record,identity.executionBinding,secret,true,options.now);
 }
 const c=await active(db,p,input.jobId,options);
 if(c.state.status!=='queued'||c.state.device_id!==p.deviceId||c.approval.consumed_at!==null||c.state.attempt_id!==null||c.state.cancel_requested_at!==null)fail('queued_approval_unavailable');
 const slot=await one(db,'agent_device_slots',p.ownerId,'device_id',p.deviceId);if(slot&&slot.released_at===null)fail('device_slot_unavailable');
 const id=crypto.randomUUID(),deadline=new Date(Date.parse(options.now)+c.record.spec.timeoutSeconds*1000).toISOString(),expires=new Date(Math.min(Date.parse(options.now)+AGENT_LIMITS.leaseMs,Date.parse(deadline))).toISOString(),identity=canonical({record:c.record,executionBinding:c.envelope.executionBinding,approvalEnvelope:c.envelope,taskInput:c.taskInput,budgetId:c.envelope.reservationId});
 const row:Row={id,job_id:input.jobId,device_id:p.deviceId,approval_id:c.approval.id,execution_epoch:c.state.execution_epoch,journal_nonce_hash:nonce,lease_token_hash:hash,lease_expires_at:expires,deadline_at:deadline,created_at:options.now,launched_at:null,exited_at:null,cancel_acknowledged_at:null,last_applied_sequence:0,operational_revision:1,identity_json:identity,result_json:null,reconciled_at:null};
 const ok=await atomic(db,p,c.auth,c.proofs,(gate,b)=>[
  db.prepare('INSERT INTO job_attempts(user_id,id,job_id,device_id,approval_id,execution_epoch,journal_nonce_hash,lease_token_hash,lease_expires_at,deadline_at,created_at,operational_revision,identity_json) SELECT ?,?,?,?,?,?,?,?,?,?,?,1,? WHERE '+gate).bind(p.ownerId,id,input.jobId,p.deviceId,c.approval.id,c.state.execution_epoch,nonce,hash,expires,deadline,options.now,identity,...b),
  db.prepare('UPDATE job_approvals SET consumed_at=? WHERE user_id=? AND id=? AND '+gate).bind(options.now,p.ownerId,c.approval.id,...b),
  db.prepare('UPDATE agent_job_state SET status=?,attempt_id=?,operational_revision=operational_revision+1,updated_at=? WHERE user_id=? AND job_id=? AND '+gate).bind('leased',id,options.now,p.ownerId,input.jobId,...b),
  db.prepare('UPDATE workspace_job_intents SET status=? WHERE user_id=? AND id=? AND '+gate).bind('running',p.ownerId,c.record.intentId,...b),
  db.prepare('INSERT INTO agent_device_slots(user_id,device_id,attempt_id,reserved_at,released_at) SELECT ?,?,?,?,NULL WHERE '+gate+' ON CONFLICT(user_id,device_id) DO UPDATE SET attempt_id=excluded.attempt_id,reserved_at=excluded.reserved_at,released_at=NULL').bind(p.ownerId,p.deviceId,id,options.now,...b)
 ]);
 return ok?lease(row,c.record,c.envelope.executionBinding,secret,false,options.now):null;
}
async function ownedAttempt(db:SqlDatabase,p:DevicePrincipal,input:{attemptId:string;leaseToken:string},now:string,allowExpired=false){
 const auth=await authority(db,p,now),attempt=await one(db,'job_attempts',p.ownerId,'id',input.attemptId);if(!attempt||attempt.device_id!==p.deviceId||attempt.lease_token_hash!==await contentHash(input.leaseToken))fail('attempt_lease_unavailable',403);
 const epoch=await db.prepare('SELECT epoch FROM workspace_execution_state WHERE user_id=?').bind(p.ownerId).first<{epoch:number}>();
 if(attempt.execution_epoch!==(epoch?.epoch??0))fail('attempt_execution_epoch_retired');
 if(!allowExpired&&(Date.parse(text(attempt,'lease_expires_at'))<=Date.parse(now)||Date.parse(text(attempt,'deadline_at'))<=Date.parse(now)))fail('attempt_requires_reconciliation');
 return {auth,attempt};
}
export async function renewAgentLease(db:SqlDatabase,p:DevicePrincipal,raw:unknown,options:AgentStoreOptions):Promise<AgentLease>{
 const proofs=await snapshot(db,p.ownerId,['job_attempts','agent_job_state','workspace_job_intents']);
 const input=leaseInput.parse(raw),a=await ownedAttempt(db,p,input,options.now),identity=JSON.parse(text(a.attempt,'identity_json')) as {record:AgentJobRecordV1;executionBinding:AgentExecutionBindingV1};
 const record=await validateAgentJobRecord(identity.record),state=await one(db,'agent_job_state',p.ownerId,'job_id',record.id);
 if(!state||state.attempt_id!==a.attempt.id||state.execution_epoch!==a.attempt.execution_epoch||state.cancel_requested_at!==null||!['leased','running'].includes(text(state,'status'))||a.attempt.result_json!==null)fail('attempt_not_renewable');
 const expires=new Date(Math.min(Date.parse(options.now)+AGENT_LIMITS.leaseMs,Date.parse(text(a.attempt,'deadline_at')))).toISOString();
 if(!await atomic(db,p,attemptGuard(a.auth,p,a.attempt,options.now),proofs,(gate,b)=>[db.prepare('UPDATE job_attempts SET lease_expires_at=?,operational_revision=operational_revision+1 WHERE user_id=? AND id=? AND '+gate).bind(expires,p.ownerId,input.attemptId,...b)]))fail('lease_changed');
 return lease({...a.attempt,lease_expires_at:expires,operational_revision:integer(a.attempt,'operational_revision')+1},record,identity.executionBinding,input.leaseToken,true,options.now);
}
function attemptGuard(auth:DeviceSqlGuard,p:DevicePrincipal,a:Row,now:string,allowExpired=false):DeviceSqlGuard{
 const clauses=['user_id=?','id=?','device_id=?','lease_token_hash=?','operational_revision=?','execution_epoch=?'];
 const bindings:Bind[]=[...auth.bindings,p.ownerId,a.id,p.deviceId,a.lease_token_hash,a.operational_revision,a.execution_epoch];
 if(!allowExpired){clauses.push('execution_epoch=COALESCE((SELECT epoch FROM workspace_execution_state WHERE user_id=?),0)');bindings.push(p.ownerId);clauses.push('julianday(lease_expires_at)>julianday(?)','julianday(deadline_at)>julianday(?)');bindings.push(now,now);}
 return {sql:'('+auth.sql+') AND EXISTS(SELECT 1 FROM job_attempts WHERE '+all(clauses)+')',bindings};
}
async function eventsFor(db:SqlDatabase,p:DevicePrincipal,a:Row){
 const rows=(await db.prepare('SELECT * FROM job_events WHERE user_id=? AND attempt_id=? ORDER BY sequence LIMIT 1025').bind(p.ownerId,a.id).all<Row>()).results;if(rows.length>1024)fail('attempt_event_capacity');
 let bytes=0;const events=new Map<number,{row:Row;event:AgentJobEventV1}>();
 for(const row of rows){bytes+=new TextEncoder().encode(text(row,'payload_json')).length;if(bytes>2097152)fail('attempt_event_capacity');const event=agentJobEventSchema.parse(JSON.parse(text(row,'payload_json')));if(event.attemptId!==a.id||event.epoch!==a.execution_epoch||event.sequence!==row.sequence||await contentHash(canonical(event))!==row.payload_hash)fail('stored_event_identity_differs');events.set(event.sequence,{row,event});}
 return events;
}
function protocol(events:Map<number,{row:Row;event:AgentJobEventV1}>,record:AgentJobRecordV1,binding:AgentExecutionBindingV1,attempt:Row,state:Row){
 let accepted=false,started=false,exited=false,completed=false,blocked=false,cancelled=false,identityMismatch=false,exitCode:number|null=null,observedModel:string|null=null,sequence=0;
 const artifactIds=new Set<string>();let resultHash:string|null=null;
 while(events.has(sequence+1)){
  const e=events.get(++sequence)!.event;
  if(completed||blocked)fail('event_after_terminal_protocol');
  if(e.kind==='accepted'){
   if(sequence!==1||accepted||e.details.specSha256!==record.specSha256||e.details.capabilitySha256!==binding.capabilitySha256)fail('accepted_event_identity_differs');accepted=true;
  }else if(e.kind==='started'){
   if(!accepted||started||exited)fail('started_event_outside_process');
   identityMismatch=e.details.runtimePackageSha256!==binding.runtime.packageSha256||e.details.toolPolicySha256!==binding.runtime.toolPolicySha256||e.details.requestedModel!==record.spec.requestedModel||e.details.observedModel!==null&&e.details.observedModel!==record.spec.requestedModel;
   started=true;observedModel=e.details.observedModel;
  }else if(e.kind==='progress'){
   if(!started||exited)fail('progress_outside_process');
  }else if(e.kind==='process_exit'){
   if(!started||exited)fail('process_exit_outside_process');
   exited=e.details.processExitConfirmed&&!e.details.terminationUnconfirmed;exitCode=e.details.exitCode;
   if(!exited&&events.has(sequence+1))fail('process_exit_unconfirmed');
  }else if(e.kind==='cancel_acknowledged'){
   if(!state.cancel_requested_at||e.details.requestId!==state.cancel_request_id||!e.details.exitConfirmed||!exited)fail('cancellation_exit_not_proven');cancelled=true;
  }else if(e.kind==='artifact_ready'){
   if(!accepted||artifactIds.has(e.details.artifactId))fail('artifact_event_identity_differs');artifactIds.add(e.details.artifactId);
  }else if(e.kind==='completed'){
   if(!accepted||!started||!exited)fail('completion_exit_not_proven');completed=true;resultHash=e.details.resultSha256;
  }else if(e.kind==='blocked'){
   if(!accepted||started&&!exited)fail('blocked_process_exit_not_proven');blocked=true;
  }
 }
 return {sequence,accepted,started,exited,completed,blocked,cancelled,identityMismatch,exitCode,observedModel,artifactIds,resultHash};
}
async function persistAgentEvents(db:SqlDatabase,p:DevicePrincipal,raw:unknown,options:AgentStoreOptions,reconciliation?:{attempt:Row;auth:DeviceSqlGuard}):Promise<{receipts:AgentEventReceipt[];lastAppliedSequence:number}>{
 const proofs=await snapshot(db,p.ownerId,['job_attempts','job_events','agent_job_state','workspace_job_intents']);
 const input=z.object({attemptId:agentIdSchema,leaseToken:z.string().regex(/^[a-f0-9]{64}$/u),events:z.unknown()}).strict().parse(raw),a=reconciliation??await ownedAttempt(db,p,input,options.now,true),incoming=parseAgentEventBatch(input.events),events=await eventsFor(db,p,a.attempt),identity=JSON.parse(text(a.attempt,'identity_json')) as {record:AgentJobRecordV1;executionBinding:AgentExecutionBindingV1};
 const record=await validateAgentJobRecord(identity.record),state=await one(db,'agent_job_state',p.ownerId,'job_id',record.id);if(!state||state.attempt_id!==a.attempt.id)fail('attempt_state_unavailable');
 const receipts:AgentEventReceipt[]=[],inserts:Row[]=[];
 for(const event of incoming){
  if(event.attemptId!==a.attempt.id||event.epoch!==a.attempt.execution_epoch||event.sequence>1024)fail('event_attempt_identity_differs');
  const payload=canonical(event),hash=await contentHash(payload),previous=events.get(event.sequence);
  if(previous){if(previous.row.payload_hash!==hash||previous.row.payload_json!==payload)fail('event_sequence_content_conflict');const receipt=JSON.parse(text(previous.row,'receipt_json')) as AgentEventReceipt;if(receipt.payloadSha256!==hash||receipt.sequence!==event.sequence||receipt.attemptId!==event.attemptId||receipt.epoch!==event.epoch)fail('stored_event_receipt_differs');receipts.push(receipt);continue;}
  if(a.attempt.result_json!==null||a.attempt.reconciled_at!==null)fail('terminal_attempt_immutable');
  const receipt:AgentEventReceipt={attemptId:event.attemptId,epoch:event.epoch,sequence:event.sequence,payloadSha256:hash,receivedAt:options.now},row:Row={user_id:p.ownerId,attempt_id:event.attemptId,epoch:event.epoch,sequence:event.sequence,payload_hash:hash,payload_json:payload,receipt_json:canonical(receipt),received_at:options.now,applied_at:null};
  inserts.push(row);events.set(event.sequence,{row,event});receipts.push(receipt);
 }
 const applied=protocol(events,record,identity.executionBinding,a.attempt,state);
 if(!inserts.length){if(!await db.prepare('SELECT 1 WHERE '+a.auth.sql).bind(...a.auth.bindings).first())fail('device_authority_unavailable',401);return {receipts,lastAppliedSequence:integer(a.attempt,'last_applied_sequence')};}
 if(events.size>1024||[...events.values()].reduce((n,e)=>n+new TextEncoder().encode(text(e.row,'payload_json')).length,0)>2097152)fail('attempt_event_capacity');
 if(!await atomic(db,p,attemptGuard(a.auth,p,a.attempt,options.now,!!reconciliation),proofs,(gate,b)=>[
  ...inserts.map(row=>db.prepare('INSERT INTO job_events(user_id,attempt_id,epoch,sequence,payload_hash,payload_json,receipt_json,received_at) SELECT ?,?,?,?,?,?,?,? WHERE '+gate).bind(p.ownerId,row.attempt_id,row.epoch,row.sequence,row.payload_hash,row.payload_json,row.receipt_json,row.received_at,...b)),
  db.prepare('UPDATE job_events SET applied_at=COALESCE(applied_at,?) WHERE user_id=? AND attempt_id=? AND sequence<=? AND '+gate).bind(options.now,p.ownerId,a.attempt.id,applied.sequence,...b),
  db.prepare('UPDATE job_attempts SET last_applied_sequence=?,launched_at=CASE WHEN ? THEN COALESCE(launched_at,?) ELSE launched_at END,exited_at=CASE WHEN ? THEN COALESCE(exited_at,?) ELSE exited_at END,cancel_acknowledged_at=CASE WHEN ? THEN COALESCE(cancel_acknowledged_at,?) ELSE cancel_acknowledged_at END,operational_revision=operational_revision+1 WHERE user_id=? AND id=? AND '+gate).bind(applied.sequence,applied.started?1:0,options.now,applied.exited?1:0,options.now,applied.cancelled?1:0,options.now,p.ownerId,a.attempt.id,...b),
  db.prepare("UPDATE agent_job_state SET status=CASE WHEN ? THEN 'reconcile_required' WHEN cancel_requested_at IS NOT NULL THEN 'cancelling' WHEN ? THEN 'running' ELSE status END,operational_revision=operational_revision+1,updated_at=? WHERE user_id=? AND job_id=? AND "+gate).bind(reconciliation||applied.identityMismatch?1:0,applied.started?1:0,options.now,p.ownerId,record.id,...b)
 ]))fail('event_commit_conflict');
 return {receipts,lastAppliedSequence:applied.sequence};
}
export async function reportAgentEvents(db:SqlDatabase,p:DevicePrincipal,raw:unknown,options:AgentStoreOptions){return persistAgentEvents(db,p,raw,options);}
/** Expiry is uncertainty, never evidence of exit and never permission to retry. */
export async function expireAgentAttempts(db:SqlDatabase,owner:string,now:string):Promise<number>{
 time(now);if(typeof owner!=='string'||!owner||owner.length>256)fail('owner_required');
 const rows=(await db.prepare("SELECT a.id,a.job_id,a.operational_revision FROM job_attempts a JOIN agent_job_state s ON s.user_id=a.user_id AND s.job_id=a.job_id WHERE a.user_id=? AND a.result_json IS NULL AND a.reconciled_at IS NULL AND s.status IN('leased','running','cancelling') AND (julianday(a.lease_expires_at)<=julianday(?) OR julianday(a.deadline_at)<=julianday(?) OR a.execution_epoch<>COALESCE((SELECT epoch FROM workspace_execution_state WHERE user_id=a.user_id),0)) LIMIT 13").bind(owner,now,now).all<Row>()).results;
 if(rows.length>12)fail('active_agent_capacity');
 let changed=0;
 for(const row of rows){const result=await db.prepare("UPDATE agent_job_state SET status='reconcile_required',operational_revision=operational_revision+1,updated_at=? WHERE user_id=? AND job_id=? AND status IN('leased','running','cancelling') AND EXISTS(SELECT 1 FROM job_attempts a WHERE a.user_id=? AND a.id=? AND a.operational_revision=? AND a.result_json IS NULL AND a.reconciled_at IS NULL AND (julianday(a.lease_expires_at)<=julianday(?) OR julianday(a.deadline_at)<=julianday(?) OR a.execution_epoch<>COALESCE((SELECT epoch FROM workspace_execution_state WHERE user_id=a.user_id),0)))").bind(now,owner,row.job_id,owner,row.id,row.operational_revision,now,now).run();changed+=result.meta.changes??0;}
 return changed;
}

export async function reportAgentCapability(db:SqlDatabase,p:DevicePrincipal,raw:unknown,options:{now:string}):Promise<{sha256:string;operationalRevision:number}>{
 const input=z.object({capability:agentCapabilitySchema,expectedOperationalRevision:z.number().int().positive().safe().nullable()}).strict().parse(raw),auth=await authority(db,p,options.now),cap=input.capability;
 if(cap.deviceId!==p.deviceId||Date.parse(cap.observedAt)>Date.parse(options.now)||Date.parse(cap.expiresAt)<=Date.parse(options.now)||Date.parse(options.now)-Date.parse(cap.observedAt)>AGENT_LIMITS.capabilityMs)fail('capability_time_or_device_differs');
 const old=await one(db,'agent_capabilities',p.ownerId,'device_id',p.deviceId);if((old?old.operational_revision:null)!==input.expectedOperationalRevision)fail('capability_revision_conflict');
 const proofs=await snapshot(db,p.ownerId,['agent_capabilities']),sha256=await contentHash(canonical(cap)),revision=(old?integer(old,'operational_revision'):0)+1;
 if(!await atomic(db,p,auth,proofs,(gate,b)=>[db.prepare('INSERT INTO agent_capabilities(user_id,device_id,manifest_hash,payload_json,reported_at,operational_revision,revoked_at) SELECT ?,?,?,?,?,?,NULL WHERE '+gate+' ON CONFLICT(user_id,device_id) DO UPDATE SET manifest_hash=excluded.manifest_hash,payload_json=excluded.payload_json,reported_at=excluded.reported_at,operational_revision=excluded.operational_revision,revoked_at=NULL').bind(p.ownerId,p.deviceId,sha256,canonical(cap),options.now,revision,...b)]))fail('capability_commit_conflict');
 return {sha256,operationalRevision:revision};
}
async function finish(db:SqlDatabase,p:DevicePrincipal,a:Row,auth:DeviceSqlGuard,result:AgentJobResultV1,options:AgentStoreOptions,reconciled=false){
 const proofs=await snapshot(db,p.ownerId,['job_attempts','job_events','agent_job_state','job_approvals','agent_budgets','agent_device_slots','workspace_job_intents','operational_stream_heads']);
 const identity=JSON.parse(text(a,'identity_json')) as {record:AgentJobRecordV1;executionBinding:AgentExecutionBindingV1;budgetId:string},record=await validateAgentJobRecord(identity.record),state=await one(db,'agent_job_state',p.ownerId,'job_id',record.id);
 if(!state||state.attempt_id!==a.id||result.attemptId!==a.id||result.epoch!==a.execution_epoch)fail('terminal_attempt_identity_differs');
 const hash=await contentHash(canonical(result)),recordId='result:'+text(a,'id');
 if(a.result_json!==null){if(a.result_json!==canonical(result)||state.result_json!==canonical(result))fail('terminal_result_immutable');if(!await db.prepare('SELECT 1 WHERE '+auth.sql).bind(...auth.bindings).first())fail('device_authority_unavailable',401);return {result,recordId};}
 const events=await eventsFor(db,p,a),proof=protocol(events,record,identity.executionBinding,a,state);
 if(proof.sequence!==events.size||proof.sequence!==a.last_applied_sequence)fail('terminal_event_gap');
 if(!proof.exited||!result.processExitConfirmed||result.terminationUnconfirmed)fail('terminal_exit_not_proven');
 if(result.terminalProtocolObserved!==proof.completed)fail('terminal_protocol_claim_differs');
 if(proof.completed&&proof.resultHash!==hash)fail('completed_result_digest_differs');
 if(result.observedModel!==proof.observedModel||result.disposition==='succeeded'&&(!proof.completed||proof.exitCode!==0||proof.identityMismatch)||result.disposition==='cancelled'&&(!proof.cancelled||!state.cancel_requested_at))fail('terminal_protocol_identity_differs');
 const portableJob=await one(db,'agent_jobs',p.ownerId,'id',record.id),currentEpoch=await db.prepare('SELECT epoch FROM workspace_execution_state WHERE user_id=?').bind(p.ownerId).first<{epoch:number}>();
 let importedJob=false;if(portableJob){try{importedJob=JSON.parse(text(portableJob,'payload_json')).historical===true;}catch{fail('portable_job_identity_invalid');}}
 const historical=!portableJob||importedJob||(currentEpoch?.epoch??0)!==a.execution_epoch||portableJob.spec_hash!==record.specSha256,historicalReconciliation=reconciled&&historical;
 // A detached retained journal can establish process exit without proving that
 // old files still exist. Preserve its exact result as a historical claim ONLY;
 // do not synthesize adapter success or make the private job succeed.
 const verified: {adapterChecksPassed:boolean;guard?:DeviceSqlGuard}=historicalReconciliation?{adapterChecksPassed:false}:await options.verifyResult?.({principal:p,record,attemptId:text(a,'id'),result,executionBinding:identity.executionBinding})??{adapterChecksPassed:false};
 if(historicalReconciliation){
  if(!proof.completed||proof.resultHash!==hash)fail('historical_completed_proof_required');
  validateAgentExecutionBinding(record.spec,identity.executionBinding);
  if(result.requestedModel!==record.spec.requestedModel||result.usage?.runtimeSeconds!==null&&result.usage?.runtimeSeconds!==undefined&&result.usage.runtimeSeconds>record.spec.timeoutSeconds)fail('historical_execution_identity_differs');
 }else validateAgentResult(record.spec,identity.executionBinding,result,{adapterChecksPassed:verified.adapterChecksPassed});
 if(result.artifactIds.some(id=>!proof.artifactIds.has(id))||proof.artifactIds.size!==result.artifactIds.length||!historicalReconciliation&&result.artifactIds.length&&!verified.guard)fail('terminal_artifact_proof_unavailable');
 if(new TextEncoder().encode(canonical(result)).length>16384)fail('terminal_result_capacity');
 const value={id:recordId,jobId:record.id,attemptId:text(a,'id'),recordedAt:options.now,result,resultSha256:hash,frozenJob:{...record,historical:true},historical};
 if(new TextEncoder().encode(canonical(value)).length>24576)fail('terminal_result_record_capacity');
 const watermarks=await readOperationalWatermarks(db,p.ownerId),before=watermarks.agents??0,sequence=before+1;
 const event=parseAuditEvent({id:crypto.randomUUID(),kind:'agent.result',entityType:'agent-job',entityId:record.id,changes:[{path:['agent-result',recordId],before:{exists:false,value:null},after:{exists:true,value:{id:recordId,attemptId:text(a,'id'),resultSha256:hash,disposition:result.disposition}}}],origin:'owner',actorId:p.ownerId,occurredAt:options.now,sourceRef:null,undoOf:null});
 const valueHash=await contentHash(canonical(value));
 const quote=await measureProspectiveRecoverability(db,p.ownerId,{now:options.now,operationalWrites:[{table:'agent_results',value:value as unknown as JsonValue,streamSequence:sequence}],operationalEvents:[{event,streamId:'agents',sequence}],operationalWatermarksAfter:{...watermarks,agents:sequence},agentTerminalReserveDelta:-1});
 proofs.push({sql:"(SELECT COUNT(*) FROM agent_results WHERE user_id=?)<500",bindings:[p.ownerId]});
 if(verified.guard)proofs.push(verified.guard);
 const budget=await one(db,'agent_budgets',p.ownerId,'id',identity.budgetId);if(!budget||integer(budget,'reserved_jobs')<1||integer(budget,'reserved_seconds')<record.spec.timeoutSeconds)fail('terminal_budget_reservation_differs');
 const guard=attemptGuard(auth,p,a,options.now,reconciled);
 const committed=await atomic(db,p,guard,proofs,(gate,b,id)=>[
  ...recoverabilityAssertions(db,p.ownerId,id,quote,gate,b),
  db.prepare('INSERT INTO agent_results(user_id,id,row_revision,payload_json,content_hash,job_id,attempt_id,recorded_at,stream_sequence) SELECT ?,?,1,?,?,?,?,?,? WHERE '+gate).bind(p.ownerId,recordId,canonical(value),valueHash,record.id,a.id,options.now,sequence,...b),
  db.prepare('INSERT INTO operational_stream_heads(user_id,stream_id,revision,last_sequence) SELECT ?,?,1,? WHERE '+gate+' ON CONFLICT(user_id,stream_id) DO UPDATE SET revision=operational_stream_heads.revision+1,last_sequence=excluded.last_sequence').bind(p.ownerId,'agents',sequence,...b),
  db.prepare('INSERT INTO audit_events(user_id,event_id,workspace_revision,ordinal,stream_id,stream_sequence,kind,entity_type,entity_id,occurred_at,payload_json,origin,actor_id,source_ref,undo_of) SELECT ?,?,NULL,NULL,?,?,?,?,?,?,?,?,?,NULL,NULL WHERE '+gate).bind(p.ownerId,event.id,'agents',sequence,event.kind,event.entityType,event.entityId,options.now,canonical(event),'owner',p.ownerId,...b),
  db.prepare('UPDATE job_attempts SET result_json=?,reconciled_at=CASE WHEN ? THEN ? ELSE reconciled_at END,operational_revision=operational_revision+1 WHERE user_id=? AND id=? AND '+gate).bind(canonical(result),reconciled?1:0,options.now,p.ownerId,a.id,...b),
  db.prepare('UPDATE agent_job_state SET status=?,result_json=?,updated_at=?,operational_revision=operational_revision+1 WHERE user_id=? AND job_id=? AND '+gate).bind(historicalReconciliation?'blocked':result.disposition,canonical(result),options.now,p.ownerId,record.id,...b),
  db.prepare('UPDATE agent_device_slots SET released_at=? WHERE user_id=? AND device_id=? AND attempt_id=? AND released_at IS NULL AND '+gate).bind(options.now,p.ownerId,p.deviceId,a.id,...b),
  // Launched jobs remain charged against the finite job count. Unknown usage can
  // never refund time: conservatively charge the full approved timeout.
  db.prepare('UPDATE agent_budgets SET reserved_seconds=reserved_seconds-?,charged_seconds=charged_seconds+?,updated_at=?,operational_revision=operational_revision+1 WHERE user_id=? AND id=? AND '+gate).bind(record.spec.timeoutSeconds,record.spec.timeoutSeconds,options.now,p.ownerId,identity.budgetId,...b),
  db.prepare('UPDATE workspace_job_intents SET status=? WHERE user_id=? AND id=? AND '+gate).bind(historicalReconciliation?'cancelled':result.disposition==='succeeded'?'completed':result.disposition==='cancelled'?'cancelled':'failed',p.ownerId,record.intentId,...b)
 ]);
 if(!committed)fail('terminal_commit_conflict');return {result,recordId};
}
export async function completeAgentAttempt(db:SqlDatabase,p:DevicePrincipal,raw:unknown,options:AgentStoreOptions){
 const input=z.object({attemptId:agentIdSchema,leaseToken:z.string().regex(/^[a-f0-9]{64}$/u),result:agentJobResultSchema}).strict().parse(raw),a=await ownedAttempt(db,p,input,options.now,true);
 if(a.attempt.result_json===null&&(Date.parse(text(a.attempt,'lease_expires_at'))<=Date.parse(options.now)||Date.parse(text(a.attempt,'deadline_at'))<=Date.parse(options.now)))fail('attempt_requires_reconciliation');
 return finish(db,p,a.attempt,a.auth,input.result,options);
}
/** Current authenticated device authority can attest retained journal proof, but a
 * retired execution epoch is never turned back into permission to run a process. */
export async function reconcileAgentAttempt(db:SqlDatabase,p:DevicePrincipal,raw:unknown,options:AgentStoreOptions){
 const input=z.object({attemptId:agentIdSchema,journalNonce:z.string().min(32).max(128).regex(/^[A-Za-z0-9_-]+$/u),proof:z.enum(['no-launch','exited']),events:z.unknown().optional(),result:agentJobResultSchema.optional()}).strict().parse(raw),auth=await authority(db,p,options.now),a=await one(db,'job_attempts',p.ownerId,'id',input.attemptId);
 if(!a||a.device_id!==p.deviceId||a.journal_nonce_hash!==await contentHash(input.journalNonce))fail('journal_identity_differs',403);
 if(a.result_json!==null){if(input.result&&canonical(input.result)!==a.result_json)fail('terminal_result_immutable');return {result:agentJobResultSchema.parse(JSON.parse(text(a,'result_json'))),recordId:'result:'+input.attemptId};}
 if(a.reconciled_at!==null)return {result:null,recordId:null};
 if(input.proof==='exited'){
  if(!input.result)fail('reconciliation_result_required');
  let current=a;
  if(input.events!==undefined){
   await persistAgentEvents(db,p,{attemptId:input.attemptId,leaseToken:text(a,'lease_token_hash'),events:input.events},options,{attempt:a,auth});
   const reread=await one(db,'job_attempts',p.ownerId,'id',input.attemptId);if(!reread)fail('retained_attempt_missing');current=reread;
  }
  // The credential/epoch authenticates this report; the retained attempt epoch
  // remains immutable and completion never creates a lease or runnable intent.
  const reportGuard:DeviceSqlGuard={sql:auth.sql+' AND EXISTS(SELECT 1 FROM job_attempts WHERE user_id=? AND id=? AND operational_revision=? AND journal_nonce_hash=? AND result_json IS NULL)',bindings:[...auth.bindings,p.ownerId,current.id,current.operational_revision,current.journal_nonce_hash]};
  return finish(db,p,current,reportGuard,input.result,options,true);
 }
 if(a.launched_at!==null||a.exited_at!==null||input.result||input.events!==undefined)fail('no_launch_proof_contradicts_process');
 const proof=await options.verifyNoLaunch?.({principal:p,attemptId:input.attemptId,journalNonce:input.journalNonce});if(!proof)fail('no_launch_proof_unavailable');
 const identity=JSON.parse(text(a,'identity_json')) as {record:AgentJobRecordV1;budgetId:string},record=await validateAgentJobRecord(identity.record),proofs=await snapshot(db,p.ownerId,['job_attempts','job_events','agent_job_state','agent_device_slots','agent_budgets','workspace_job_intents']);
 proofs.push(proof);
 const guard:DeviceSqlGuard={sql:auth.sql+' AND EXISTS(SELECT 1 FROM job_attempts WHERE user_id=? AND id=? AND operational_revision=? AND launched_at IS NULL AND result_json IS NULL AND reconciled_at IS NULL)',bindings:[...auth.bindings,p.ownerId,a.id,a.operational_revision]};
 if(!await atomic(db,p,guard,proofs,(gate,b)=>[
  db.prepare('UPDATE job_attempts SET reconciled_at=?,operational_revision=operational_revision+1 WHERE user_id=? AND id=? AND '+gate).bind(options.now,p.ownerId,a.id,...b),
  db.prepare("UPDATE agent_job_state SET status='cancelled',updated_at=?,operational_revision=operational_revision+1 WHERE user_id=? AND job_id=? AND "+gate).bind(options.now,p.ownerId,record.id,...b),
  db.prepare('UPDATE agent_device_slots SET released_at=? WHERE user_id=? AND device_id=? AND attempt_id=? AND '+gate).bind(options.now,p.ownerId,p.deviceId,a.id,...b),
  db.prepare('UPDATE agent_budgets SET reserved_jobs=reserved_jobs-1,reserved_seconds=reserved_seconds-?,updated_at=?,operational_revision=operational_revision+1 WHERE user_id=? AND id=? AND '+gate).bind(record.spec.timeoutSeconds,options.now,p.ownerId,identity.budgetId,...b),
  db.prepare("UPDATE workspace_job_intents SET status='cancelled' WHERE user_id=? AND id=? AND "+gate).bind(p.ownerId,record.intentId,...b)
 ]))fail('reconciliation_conflict');
 return {result:null,recordId:null};
}
