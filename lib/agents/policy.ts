import {z} from 'zod';
import type {Task,Workspace} from '../types.ts';
import type {JsonValue} from '../workspace-protocol.ts';
import {canonical,contentHash} from '../canonical-json.ts';
import {evidenceDateSchema} from '../evidence-validation.ts';
import {AGENT_LIMITS,agentCapabilitySchema,agentJobSpecSchema,agentJobRequestSchema,agentJobRecordSchema,agentExecutionBindingSchema,agentApprovalSchema,agentApprovalEnvelopeSchema,agentJobResultSchema,agentJobEventSchema,agentIdSchema,agentJobStatusSchema,type AgentJobSpecV1,type AgentJobRecordV1,type AgentApprovalEnvelopeV1,type AgentExecutionBindingV1,type AgentJobResultV1} from './contracts.ts';
export class AgentPolicyError extends Error {constructor(readonlyCode:string){super(readonlyCode);this.name='AgentPolicyError';}}
/** Validate bounded ordinary JSON without invoking getters or accepting executable objects. */
function boundedJson(value:unknown,maxBytes=262144):JsonValue{
 const walk=(entry:unknown,depth:number):void=>{if(depth>24)throw new AgentPolicyError('input_depth_exceeded');if(entry===null||typeof entry==='string'||typeof entry==='boolean'||typeof entry==='number'&&Number.isFinite(entry))return;if(!entry||typeof entry!=='object'||Object.getPrototypeOf(entry)!==Object.prototype&&!Array.isArray(entry))throw new AgentPolicyError('input_not_plain_json');for(const [key,descriptor]of Object.entries(Object.getOwnPropertyDescriptors(entry))){if(Array.isArray(entry)&&key==='length')continue;if(!('value'in descriptor)||['__proto__','prototype','constructor'].includes(key))throw new AgentPolicyError('input_not_plain_json');walk(descriptor.value,depth+1);}};
 walk(value,0);if(new TextEncoder().encode(canonical(value)).byteLength>maxBytes)throw new AgentPolicyError('input_byte_bound');return value as JsonValue;
}
/** Task IDs survive intact. updatedAt/createdAt are not semantic task revisions.
 * Server-derived acceptance inputs must include exact currently linked criteria,
 * versions and owner assessments; a browser cannot choose this projection. */
export function agentTaskSemanticProjection(task:Task,acceptanceInputs:JsonValue):JsonValue{
 boundedJson(task);boundedJson(acceptanceInputs);if(!Array.isArray(task.dependsOn)||new Set(task.dependsOn).size!==task.dependsOn.length)throw new AgentPolicyError('duplicate_task_dependency');
 return {id:task.id,projectId:task.projectId,milestoneId:task.milestoneId,title:task.title,notes:task.notes,status:task.status,horizon:task.horizon,priority:task.priority,dueDate:task.dueDate,weekly:task.weekly,weeklyWeek:task.weeklyWeek??null,estimateMinutes:task.estimateMinutes??null,dependsOn:[...task.dependsOn].sort(),blocker:task.blocker,sourceUrl:task.sourceUrl,evidence:task.evidence,completedAt:task.completedAt,archivedFromStatus:task.archivedFromStatus??null,acceptanceInputs};
}
export function agentTaskInputBytes(task:Task,acceptanceInputs:JsonValue):number{const bytes=new TextEncoder().encode(canonical(agentTaskSemanticProjection(task,acceptanceInputs))).byteLength;if(bytes>AGENT_LIMITS.inputBytes)throw new AgentPolicyError('task_prompt_bytes_exceeded');return bytes;}
export async function agentTaskSnapshotSha256(task:Task,acceptanceInputs:JsonValue):Promise<string>{return contentHash(canonical(agentTaskSemanticProjection(task,acceptanceInputs)));}
export async function agentJobSpecSha256(raw:unknown):Promise<string>{return contentHash(canonical(agentJobSpecSchema.parse(raw)));}
/** Capture a request into immutable DATA only; no provider, approval, lease or process is admitted. */
export async function buildAgentJobSpec(raw:unknown,context:{workspace:Workspace;workspaceRevision:number;acceptanceInputs:JsonValue}):Promise<AgentJobSpecV1>{
 const request=agentJobRequestSchema.parse(raw);if(!Number.isSafeInteger(context.workspaceRevision)||context.workspaceRevision<1)throw new AgentPolicyError('invalid_workspace_revision');
 const project=context.workspace.projects.find(row=>row.id===request.projectId),task=context.workspace.tasks.find(row=>row.id===request.taskId);
 if(!project||project.archivedAt||!task||task.projectId!==project.id||task.status==='archived')throw new AgentPolicyError('active_owner_task_unavailable');
 if(task.milestoneId&&!context.workspace.milestones.some(row=>row.id===task.milestoneId&&row.projectId===project.id&&!row.archivedAt))throw new AgentPolicyError('active_owner_milestone_unavailable');
 agentTaskInputBytes(task,context.acceptanceInputs);
 return agentJobSpecSchema.parse({...request,schemaVersion:1,baseWorkspaceRevision:context.workspaceRevision,taskSnapshotSha256:await agentTaskSnapshotSha256(task,context.acceptanceInputs)});
}
export async function validateAgentJobRecord(raw:unknown):Promise<AgentJobRecordV1>{
 const record=agentJobRecordSchema.parse(raw);if(await agentJobSpecSha256(record.spec)!==record.specSha256||record.retryOfJobId===record.id||record.spec.dependsOnJobIds.includes(record.id))throw new AgentPolicyError('immutable_job_identity_differs');return record;
}
const effects={'project.inspect':['repository.read','report.write'],'project.propose-patch':['repository.read','report.write','isolated-worktree.write','patch.write']} as const;
export function agentOperationEffects(operation:AgentJobSpecV1['operation']):readonly string[]{return effects[operation];}
export function validateAgentExecutionBinding(specRaw:unknown,bindingRaw:unknown):AgentExecutionBindingV1{
 const spec=agentJobSpecSchema.parse(specRaw),binding=agentExecutionBindingSchema.parse(bindingRaw);
 if(binding.requestedModel!==spec.requestedModel||binding.effort!==spec.effort||binding.budget.timeoutSeconds!==spec.timeoutSeconds||binding.budget.outputBytesLimit!==spec.outputBytesLimit)throw new AgentPolicyError('exact_execution_binding_differs');
 if(canonical([...binding.effects].sort())!==canonical([...effects[spec.operation]].sort()))throw new AgentPolicyError('operation_effects_differ');
 if(binding.artifactRefs.length!==spec.inputArtifactIds.length||binding.artifactRefs.some(ref=>!spec.inputArtifactIds.includes(ref.id)))throw new AgentPolicyError('immutable_artifact_set_differs');
 return binding;
}
export async function agentExecutionBindingSha256(raw:unknown):Promise<string>{return contentHash(canonical(agentExecutionBindingSchema.parse(raw)));}
/** Reviewable immutable approval envelope; callers must separately authenticate owner,
 * reserve budget and CAS current capability/task/epoch before storing an active grant. */
export async function buildAgentApprovalEnvelope(specRaw:unknown,raw:{approval:unknown;executionBinding:unknown;reservationId:string;approverId:string},now:string):Promise<AgentApprovalEnvelopeV1>{
 evidenceDateSchema.parse(now);const spec=agentJobSpecSchema.parse(specRaw),approval=agentApprovalSchema.parse(raw.approval),binding=validateAgentExecutionBinding(spec,raw.executionBinding),specSha256=await agentJobSpecSha256(spec);
 if(approval.specSha256!==specSha256||approval.taskSnapshotSha256!==spec.taskSnapshotSha256||approval.capabilitySha256!==binding.capabilitySha256||approval.configurationSha256!==binding.configurationSha256||approval.budget.timeoutSeconds!==spec.timeoutSeconds||approval.origin!=='native-owner'||approval.revokedAt!==null||Date.parse(approval.approvedAt)>Date.parse(now)||Date.parse(approval.expiresAt)<=Date.parse(now))throw new AgentPolicyError('approval_identity_or_lifetime_differs');
 return agentApprovalEnvelopeSchema.parse({...raw,approval,executionBinding:binding,bindingSha256:await agentExecutionBindingSha256(binding)});
}
export async function validateAgentApprovalEnvelope(specRaw:unknown,raw:unknown,now:string):Promise<AgentApprovalEnvelopeV1>{
 const envelope=agentApprovalEnvelopeSchema.parse(raw),checked=await buildAgentApprovalEnvelope(specRaw,envelope,now);if(envelope.bindingSha256!==checked.bindingSha256)throw new AgentPolicyError('approval_binding_digest_differs');return checked;
}
/** This does not prove execution. Evidence is validated again against the claimed
 * device/attempt and actual private artifact checks in the terminal store. */
export function validateAgentResult(specRaw:unknown,bindingRaw:unknown,raw:unknown,checks:{adapterChecksPassed:boolean}):AgentJobResultV1{
 const spec=agentJobSpecSchema.parse(specRaw),binding=validateAgentExecutionBinding(spec,bindingRaw),result=agentJobResultSchema.parse(raw);if(result.requestedModel!==spec.requestedModel||result.usage?.runtimeSeconds!==null&&result.usage?.runtimeSeconds!==undefined&&result.usage.runtimeSeconds>spec.timeoutSeconds)throw new AgentPolicyError('result_execution_identity_differs');
 if(result.disposition==='succeeded'){
  if(!result.terminalProtocolObserved||!result.processExitConfirmed||result.terminationUnconfirmed||!checks.adapterChecksPassed)throw new AgentPolicyError('success_not_proven');
  if(result.observedModel!==null?(result.observedModel!==spec.requestedModel||!result.modelVerified):binding.modelIdentityPolicy!=='allow-unverified')throw new AgentPolicyError('exact_model_identity_unavailable');
 }
 if(result.disposition==='cancelled'&&(!result.processExitConfirmed||result.terminationUnconfirmed))throw new AgentPolicyError('cancellation_exit_unconfirmed');
 return result;
}
export function parseAgentEventBatch(raw:unknown){
 const events=z.array(agentJobEventSchema).min(1).max(AGENT_LIMITS.eventBatch).parse(raw);boundedJson(events,AGENT_LIMITS.eventBytes);const identities=events.map(event=>event.attemptId+':'+event.epoch+':'+event.sequence);if(new Set(identities).size!==identities.length)throw new AgentPolicyError('duplicate_event_sequence');
 for(const event of events){if(event.kind==='progress'&&event.details.totalUnits!==null&&event.details.completedUnits>event.details.totalUnits)throw new AgentPolicyError('progress_bounds_differ');if(event.kind==='process_exit'&&event.details.processExitConfirmed&&event.details.terminationUnconfirmed)throw new AgentPolicyError('process_exit_evidence_contradicts');}
 return events;
}
export const agentDependencyRecordSchema=z.object({id:agentIdSchema,ownerId:z.string().min(1).max(256),dependsOnJobIds:z.array(agentIdSchema).max(8).refine(ids=>new Set(ids).size===ids.length),status:agentJobStatusSchema}).strict();
export function validateAgentDependencyGraph(jobId:string,ownerId:string,raw:unknown,requireSucceeded=false){
 const rows=z.array(agentDependencyRecordSchema).min(1).max(AGENT_LIMITS.graphNodes).parse(raw),index=new Map(rows.map(row=>[row.id,row]));if(index.size!==rows.length||!index.has(jobId)||rows.some(row=>row.ownerId!==ownerId))throw new AgentPolicyError('dependency_owner_or_identity_differs');
 const colors=new Map<string,number>();const visit=(id:string)=>{if(colors.get(id)===1)throw new AgentPolicyError('dependency_cycle');if(colors.get(id)===2)return;const row=index.get(id);if(!row)throw new AgentPolicyError('dependency_missing');colors.set(id,1);for(const next of row.dependsOnJobIds){if(next===id)throw new AgentPolicyError('dependency_self');visit(next);}colors.set(id,2);};for(const row of rows)visit(row.id);
 if(requireSucceeded&&index.get(jobId)!.dependsOnJobIds.some(id=>index.get(id)!.status!=='succeeded'))throw new AgentPolicyError('dependency_not_succeeded');return rows;
}
export function defaultAgentExecution(){return Object.freeze({enabled:false as const,diagnostic:'not_installed' as const,operations:[] as readonly string[],providers:[] as readonly string[],maxJobs:0,maxBatchSeconds:0,maxConcurrent:1 as const});}

/** Capability is attested data, not authentication; its exact native owner/device
 * registration and current private approval must be checked by the eventual store. */
export async function buildAgentExecutionBinding(specRaw:unknown,capabilityRaw:unknown,input:{artifactRefs:unknown;budget:unknown;now:string;taskInput?:JsonValue}):Promise<AgentExecutionBindingV1>{
 const spec=agentJobSpecSchema.parse(specRaw),capability=agentCapabilitySchema.parse(capabilityRaw);evidenceDateSchema.parse(input.now);const now=Date.parse(input.now),model=capability.models.find(row=>row.id===spec.requestedModel);
 if(Date.parse(capability.observedAt)>now||Date.parse(capability.expiresAt)<=now||now-Date.parse(capability.observedAt)>AGENT_LIMITS.capabilityMs)throw new AgentPolicyError('capability_stale');
 if(capability.availableSlots!==1||!capability.operations.includes(spec.operation)||!capability.repositoryKeys.includes(spec.repositoryKey)||!model||!model.efforts.includes(spec.effort)||spec.timeoutSeconds>capability.maxTimeoutSeconds||spec.outputBytesLimit>capability.maxOutputBytesLimit)throw new AgentPolicyError('exact_capability_unavailable');
 const binding=validateAgentExecutionBinding(spec,{schemaVersion:1,provider:capability.provider,requestedModel:spec.requestedModel,effort:spec.effort,runtime:capability.runtime,capabilitySha256:await contentHash(canonical(capability)),configurationSha256:capability.configurationSha256,allowedPathsSha256:capability.allowedPathsSha256ByRepositoryKey[spec.repositoryKey],artifactRefs:input.artifactRefs,effects:[...effects[spec.operation]],budget:input.budget,modelIdentityPolicy:capability.modelIdentityPolicy});
 if(input.taskInput!==undefined){
  const taskInput=boundedJson(input.taskInput),serialized=canonical(taskInput),taskBytes=new TextEncoder().encode(serialized).byteLength,total=taskBytes+binding.artifactRefs.reduce((sum,row)=>sum+row.bytes,0);
  if(await contentHash(serialized)!==spec.taskSnapshotSha256)throw new AgentPolicyError('task_prompt_identity_differs');
  if(total>AGENT_LIMITS.inputBytes||binding.budget.inputBytesLimit!==total)throw new AgentPolicyError('combined_prompt_bytes_differ');
 }
 return binding;
}
