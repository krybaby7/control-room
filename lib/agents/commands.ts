import {z} from 'zod';
import {canonical,contentHash} from '../canonical-json.ts';
import {parseAuditEvent} from '../audit-events.ts';
import type {CommandHandler,PrepareContext,MutationPlan} from '../workspace-transaction.ts';
import type {JsonValue} from '../workspace-protocol.ts';
import {agentIdSchema,agentDigestSchema,agentJobRequestSchema,agentJobRecordSchema,AGENT_LIMITS} from './contracts.ts';
import {buildAgentJobSpec,agentTaskInputBytes,agentJobSpecSha256,validateAgentJobRecord,agentTaskSnapshotSha256,buildAgentApprovalEnvelope,validateAgentDependencyGraph} from './policy.ts';
const positive=z.number().int().positive().safe();
export const createAgentCommandSchema=z.object({type:z.literal('jobs.create'),value:agentJobRequestSchema,retryOfJobId:agentIdSchema.optional()}).strict();
const target={id:agentIdSchema,expectedOperationalRevision:positive};
export const approveAgentCommandSchema=z.object({type:z.literal('jobs.approve'),...target,deviceId:agentIdSchema,expectedCapabilityHash:agentDigestSchema,expectedBindingHash:agentDigestSchema,budgetId:agentIdSchema}).strict();
const cancelSchema=z.object({type:z.enum(['jobs.cancel','jobs.reject']),...target}).strict();
const acceptSchema=z.object({type:z.literal('jobs.accept-result'),...target,expectedResultHash:agentDigestSchema,expectedTaskSnapshotSha256:agentDigestSchema}).strict();
const budgetSchema=z.object({type:z.literal('jobs.budget.configure'),id:agentIdSchema,expectedOperationalRevision:positive.nullable(),value:z.object({maximumJobs:z.number().int().min(0).max(12),maximumSeconds:z.number().int().min(0).max(7200),enabled:z.boolean()}).strict()}).strict();
function empty(c:PrepareContext):MutationPlan{return {planningAfter:structuredClone(c.before.workspace),writes:[],preconditions:[],events:[],jobs:[]};}
function runtime(c:PrepareContext){if(!c.agentRuntime)throw new Error('Agent coordinator is unavailable.');return c.agentRuntime;}
async function record(c:PrepareContext,id:string,p:MutationPlan){const row=await c.query.get('agent_jobs',id);if(!row||await contentHash(canonical(JSON.parse(row.payload_json)))!==row.content_hash)throw new Error('The owner job is unavailable.');const value=await validateAgentJobRecord(JSON.parse(row.payload_json));if(value.id!==id||value.historical)throw new Error('Historical job records have no execution authority.');p.preconditions!.push({table:'agent_jobs',id,expectedRowRevision:row.row_revision,expectedHash:row.content_hash});return value;}
async function currentTask(c:PrepareContext,taskId:string){const task=c.before.workspace.tasks.find(row=>row.id===taskId);if(!task)throw new Error('The owner task is unavailable.');return agentTaskSnapshotSha256(task,await runtime(c).taskInputs(taskId));}
function audit(c:PrepareContext,p:MutationPlan,id:string,after:JsonValue){p.events.push(parseAuditEvent({id:crypto.randomUUID(),kind:c.command.type,entityType:'agent-job',entityId:id,changes:[{path:['agent-job',id],before:{exists:false,value:null},after:{exists:true,value:after}}],origin:'owner',actorId:c.userId,occurredAt:c.now,sourceRef:null,undoOf:null}));}
const create:CommandHandler={async prepare(c){
 const input=createAgentCommandSchema.parse(c.command),p=empty(c),services=runtime(c),id=crypto.randomUUID(),intentId=crypto.randomUUID();
 const acceptanceInputs=await services.taskInputs(input.value.taskId),spec=await buildAgentJobSpec(input.value,{workspace:c.before.workspace,workspaceRevision:c.before.revision,acceptanceInputs});
 const task=c.before.workspace.tasks.find(row=>row.id===spec.taskId)!;
 const artifacts=await services.artifacts(spec.inputArtifactIds);if(artifacts.length!==spec.inputArtifactIds.length||agentTaskInputBytes(task,acceptanceInputs)+artifacts.reduce((n,a)=>n+a.bytes,0)>AGENT_LIMITS.inputBytes)throw new Error('Immutable input artifacts exceed the finite prompt bound.');
 if(input.retryOfJobId){const previous=await record(c,input.retryOfJobId,p),state=await services.state(previous.id);if(!state||!['succeeded','failed','cancelled','blocked','rejected'].includes(state.status))throw new Error('A retry requires confirmed reconciliation of the previous job.');}
 const value=agentJobRecordSchema.parse({id,intentId,spec,specSha256:await agentJobSpecSha256(spec),createdAt:c.now,retryOfJobId:input.retryOfJobId??null,historical:false});
 const dependencies=await services.dependencies(value);validateAgentDependencyGraph(id,c.userId,[{id,ownerId:c.userId,dependsOnJobIds:spec.dependsOnJobIds,status:'awaiting_approval'},...dependencies]);
 p.writes.push({table:'agent_jobs',operation:'insert',id,expectedRowRevision:null,value:value as unknown as JsonValue});p.jobs.push({id:intentId,kind:'agent.execute',dedupeKey:id,payload:{jobId:id,specSha256:value.specSha256},notBefore:c.now});p.agentControls={action:'create',record:value};audit(c,p,id,{id,intentId,specSha256:value.specSha256,status:'awaiting_approval'});return p;
}};
const approve:CommandHandler={async prepare(c){
 const input=approveAgentCommandSchema.parse(c.command),p=empty(c),value=await record(c,input.id,p),services=runtime(c),state=await services.state(value.id);
 if(!state||state.status!=='awaiting_approval'||state.operationalRevision!==input.expectedOperationalRevision||await currentTask(c,value.spec.taskId)!==value.spec.taskSnapshotSha256)throw new Error('The exact job or task changed. Create a fresh reviewed proposal.');
 const candidate=await services.candidate(value,input.deviceId,input.budgetId);if(!candidate||candidate.capabilityHash!==input.expectedCapabilityHash||candidate.bindingHash!==input.expectedBindingHash)throw new Error('The installed runtime, capability or finite budget is unavailable or changed.');
 const envelope=await buildAgentApprovalEnvelope(value.spec,{approval:{id:crypto.randomUUID(),jobId:value.id,deviceId:candidate.deviceId,specSha256:value.specSha256,capabilitySha256:candidate.capabilityHash,configurationSha256:candidate.binding.configurationSha256,taskSnapshotSha256:value.spec.taskSnapshotSha256,approvedAt:c.now,expiresAt:new Date(Date.parse(c.now)+AGENT_LIMITS.approvalMs).toISOString(),revokedAt:null,attempts:1,budget:{jobs:1,timeoutSeconds:value.spec.timeoutSeconds},origin:'native-owner'},executionBinding:candidate.binding,reservationId:candidate.budgetId,approverId:c.userId},c.now);
 p.agentControls={action:'approve',jobId:value.id,expectedOperationalRevision:state.operationalRevision,candidate,envelope};audit(c,p,value.id,{id:value.id,bindingHash:candidate.bindingHash,status:'queued'});return p;
}};
const cancel:CommandHandler={async prepare(c){
 const input=cancelSchema.parse(c.command),p=empty(c),value=await record(c,input.id,p),state=await runtime(c).state(value.id);
 if(!state||state.operationalRevision!==input.expectedOperationalRevision||['succeeded','failed','cancelled','blocked','rejected'].includes(state.status)||input.type==='jobs.reject'&&state.status!=='awaiting_approval')throw new Error('The exact job cannot accept this request.');
 p.agentControls={action:input.type==='jobs.reject'?'reject':'cancel',requestId:c.mutationId!,jobId:value.id,expectedOperationalRevision:state.operationalRevision};audit(c,p,value.id,{id:value.id,request:input.type});return p;
}};
const accept:CommandHandler={async prepare(c){
 const input=acceptSchema.parse(c.command),p=empty(c),value=await record(c,input.id,p),state=await runtime(c).state(value.id),taskHash=await currentTask(c,value.spec.taskId);
 if(!state||state.operationalRevision!==input.expectedOperationalRevision||state.status!=='succeeded'||!state.result||state.acceptedAt||taskHash!==input.expectedTaskSnapshotSha256||taskHash!==value.spec.taskSnapshotSha256||await contentHash(canonical(state.result))!==input.expectedResultHash)throw new Error('The exact successful result and current task must be reviewed again.');
 p.agentControls={action:'accept-result',jobId:value.id,expectedOperationalRevision:state.operationalRevision,resultHash:input.expectedResultHash,taskHash};audit(c,p,value.id,{id:value.id,resultHash:input.expectedResultHash,taskHash,acceptedAt:c.now});return p;
}};
const budget:CommandHandler={async prepare(c){const input=budgetSchema.parse(c.command),p=empty(c);if(input.value.enabled&&(!input.value.maximumJobs||!input.value.maximumSeconds))throw new Error('Enabled subscription execution requires an explicit finite job and wall-time budget.');p.agentControls={action:'budget',id:input.id,expectedOperationalRevision:input.expectedOperationalRevision,...input.value};audit(c,p,input.id,{id:input.id,...input.value,payment:'subscription-only',costDollars:null});return p;}};
export const agentCommandHandlers:ReadonlyMap<string,CommandHandler>=new Map([['jobs.create',create],['jobs.approve',approve],['jobs.cancel',cancel],['jobs.reject',cancel],['jobs.accept-result',accept],['jobs.budget.configure',budget]]);
