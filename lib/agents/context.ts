import {canonical,contentHash} from '../canonical-json.ts';
import {evidenceDateSchema} from '../evidence-validation.ts';
import {readCurrent,type SqlDatabase} from '../workspace-store.ts';
import {readEvidenceSnapshot} from '../evidence-store.ts';
import {attachmentRecordSchema} from '../evidence-module.ts';
import {deviceAuthorityGuard} from '../devices/auth.ts';
import {agentCapabilitySchema,agentJobResultSchema,agentJobStatusSchema,agentIdSchema,AGENT_LIMITS,type AgentJobRecordV1} from './contracts.ts';
import {validateAgentJobRecord,agentExecutionBindingSha256,agentOperationEffects,validateAgentExecutionBinding} from './policy.ts';
import type {AgentCommandContext,AgentStateSnapshot,AgentApprovalCandidate} from './command-contracts.ts';
import type {JsonValue} from '../workspace-protocol.ts';
export interface AgentSqlGuard {sql:string;bindings:(string|number|null)[]}
const finite=(n:number)=>Number.isSafeInteger(n)&&n>=0;
export async function readAgentState(db:SqlDatabase,owner:string,id:string):Promise<AgentStateSnapshot|null>{
 agentIdSchema.parse(id);
 const row=await db.prepare('SELECT * FROM agent_job_state WHERE user_id=? AND job_id=?').bind(owner,id).first<{job_id:string;intent_id:string;status:string;operational_revision:number;spec_hash:string;task_hash:string;device_id:string|null;approval_id:string|null;attempt_id:string|null;execution_epoch:number;cancel_requested_at:string|null;cancel_request_id:string|null;updated_at:string;result_json:string|null;accepted_at:string|null;accepted_task_hash:string|null}>();
 if(!row)return null;
 if(!Number.isSafeInteger(row.operational_revision)||row.operational_revision<1||!finite(row.execution_epoch))throw new Error('Invalid private job revision.');
 return {jobId:row.job_id,intentId:row.intent_id,status:agentJobStatusSchema.parse(row.status),operationalRevision:row.operational_revision,specHash:row.spec_hash,taskHash:row.task_hash,deviceId:row.device_id,approvalId:row.approval_id,attemptId:row.attempt_id,executionEpoch:row.execution_epoch,cancelRequestedAt:row.cancel_requested_at,cancelRequestId:row.cancel_request_id,updatedAt:row.updated_at,result:row.result_json===null?null:agentJobResultSchema.parse(JSON.parse(row.result_json)),acceptedAt:row.accepted_at,acceptedTaskHash:row.accepted_task_hash};
}
/** No paths, credentials or provider configuration cross this read boundary. */
export function ownerAgentContext(db:SqlDatabase,owner:string,now:string):AgentCommandContext{
 if(!owner||owner.length>256)throw new Error('An authenticated owner is required.');evidenceDateSchema.parse(now);
 const context:AgentCommandContext={
 async taskInputs(taskId){
  agentIdSchema.parse(taskId);
  const workspace=(await readCurrent(db,owner,now)).workspace,task=workspace.tasks.find(row=>row.id===taskId);
  if(!task)throw new Error('The owner task is unavailable.');
  const snapshot=await readEvidenceSnapshot(db,owner,now),subjects=new Set(['task:'+task.id,'project:'+task.projectId,...(task.milestoneId?['milestone:'+task.milestoneId]:[])]);
  const relevant=(subject:{type:string;id:string})=>subjects.has(subject.type+':'+subject.id);
  const requirements=snapshot.requirements.filter(row=>relevant(row.subject)),links=snapshot.links.filter(row=>relevant(row.subject)),acceptances=snapshot.acceptances.filter(row=>relevant(row.subject));
  const versions=snapshot.evidenceVersions.filter(row=>links.some(link=>link.evidenceId===row.id&&link.evidenceVersion===row.version)||acceptances.some(a=>a.evidenceRefs.some(ref=>ref.id===row.id&&ref.version===row.version)));
  const decisions=snapshot.decisionVersions.filter(row=>row.subjects.some(relevant));
  const acceptanceGrants=(await db.prepare('SELECT record_id,content_hash FROM acceptance_owner_grants WHERE user_id=? ORDER BY record_id,content_hash LIMIT 10001').bind(owner).all<{record_id:string;content_hash:string}>()).results;
  const decisionGrants=(await db.prepare('SELECT decision_id,version,content_hash FROM decision_owner_grants WHERE user_id=? ORDER BY decision_id,version,content_hash LIMIT 10001').bind(owner).all<{decision_id:string;version:number;content_hash:string}>()).results;
  if(acceptanceGrants.length>10000||decisionGrants.length>10000)throw new Error('Acceptance inputs exceed their bounded read.');
  return JSON.parse(canonical({milestone:task.milestoneId?workspace.milestones.filter(row=>row.id===task.milestoneId).map(row=>({id:row.id,acceptance:row.acceptance,evidence:row.evidence,status:row.status,archivedAt:row.archivedAt})):[],requirements,links,acceptances,versions,decisions,heads:snapshot.evidenceHeads.filter(row=>versions.some(v=>v.id===row.id)),decisionHeads:snapshot.decisionHeads.filter(row=>decisions.some(v=>v.id===row.id)),attachments:snapshot.attachments.filter(row=>versions.some(v=>v.attachmentIds.includes(row.id))),acceptanceGrants:acceptanceGrants.filter(row=>acceptances.some(a=>a.id===row.record_id)),decisionGrants:decisionGrants.filter(row=>decisions.some(d=>d.id===row.decision_id&&d.version===row.version))})) as JsonValue;
 },
 state:id=>readAgentState(db,owner,id),
 async artifacts(ids){
  if(ids.length>AGENT_LIMITS.inputArtifacts||new Set(ids).size!==ids.length)throw new Error('Artifact input bound exceeded.');
  const refs=[];
  for(const id of ids){
   agentIdSchema.parse(id);
   const row=await db.prepare('SELECT payload_json,content_hash FROM attachments WHERE user_id=? AND id=?').bind(owner,id).first<{payload_json:string;content_hash:string}>();
   if(!row)throw new Error('The owner artifact is unavailable.');
   const value=attachmentRecordSchema.parse(JSON.parse(row.payload_json));
   if(value.id!==id||await contentHash(canonical(value))!==row.content_hash||value.status!=='ready'||value.sha256===null||value.actualBytes!==value.expectedBytes||value.expectedBytes>AGENT_LIMITS.inputBytes)throw new Error('Artifact metadata is not ready.');
   const object=await db.prepare('SELECT 1 FROM attachment_blob_objects WHERE user_id=? AND storage_key=? AND attachment_id=? AND bytes=? AND sha256=? AND verified_at IS NOT NULL AND purged_at IS NULL AND NOT EXISTS(SELECT 1 FROM attachment_blob_fences f WHERE f.user_id=? AND f.storage_key=?)').bind(owner,value.storageKey,id,value.expectedBytes,value.sha256,owner,value.storageKey).first();
   if(!object)throw new Error('Artifact byte identity is unavailable.');
   refs.push({id,sha256:value.sha256,bytes:value.expectedBytes});
  }
  if(refs.reduce((sum,row)=>sum+row.bytes,0)>AGENT_LIMITS.inputBytes)throw new Error('Artifact input bytes exceed the finite bound.');
  return refs;
 },
 async dependencies(record){
  const found=new Map<string,{id:string;ownerId:string;dependsOnJobIds:string[];status:ReturnType<typeof agentJobStatusSchema.parse>}>(),pending=[...record.spec.dependsOnJobIds];
  while(pending.length){
   const id=pending.shift()!;if(found.has(id))continue;if(found.size>=AGENT_LIMITS.graphNodes)throw new Error('Dependency graph exceeds its finite bound.');
   const row=await db.prepare('SELECT payload_json,content_hash FROM agent_jobs WHERE user_id=? AND id=?').bind(owner,id).first<{payload_json:string;content_hash:string}>();
   if(!row||await contentHash(canonical(JSON.parse(row.payload_json)))!==row.content_hash)throw new Error('Owner dependency is unavailable.');
   const job=await validateAgentJobRecord(JSON.parse(row.payload_json)),state=await readAgentState(db,owner,id);
   if(job.id!==id||job.historical||!state)throw new Error('Historical dependencies have no execution authority.');
   found.set(id,{id,ownerId:owner,dependsOnJobIds:job.spec.dependsOnJobIds,status:state.status});pending.push(...job.spec.dependsOnJobIds);
  }
  return [...found.values()];
 },
 async candidate(record,deviceId,budgetId){return (await readAgentApprovalCandidate(db,owner,record,deviceId,budgetId,now))?.candidate??null;}
 };
 return context;
}
export const agentCommandContext=ownerAgentContext;
/** Captures exact private rows for the owner compiler; the predicate is re-evaluated inside its batch. */
export async function readAgentApprovalCandidate(db:SqlDatabase,owner:string,record:AgentJobRecordV1,deviceId:string,budgetId:string,now:string):Promise<{candidate:AgentApprovalCandidate;guard:AgentSqlGuard}|null>{
 try{
  agentIdSchema.parse(deviceId);agentIdSchema.parse(budgetId);evidenceDateSchema.parse(now);await validateAgentJobRecord(record);if(record.historical)return null;
  const capRow=await db.prepare('SELECT manifest_hash,payload_json,reported_at,operational_revision,revoked_at FROM agent_capabilities WHERE user_id=? AND device_id=?').bind(owner,deviceId).first<{manifest_hash:string;payload_json:string;reported_at:string;operational_revision:number;revoked_at:string|null}>();
  if(!capRow||capRow.revoked_at!==null||!evidenceDateSchema.safeParse(capRow.reported_at).success||!Number.isSafeInteger(capRow.operational_revision)||capRow.operational_revision<1||capRow.operational_revision>=Number.MAX_SAFE_INTEGER)return null;
  const cap=agentCapabilitySchema.parse(JSON.parse(capRow.payload_json));
  if(cap.deviceId!==deviceId||await contentHash(canonical(cap))!==capRow.manifest_hash||Date.parse(cap.observedAt)>Date.parse(now)||Date.parse(cap.expiresAt)<=Date.parse(now)||Date.parse(capRow.reported_at)>Date.parse(now)||Date.parse(now)-Date.parse(capRow.reported_at)>AGENT_LIMITS.capabilityMs||cap.availableSlots!==1||!cap.operations.includes(record.spec.operation)||!cap.repositoryKeys.includes(record.spec.repositoryKey)||!cap.models.some(model=>model.id===record.spec.requestedModel&&model.efforts.includes(record.spec.effort))||cap.maxTimeoutSeconds<record.spec.timeoutSeconds||cap.maxOutputBytesLimit<record.spec.outputBytesLimit)return null;
  const credentials=(await db.prepare('SELECT id,scopes_json FROM device_credentials WHERE user_id=? AND device_id=? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 3').bind(owner,deviceId).all<{id:string;scopes_json:string}>()).results;
  let authority:AgentSqlGuard|null=null;
  for(const credential of credentials){const scopes=JSON.parse(credential.scopes_json) as string[];if(!Array.isArray(scopes)||!scopes.includes('jobs:poll')||!scopes.includes('jobs:report'))continue;authority=await deviceAuthorityGuard(db,{ownerId:owner,deviceId,credentialId:credential.id,scopes} as Parameters<typeof deviceAuthorityGuard>[1],now);if(authority)break;}
  if(!authority)return null;
  const budget=await db.prepare('SELECT * FROM agent_budgets WHERE user_id=? AND id=?').bind(owner,budgetId).first<{operational_revision:number;payload_json:string;maximum_jobs:number;maximum_seconds:number;reserved_jobs:number;reserved_seconds:number;charged_seconds:number;enabled:number}>();
  const reserved=await db.prepare('SELECT 1 FROM job_approvals a JOIN agent_job_state s ON s.user_id=a.user_id AND s.job_id=a.job_id AND s.approval_id=a.id WHERE a.user_id=? AND a.job_id=? AND a.device_id=? AND a.spec_hash=? AND a.revoked_at IS NULL AND json_extract(a.payload_json,\'$.reservationId\')=?').bind(owner,record.id,deviceId,record.specSha256,budgetId).first();
  if(!budget||canonical(JSON.parse(budget.payload_json))!==canonical({maximumJobs:budget.maximum_jobs,maximumSeconds:budget.maximum_seconds,enabled:budget.enabled===1})||budget.enabled!==1||budget.operational_revision<1||budget.operational_revision>=Number.MAX_SAFE_INTEGER||![budget.operational_revision,budget.maximum_jobs,budget.maximum_seconds,budget.reserved_jobs,budget.reserved_seconds,budget.charged_seconds].every(finite)||budget.reserved_jobs+(reserved?0:1)>budget.maximum_jobs||budget.reserved_seconds+budget.charged_seconds+(reserved?0:record.spec.timeoutSeconds)>budget.maximum_seconds||!!reserved&&(budget.reserved_jobs<1||budget.reserved_seconds<record.spec.timeoutSeconds))return null;
  const occupied=await db.prepare('SELECT 1 FROM agent_device_slots WHERE user_id=? AND device_id=? AND released_at IS NULL').bind(owner,deviceId).first();if(occupied)return null;
  const artifacts=await ownerAgentContext(db,owner,now).artifacts(record.spec.inputArtifactIds);
  const artifactGuards:AgentSqlGuard[]=[];
  for(const ref of artifacts){
   const row=await db.prepare('SELECT payload_json,content_hash,row_revision FROM attachments WHERE user_id=? AND id=?').bind(owner,ref.id).first<{payload_json:string;content_hash:string;row_revision:number}>();
   if(!row)return null;const value=attachmentRecordSchema.parse(JSON.parse(row.payload_json));
   if(value.id!==ref.id||value.status!=='ready'||value.sha256!==ref.sha256||value.expectedBytes!==ref.bytes||value.actualBytes!==ref.bytes||await contentHash(canonical(value))!==row.content_hash)return null;
   artifactGuards.push({sql:'EXISTS(SELECT 1 FROM attachments WHERE user_id=? AND id=? AND payload_json=? AND content_hash=? AND row_revision=?) AND EXISTS(SELECT 1 FROM attachment_blob_objects WHERE user_id=? AND storage_key=? AND attachment_id=? AND bytes=? AND sha256=? AND verified_at IS NOT NULL AND purged_at IS NULL) AND NOT EXISTS(SELECT 1 FROM attachment_blob_fences WHERE user_id=? AND storage_key=?)',bindings:[owner,ref.id,row.payload_json,row.content_hash,row.row_revision,owner,value.storageKey,ref.id,ref.bytes,ref.sha256,owner,value.storageKey]});
  }
  const binding=validateAgentExecutionBinding(record.spec,{schemaVersion:1,provider:cap.provider,requestedModel:record.spec.requestedModel,effort:record.spec.effort,runtime:cap.runtime,capabilitySha256:capRow.manifest_hash,configurationSha256:cap.configurationSha256,allowedPathsSha256:cap.allowedPathsSha256ByRepositoryKey[record.spec.repositoryKey],artifactRefs:artifacts,effects:agentOperationEffects(record.spec.operation),budget:{jobs:1,timeoutSeconds:record.spec.timeoutSeconds,outputBytesLimit:record.spec.outputBytesLimit,inputBytesLimit:artifacts.reduce((sum,row)=>sum+row.bytes,0),payment:'subscription-only',costDollars:null},modelIdentityPolicy:cap.modelIdentityPolicy});
  const candidate={deviceId,capabilityHash:capRow.manifest_hash,bindingHash:await agentExecutionBindingSha256(binding),budgetId,expiresAt:cap.expiresAt,binding};
  return {candidate,guard:{sql:'('+authority.sql+(artifactGuards.length?' AND '+artifactGuards.map(row=>'('+row.sql+')').join(' AND '):'')+' AND EXISTS(SELECT 1 FROM agent_capabilities WHERE user_id=? AND device_id=? AND manifest_hash=? AND payload_json=? AND reported_at=? AND operational_revision=? AND revoked_at IS NULL) AND EXISTS(SELECT 1 FROM agent_budgets WHERE user_id=? AND id=? AND operational_revision=? AND payload_json=? AND maximum_jobs=? AND maximum_seconds=? AND reserved_jobs=? AND reserved_seconds=? AND charged_seconds=? AND enabled=1) AND NOT EXISTS(SELECT 1 FROM agent_device_slots WHERE user_id=? AND device_id=? AND released_at IS NULL))',bindings:[...authority.bindings,...artifactGuards.flatMap(row=>row.bindings),owner,deviceId,capRow.manifest_hash,capRow.payload_json,capRow.reported_at,capRow.operational_revision,owner,budgetId,budget.operational_revision,budget.payload_json,budget.maximum_jobs,budget.maximum_seconds,budget.reserved_jobs,budget.reserved_seconds,budget.charged_seconds,owner,deviceId]}};
 }catch{return null;}
}
