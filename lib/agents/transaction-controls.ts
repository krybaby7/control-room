import {z} from 'zod';
import {canonical,contentHash} from '../canonical-json.ts';
import {evidenceDateSchema} from '../evidence-validation.ts';
import type {SqlDatabase,SqlStatement} from '../workspace-store.ts';
import type {Workspace} from '../types.ts';
import type {MutationPlan} from '../workspace-transaction.ts';
import {agentIdSchema,AGENT_LIMITS,type AgentJobRecordV1} from './contracts.ts';
import {agentTaskSnapshotSha256,validateAgentJobRecord,validateAgentApprovalEnvelope} from './policy.ts';
import {ownerAgentContext,readAgentApprovalCandidate,readAgentState} from './context.ts';
import type {AgentControls} from './command-contracts.ts';
type Binding=string|number|null;
const commands:Record<string,string>={'jobs.create':'create','jobs.approve':'approve','jobs.cancel':'cancel','jobs.reject':'reject','jobs.accept-result':'accept-result','jobs.budget.configure':'budget'};
const pending="'awaiting_approval','queued','leased','running','cancelling','reconcile_required'";
/** Private effects are gated by the central receipt/compiler claim, never standalone SQL execution.
 * Portable job rows retain immutable intent; only this separate state can grant approval.
 */
export async function agentControlStatements(db:SqlDatabase,owner:string,plan:MutationPlan,commandType:string,claim:string,guard:Binding[],now:string,beforeWorkspace:Workspace):Promise<SqlStatement[]>{
 if(!owner||owner.length>256)throw new Error('An authenticated owner is required.');evidenceDateSchema.parse(now);
 const statements:SqlStatement[]=[];
 const assert=(condition:string,bindings:Binding[]=[])=>{const id='agent-'+crypto.randomUUID();statements.push(db.prepare('INSERT INTO workspace_assertions(user_id,mutation_id,valid) SELECT ?,?,CASE WHEN '+condition+' THEN 1 ELSE 0 END WHERE '+claim).bind(owner,id,...bindings,...guard),db.prepare('DELETE FROM workspace_assertions WHERE user_id=? AND mutation_id=? AND '+claim).bind(owner,id,...guard));};
 const write=(sql:string,bindings:Binding[]=[])=>statements.push(db.prepare(sql+' AND '+claim).bind(...bindings,...guard));
 const revision=(value:number)=>{if(!Number.isSafeInteger(value)||value<1||value>=Number.MAX_SAFE_INTEGER)throw new Error('Private job revision is invalid.');};
 const stateGuard=async(id:string,expected:number)=>{revision(expected);const state=await readAgentState(db,owner,id);if(!state||state.operationalRevision!==expected)throw new Error('The reviewed job changed.');assert('EXISTS(SELECT 1 FROM agent_job_state WHERE user_id=? AND job_id=? AND operational_revision=? AND status=? AND spec_hash=? AND task_hash=? AND device_id IS ? AND approval_id IS ? AND attempt_id IS ? AND execution_epoch=? AND cancel_requested_at IS ? AND cancel_request_id IS ? AND result_json IS ? AND accepted_at IS ? AND accepted_task_hash IS ?)',[owner,id,expected,state.status,state.specHash,state.taskHash,state.deviceId,state.approvalId,state.attemptId,state.executionEpoch,state.cancelRequestedAt,state.cancelRequestId,state.result===null?null:canonical(state.result),state.acceptedAt,state.acceptedTaskHash]);return state;};
 const record=async(id:string)=>{agentIdSchema.parse(id);const row=await db.prepare('SELECT payload_json,content_hash,row_revision FROM agent_jobs WHERE user_id=? AND id=?').bind(owner,id).first<{payload_json:string;content_hash:string;row_revision:number}>();if(!row||await contentHash(canonical(JSON.parse(row.payload_json)))!==row.content_hash)throw new Error('The owner job is unavailable.');const value=await validateAgentJobRecord(JSON.parse(row.payload_json));if(value.id!==id||value.historical)throw new Error('Historical records have no execution authority.');assert('EXISTS(SELECT 1 FROM agent_jobs WHERE user_id=? AND id=? AND payload_json=? AND content_hash=? AND row_revision=?)',[owner,id,row.payload_json,row.content_hash,row.row_revision]);return value;};
 // Preserve exact normalized acceptance inputs and byte metadata across the preparation/batch gap.
 // Closed table and column names never originate from a request.
 const inputSnapshot=async()=>{
  const tables:Record<string,string[]>={evidence_records:['id','row_revision','payload_json','content_hash'],evidence_versions:['id','row_revision','payload_json','content_hash'],evidence_links:['id','row_revision','payload_json','content_hash'],evidence_requirements:['id','row_revision','payload_json','content_hash'],acceptance_records:['id','row_revision','payload_json','content_hash'],decision_records:['id','row_revision','payload_json','content_hash'],decision_versions:['id','row_revision','payload_json','content_hash'],attachments:['id','row_revision','payload_json','content_hash'],acceptance_owner_grants:['record_id','content_hash'],decision_owner_grants:['decision_id','version','content_hash'],attachment_blob_objects:['storage_key','attachment_id','bytes','sha256','verified_at','purged_at'],attachment_blob_fences:['storage_key','attachment_id']};
  let total=0,totalBytes=0;
  for(const [table,columns]of Object.entries(tables)){
   const rows=(await db.prepare('SELECT '+columns.join(',')+' FROM '+table+' WHERE user_id=? LIMIT 10001').bind(owner).all<Record<string,Binding>>()).results;
   total+=rows.length;const payload=canonical(rows),bytes=new TextEncoder().encode(payload).byteLength;totalBytes+=bytes;
   if(total>10000||bytes>1_800_000||totalBytes>8_000_000)throw new Error('Job input snapshot exceeds its finite row or byte bound.');
   const projection=columns.map(column=>"json_extract(value,'$."+column+"')").join(',');
   assert('(SELECT COUNT(*) FROM '+table+' WHERE user_id=?)=? AND NOT EXISTS(SELECT '+columns.join(',')+' FROM '+table+' WHERE user_id=? EXCEPT SELECT '+projection+' FROM json_each(?))',[owner,rows.length,owner,payload]);
  }
 };
 const taskCurrent=async(job:AgentJobRecordV1)=>{await inputSnapshot();const task=beforeWorkspace.tasks.find(row=>row.id===job.spec.taskId);if(!task||task.status==='archived'||!beforeWorkspace.projects.some(row=>row.id===task.projectId&&row.archivedAt===null)||await agentTaskSnapshotSha256(task,await ownerAgentContext(db,owner,now).taskInputs(task.id))!==job.spec.taskSnapshotSha256)throw new Error('The reviewed task or acceptance inputs changed.');};
 const release=async(jobId:string,approvalId:string|null)=>{
  if(approvalId===null)return;
  const row=await db.prepare('SELECT payload_json,reserved_seconds,consumed_at,revoked_at FROM job_approvals WHERE user_id=? AND id=? AND job_id=?').bind(owner,approvalId,jobId).first<{payload_json:string;reserved_seconds:number;consumed_at:string|null;revoked_at:string|null}>();if(!row)throw new Error('Private approval reservation is unavailable.');
  if(row.revoked_at!==null)return;
  const envelope=JSON.parse(row.payload_json) as {reservationId?:unknown};const budgetId=agentIdSchema.parse(envelope.reservationId);
  if(row.consumed_at!==null)throw new Error('An attempted job retains its reservation until confirmed reconciliation.');
  assert('EXISTS(SELECT 1 FROM job_approvals WHERE user_id=? AND id=? AND job_id=? AND payload_json=? AND reserved_seconds=? AND consumed_at IS NULL AND revoked_at IS NULL) AND NOT EXISTS(SELECT 1 FROM job_attempts WHERE user_id=? AND job_id=?)',[owner,approvalId,jobId,row.payload_json,row.reserved_seconds,owner,jobId]);
  assert('EXISTS(SELECT 1 FROM agent_budgets WHERE user_id=? AND id=? AND reserved_jobs>=1 AND reserved_seconds>=? AND operational_revision<9007199254740991)',[owner,budgetId,row.reserved_seconds]);
  write('UPDATE agent_budgets SET reserved_jobs=reserved_jobs-1,reserved_seconds=reserved_seconds-?,operational_revision=operational_revision+1,updated_at=? WHERE user_id=? AND id=?',[row.reserved_seconds,now,owner,budgetId]);
  write('UPDATE job_approvals SET revoked_at=? WHERE user_id=? AND id=? AND revoked_at IS NULL',[now,owner,approvalId]);
 };
 if(plan.restoreEpoch){
  if(plan.agentControls)throw new Error('Recovery cannot grant job authority.');
  const states=(await db.prepare('SELECT job_id,operational_revision FROM agent_job_state WHERE user_id=? AND status IN('+pending+') LIMIT 13').bind(owner).all<{job_id:string;operational_revision:number}>()).results;if(states.length>12)throw new Error('Pending agent state exceeds its finite bound.');assert('(SELECT COUNT(*) FROM agent_job_state WHERE user_id=? AND status IN('+pending+'))=?',[owner,states.length]);
  for(const row of states){const state=await stateGuard(row.job_id,row.operational_revision),attempt=await db.prepare('SELECT id FROM job_attempts WHERE user_id=? AND job_id=?').bind(owner,row.job_id).first<{id:string}>();assert('(SELECT COUNT(*) FROM job_attempts WHERE user_id=? AND job_id=?)=?',[owner,row.job_id,attempt?1:0]);if(!attempt)await release(row.job_id,state.approvalId);write('UPDATE agent_job_state SET status=?,cancel_requested_at=COALESCE(cancel_requested_at,?),cancel_request_id=COALESCE(cancel_request_id,?),operational_revision=operational_revision+1,updated_at=? WHERE user_id=? AND job_id=?',[attempt?'reconcile_required':'cancelled',now,'restore-'+crypto.randomUUID(),now,owner,row.job_id]);write("UPDATE workspace_job_intents SET status=?,cancel_requested=1 WHERE user_id=? AND id=?",[attempt?'running':'cancelled',owner,state.intentId]);}
  return statements;
 }
 if(!commands[commandType]){if(plan.agentControls)throw new Error('Agent controls require an explicit owner command.');return [];}
 const controls=plan.agentControls as AgentControls|undefined;
 if(!controls||controls.action!==commands[commandType])throw new Error('Agent owner command and controls differ.');
 if(plan.replacements?.length||plan.integrationJobs?.length||plan.reviewJobs?.length||canonical(plan.planningAfter)!==canonical(beforeWorkspace))throw new Error('Agent commands cannot change planning or schedule unrelated work.');
 if(controls.action!=='create'&&(plan.jobs.length||plan.writes.length))throw new Error('This agent command cannot write portable rows or create jobs.');
 if(controls.action==='create'){
  const value=await validateAgentJobRecord(controls.record);if(value.historical||value.createdAt!==now||plan.writes.length!==1||plan.writes[0].table!=='agent_jobs'||plan.writes[0].id!==value.id||plan.writes[0].operation!=='insert'||canonical(plan.writes[0].value)!==canonical(value)||plan.jobs.length!==1||plan.jobs[0].id!==value.intentId||plan.jobs[0].kind!=='agent.execute'||canonical(plan.jobs[0].payload)!==canonical({jobId:value.id,specSha256:value.specSha256}))throw new Error('Creation requires one exact immutable job and queue intent.');
  await taskCurrent(value);
  assert('(SELECT COUNT(*) FROM agent_job_state WHERE user_id=? AND status IN('+pending+'))<?',[owner,AGENT_LIMITS.pendingJobs]);
  assert("EXISTS(SELECT 1 FROM workspace_job_intents WHERE user_id=? AND id=? AND kind='agent.execute' AND status='awaiting_approval' AND payload_json=? AND cancel_requested=0)",[owner,value.intentId,canonical({jobId:value.id,specSha256:value.specSha256})]);
  assert('NOT EXISTS(SELECT 1 FROM agent_job_state WHERE user_id=? AND job_id=?)',[owner,value.id]);
  statements.push(db.prepare("INSERT INTO agent_job_state(user_id,job_id,intent_id,status,operational_revision,spec_hash,task_hash,device_id,approval_id,attempt_id,execution_epoch,cancel_requested_at,updated_at,result_json,accepted_at,accepted_task_hash) SELECT ?,?,?,'awaiting_approval',1,?,?,NULL,NULL,NULL,COALESCE((SELECT epoch FROM workspace_execution_state WHERE user_id=?),0),NULL,?,NULL,NULL,NULL WHERE "+claim).bind(owner,value.id,value.intentId,value.specSha256,value.spec.taskSnapshotSha256,owner,now,...guard));
 }else if(controls.action==='budget'){
  agentIdSchema.parse(controls.id);z.object({maximumJobs:z.number().int().min(0).max(12),maximumSeconds:z.number().int().min(0).max(7200),enabled:z.boolean()}).parse(controls);if(controls.enabled&&(!controls.maximumJobs||!controls.maximumSeconds))throw new Error('An enabled budget requires finite positive bounds.');
  const row=await db.prepare('SELECT operational_revision,reserved_jobs,reserved_seconds,charged_seconds FROM agent_budgets WHERE user_id=? AND id=?').bind(owner,controls.id).first<{operational_revision:number;reserved_jobs:number;reserved_seconds:number;charged_seconds:number}>();
  const payload=canonical({maximumJobs:controls.maximumJobs,maximumSeconds:controls.maximumSeconds,enabled:controls.enabled});
  if(controls.expectedOperationalRevision===null){if(row)throw new Error('Budget already exists.');assert('(SELECT COUNT(*) FROM agent_budgets WHERE user_id=?)<12 AND NOT EXISTS(SELECT 1 FROM agent_budgets WHERE user_id=? AND id=?)',[owner,owner,controls.id]);statements.push(db.prepare('INSERT INTO agent_budgets(user_id,id,operational_revision,payload_json,maximum_jobs,maximum_seconds,reserved_jobs,reserved_seconds,charged_seconds,enabled,updated_at) SELECT ?,?,1,?,?,?,0,0,0,?,? WHERE '+claim).bind(owner,controls.id,payload,controls.maximumJobs,controls.maximumSeconds,controls.enabled?1:0,now,...guard));}
  else{revision(controls.expectedOperationalRevision);if(!row||row.operational_revision!==controls.expectedOperationalRevision||row.reserved_jobs>controls.maximumJobs||row.reserved_seconds+row.charged_seconds>controls.maximumSeconds)throw new Error('Budget changes cannot erase existing reservations or usage.');assert('EXISTS(SELECT 1 FROM agent_budgets WHERE user_id=? AND id=? AND operational_revision=? AND reserved_jobs=? AND reserved_seconds=? AND charged_seconds=?)',[owner,controls.id,row.operational_revision,row.reserved_jobs,row.reserved_seconds,row.charged_seconds]);write('UPDATE agent_budgets SET operational_revision=operational_revision+1,payload_json=?,maximum_jobs=?,maximum_seconds=?,enabled=?,updated_at=? WHERE user_id=? AND id=?',[payload,controls.maximumJobs,controls.maximumSeconds,controls.enabled?1:0,now,owner,controls.id]);}
 }else{
  if((controls.action==='cancel'||controls.action==='reject')&&!agentIdSchema.safeParse(controls.requestId).success)throw new Error('Cancellation requires its exact owner mutation identity.');
  const value=await record(controls.jobId),state=await stateGuard(controls.jobId,controls.expectedOperationalRevision);
  if(state.specHash!==value.specSha256||state.taskHash!==value.spec.taskSnapshotSha256||state.intentId!==value.intentId)throw new Error('Private job identity differs.');
  if(controls.action==='approve'){
   if(state.status!=='awaiting_approval'||state.approvalId!==null||state.attemptId!==null)throw new Error('This job already has approval or execution history.');
   assert('COALESCE((SELECT epoch FROM workspace_execution_state WHERE user_id=?),0)=?',[owner,state.executionEpoch]);
   await taskCurrent(value);
   const current=await readAgentApprovalCandidate(db,owner,value,controls.candidate.deviceId,controls.candidate.budgetId,now),envelope=await validateAgentApprovalEnvelope(value.spec,controls.envelope,now);
   if(!current||canonical(current.candidate)!==canonical(controls.candidate)||envelope.approverId!==owner||envelope.approval.jobId!==value.id||envelope.approval.deviceId!==current.candidate.deviceId||envelope.reservationId!==current.candidate.budgetId||envelope.bindingSha256!==current.candidate.bindingHash||canonical(envelope.executionBinding)!==canonical(current.candidate.binding)||envelope.approval.approvedAt!==now)throw new Error('Reviewed execution capability or finite budget changed.');
   assert(current.guard.sql,current.guard.bindings);assert('NOT EXISTS(SELECT 1 FROM job_approvals WHERE user_id=? AND job_id=?)',[owner,value.id]);
   assert("EXISTS(SELECT 1 FROM workspace_job_intents WHERE user_id=? AND id=? AND status='awaiting_approval' AND kind='agent.execute' AND cancel_requested=0)",[owner,state.intentId]);
   write('UPDATE agent_budgets SET reserved_jobs=reserved_jobs+1,reserved_seconds=reserved_seconds+?,operational_revision=operational_revision+1,updated_at=? WHERE user_id=? AND id=?',[value.spec.timeoutSeconds,now,owner,envelope.reservationId]);
   statements.push(db.prepare('INSERT INTO job_approvals(user_id,id,job_id,device_id,spec_hash,binding_hash,payload_json,created_at,expires_at,consumed_at,revoked_at,reserved_seconds) SELECT ?,?,?,?,?,?,?,?,?,NULL,NULL,? WHERE '+claim).bind(owner,envelope.approval.id,value.id,envelope.approval.deviceId,value.specSha256,envelope.bindingSha256,canonical(envelope),now,envelope.approval.expiresAt,value.spec.timeoutSeconds,...guard));
   write("UPDATE agent_job_state SET status='queued',device_id=?,approval_id=?,operational_revision=operational_revision+1,updated_at=? WHERE user_id=? AND job_id=?",[envelope.approval.deviceId,envelope.approval.id,now,owner,value.id]);
   write("UPDATE workspace_job_intents SET status='pending' WHERE user_id=? AND id=?",[owner,state.intentId]);
  }else if(controls.action==='accept-result'){
   if(state.status!=='succeeded'||state.result===null||state.result.disposition!=='succeeded'||!state.result.terminalProtocolObserved||!state.result.processExitConfirmed||state.result.terminationUnconfirmed||state.acceptedAt!==null||await contentHash(canonical(state.result))!==controls.resultHash||controls.taskHash!==value.spec.taskSnapshotSha256)throw new Error('Only the exact verified current result can be accepted.');
   await taskCurrent(value);
   write('UPDATE agent_job_state SET accepted_at=?,accepted_task_hash=?,operational_revision=operational_revision+1,updated_at=? WHERE user_id=? AND job_id=?',[now,controls.taskHash,now,owner,value.id]);
  }else{
   if(['succeeded','failed','cancelled','blocked','rejected'].includes(state.status)||controls.action==='reject'&&state.status!=='awaiting_approval')throw new Error('The reviewed transition is unavailable.');
   const attempt=await db.prepare('SELECT id,launched_at FROM job_attempts WHERE user_id=? AND job_id=?').bind(owner,value.id).first<{id:string;launched_at:string|null}>();
   assert('(SELECT COUNT(*) FROM job_attempts WHERE user_id=? AND job_id=?)=?',[owner,value.id,attempt?1:0]);
   if(!attempt)await release(value.id,state.approvalId);
   const next=controls.action==='reject'?'rejected':attempt?state.status==='reconcile_required'?'reconcile_required':'cancelling':'cancelled';
   write('UPDATE agent_job_state SET status=?,cancel_requested_at=COALESCE(cancel_requested_at,?),cancel_request_id=COALESCE(cancel_request_id,?),operational_revision=operational_revision+1,updated_at=? WHERE user_id=? AND job_id=?',[next,now,controls.requestId,now,owner,value.id]);
   write('UPDATE workspace_job_intents SET status=?,cancel_requested=1 WHERE user_id=? AND id=?',[attempt?'running':'cancelled',owner,state.intentId]);
  }
 }
 return statements;
}
