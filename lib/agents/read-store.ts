import type {SqlDatabase} from '../workspace-store.ts';
import {readCurrent} from '../workspace-store.ts';
import {canonical,contentHash} from '../canonical-json.ts';
import {ownerAgentContext,readAgentState} from './context.ts';
import {validateAgentJobRecord} from './policy.ts';
import {agentIdSchema,agentResultRecordSchema,agentJobResultSchema} from './contracts.ts';
import {validateEvaluationObservation} from './evaluation-import.ts';
import {jobReadModelSchema,type JobReadModel} from './read-model.ts';
/** Owner-only safe projection. Private tokens/process identity never leave this boundary. */
export async function readAgentJobs(db:SqlDatabase,owner:string,now:string,options:{afterJob?:string;afterEvaluation?:string;executionAvailable?:boolean}={}):Promise<JobReadModel>{
 if(!owner)throw new Error('An authenticated owner is required.');
 for(const id of [options.afterJob,options.afterEvaluation])if(id!==undefined)agentIdSchema.parse(id);
 const before=await readCurrent(db,owner,now),services=ownerAgentContext(db,owner,now);
 const rows=(await db.prepare('SELECT id,row_revision,payload_json,content_hash FROM agent_jobs WHERE user_id=? AND id>? ORDER BY id LIMIT 201').bind(owner,options.afterJob??'').all<{id:string;row_revision:number;payload_json:string;content_hash:string}>()).results;
 // Restoring portable history must not hide a retained uncertain process. Its
 // frozen proposal is displayed as historical context, without execution grants.
 const uncertain=(await db.prepare("SELECT s.job_id,a.identity_json FROM agent_job_state s JOIN job_attempts a ON a.user_id=s.user_id AND a.id=s.attempt_id WHERE s.user_id=? AND s.status IN ('leased','running','cancelling','reconcile_required') AND s.job_id>? AND NOT EXISTS(SELECT 1 FROM agent_jobs j WHERE j.user_id=s.user_id AND j.id=s.job_id) ORDER BY s.job_id LIMIT 13").bind(owner,options.afterJob??'').all<{job_id:string;identity_json:string}>()).results;
 if(uncertain.length>12)throw new Error('Uncertain process bound exceeded.');
 for(const row of uncertain){const record=await validateAgentJobRecord(JSON.parse(row.identity_json).record),value={...record,historical:true};if(record.id!==row.job_id)throw new Error('Retained process identity differs.');rows.push({id:value.id,row_revision:1,payload_json:canonical(value),content_hash:await contentHash(canonical(value))});}
 rows.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);const nextJobAfter=rows.length>200?rows[199].id:null,page=rows.slice(0,200),jobs:JobReadModel['jobs']=[];
 const budgets=options.executionAvailable?(await db.prepare('SELECT id FROM agent_budgets WHERE user_id=? AND enabled=1 ORDER BY id LIMIT 13').bind(owner).all<{id:string}>()).results:[];
 const devices=options.executionAvailable?(await db.prepare('SELECT device_id FROM agent_capabilities WHERE user_id=? AND revoked_at IS NULL ORDER BY device_id LIMIT 21').bind(owner).all<{device_id:string}>()).results:[];
 if(budgets.length>12||devices.length>20)throw new Error('Execution configuration bound exceeded.');
 for(const row of page){
  if(await contentHash(canonical(JSON.parse(row.payload_json)))!==row.content_hash)throw new Error('Owner job body digest differs.');
  const record=await validateAgentJobRecord(JSON.parse(row.payload_json)),privateState=await services.state(record.id),state=record.historical?null:privateState;
  const attemptId=privateState?.attemptId??null,attemptRow=attemptId?await db.prepare('SELECT id,device_id,execution_epoch,created_at,lease_expires_at,deadline_at,last_applied_sequence,launched_at,result_json FROM job_attempts WHERE user_id=? AND id=? AND job_id=?').bind(owner,attemptId,record.id).first<{id:string;device_id:string;execution_epoch:number;created_at:string;lease_expires_at:string;deadline_at:string;last_applied_sequence:number;launched_at:string|null;result_json:string|null}>():null;
  let result=state?.result??null;
  if(!result){const historical=await db.prepare('SELECT payload_json,content_hash FROM agent_results WHERE user_id=? AND job_id=? ORDER BY recorded_at DESC,id DESC LIMIT 1').bind(owner,record.id).first<{payload_json:string;content_hash:string}>();if(historical){const value=agentResultRecordSchema.parse(JSON.parse(historical.payload_json));if(await contentHash(canonical(value))!==historical.content_hash||await contentHash(canonical(value.result))!==value.resultSha256)throw new Error('Historical result digest differs.');result=value.result;}}
  if(result)result=agentJobResultSchema.parse(result);
  const expired=attemptRow&&Date.parse(attemptRow.lease_expires_at)<=Date.parse(now),uncertainState=!!privateState&&['leased','running','cancelling','reconcile_required'].includes(privateState.status)&&(privateState.status==='reconcile_required'||expired||record.historical);
  if(uncertainState)result=null;
  const status=uncertainState?'reconcile_required':state?.status??result?.disposition??'blocked';
  let approvalCandidate:JobReadModel['jobs'][number]['approvalCandidate']=null;
  if(options.executionAvailable&&!record.historical&&status==='awaiting_approval')for(const device of devices){for(const budget of budgets){approvalCandidate=await services.candidate(record,device.device_id,budget.id);if(approvalCandidate)break;}if(approvalCandidate)break;}
  const event=attemptRow?await db.prepare('SELECT MAX(received_at) AS at FROM job_events WHERE user_id=? AND attempt_id=?').bind(owner,attemptRow.id).first<{at:string|null}>():null;
  const attempt=attemptRow?{id:attemptRow.id,epoch:attemptRow.execution_epoch,deviceId:attemptRow.device_id,createdAt:attemptRow.created_at,leaseExpiresAt:attemptRow.lease_expires_at,deadlineAt:attemptRow.deadline_at,lastAppliedSequence:attemptRow.last_applied_sequence,processExitConfirmed:result?.processExitConfirmed??false,terminationUnconfirmed:result?.terminationUnconfirmed??uncertainState,startedAt:attemptRow.launched_at,lastEventAt:event?.at??null,diagnostic:uncertainState?'exit_unconfirmed' as const:result?.diagnostic??'unknown' as const}:null;
  jobs.push({record,rowRevision:row.row_revision,status,operationalRevision:state?.operationalRevision??privateState?.operationalRevision??1,attempt,result,resultHash:result?await contentHash(canonical(result)):null,approvalCandidate,accepted:!record.historical&&state?.acceptedAt!==null&&state?.acceptedAt!==undefined});
 }
 const evaluationsRaw=(await db.prepare('SELECT id,payload_json,content_hash FROM evaluation_runs WHERE user_id=? AND id>? ORDER BY id LIMIT 201').bind(owner,options.afterEvaluation??'').all<{id:string;payload_json:string;content_hash:string}>()).results,nextEvaluationAfter=evaluationsRaw.length>200?evaluationsRaw[199].id:null,evaluations=[];
 for(const row of evaluationsRaw.slice(0,200)){const value=await validateEvaluationObservation(JSON.parse(row.payload_json));if(value.id!==row.id||await contentHash(canonical(value))!==row.content_hash)throw new Error('Evaluation history digest differs.');evaluations.push(value);}
 const after=await readCurrent(db,owner,now);if(after.revision!==before.revision)throw new Error('Owner job read changed. Refresh again.');
 const value=jobReadModelSchema.parse({revision:before.revision,generatedAt:now,jobs,evaluations,nextJobAfter,nextEvaluationAfter,execution:{enabled:options.executionAvailable===true,diagnostic:options.executionAvailable?'ready':'not_installed'}});
 if(new TextEncoder().encode(JSON.stringify(value)).byteLength>2*1024*1024)throw new Error('Owner job page exceeds its byte bound.');
 return value;
}
