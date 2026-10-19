import {z} from 'zod';
import {evidenceDateSchema} from '../evidence-validation.ts';
export const AGENT_LIMITS=Object.freeze({pendingJobs:12,graphNodes:256,dependencies:8,inputArtifacts:8,inputBytes:32768,eventBatch:50,eventBytes:65536,timeoutMin:30,timeoutMax:600,outputBytes:2097152,resultBytes:10485760,approvalMs:86400000,capabilityMs:300000,leaseMs:60000,renewMs:15000});
export const agentIdSchema=z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
export const agentAliasSchema=z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u);
export const agentModelSchema=z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:+-]*$/u);
export const agentDigestSchema=z.string().regex(/^[a-f0-9]{64}$/u);
export const agentCommitSchema=z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
export const agentOperationSchema=z.enum(['project.inspect','project.propose-patch']);
export const agentProviderSchema=z.enum(['codex','claude']);
export const agentEffortSchema=z.enum(['low','medium','high','xhigh','max','ultra']);
export const agentJobStatusSchema=z.enum(['awaiting_approval','queued','leased','running','cancelling','succeeded','failed','cancelled','blocked','reconcile_required','rejected']);
const count=z.number().int().nonnegative().safe(),positive=z.number().int().positive().safe(),unique=(values:readonly string[])=>new Set(values).size===values.length;
const ids=(max:number)=>z.array(agentIdSchema).max(max).refine(unique,'Duplicate immutable identity.');
/** EXACT fourteen-field JobSpecV1 from the plan. Array order is part of immutable intent. */
export const agentJobSpecSchema=z.object({schemaVersion:z.literal(1),operation:agentOperationSchema,projectId:agentIdSchema,taskId:agentIdSchema,baseWorkspaceRevision:positive,taskSnapshotSha256:agentDigestSchema,repositoryKey:agentAliasSchema,baseCommit:agentCommitSchema,inputArtifactIds:ids(8),requestedModel:agentModelSchema,effort:agentEffortSchema,timeoutSeconds:z.number().int().min(30).max(600),outputBytesLimit:z.number().int().min(1).max(AGENT_LIMITS.outputBytes),dependsOnJobIds:ids(8)}).strict();
export const agentJobRequestSchema=agentJobSpecSchema.omit({schemaVersion:true,baseWorkspaceRevision:true,taskSnapshotSha256:true});
export const agentRuntimeIdentitySchema=z.object({version:agentModelSchema,sourceCommit:agentCommitSchema,packageSha256:agentDigestSchema,toolPolicy:agentAliasSchema,executableSha256:agentDigestSchema,executableVersion:z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9 .+_-]*$/u),toolPolicySha256:agentDigestSchema}).strict();
export const agentArtifactRefSchema=z.object({id:agentIdSchema,sha256:agentDigestSchema,bytes:count.max(AGENT_LIMITS.inputBytes)}).strict();
/** Provider/runtime/resource and budget pins are outside the immutable plan JobSpec. */
export const agentExecutionBindingSchema=z.object({schemaVersion:z.literal(1),provider:agentProviderSchema,requestedModel:agentModelSchema,effort:agentEffortSchema,runtime:agentRuntimeIdentitySchema,capabilitySha256:agentDigestSchema,configurationSha256:agentDigestSchema,allowedPathsSha256:agentDigestSchema,artifactRefs:z.array(agentArtifactRefSchema).max(8),effects:z.array(z.enum(['repository.read','report.write','isolated-worktree.write','patch.write'])).min(1).max(4),budget:z.object({jobs:z.literal(1),timeoutSeconds:z.number().int().min(30).max(600),outputBytesLimit:z.number().int().min(1).max(AGENT_LIMITS.outputBytes),inputBytesLimit:z.number().int().min(0).max(AGENT_LIMITS.inputBytes),payment:z.literal('subscription-only'),costDollars:z.null()}).strict(),modelIdentityPolicy:z.enum(['require-observed','allow-unverified'])}).strict().superRefine((value,ctx)=>{if(new Set(value.artifactRefs.map(ref=>ref.id)).size!==value.artifactRefs.length||new Set(value.effects).size!==value.effects.length)ctx.addIssue({code:'custom',message:'Duplicate binding identity.'});if(value.artifactRefs.reduce((total,ref)=>total+ref.bytes,0)>value.budget.inputBytesLimit)ctx.addIssue({code:'custom',message:'Input bytes exceed the finite bound.'});});
/** Compatibility envelope only: native-looking JSON never creates a private approval grant. */
export const agentApprovalSchema=z.object({id:agentIdSchema,jobId:agentIdSchema,deviceId:agentIdSchema,specSha256:agentDigestSchema,capabilitySha256:agentDigestSchema,configurationSha256:agentDigestSchema,taskSnapshotSha256:agentDigestSchema,approvedAt:evidenceDateSchema,expiresAt:evidenceDateSchema,revokedAt:evidenceDateSchema.nullable(),attempts:z.literal(1),budget:z.object({jobs:z.literal(1),timeoutSeconds:z.number().int().min(30).max(600)}).strict(),origin:z.enum(['native-owner','historical-import'])}).strict().superRefine((value,ctx)=>{const ms=Date.parse(value.expiresAt)-Date.parse(value.approvedAt);if(ms<=0||ms>AGENT_LIMITS.approvalMs)ctx.addIssue({code:'custom',message:'Approval expires within twenty-four hours.'});});
export const agentApprovalEnvelopeSchema=z.object({approval:agentApprovalSchema,executionBinding:agentExecutionBindingSchema,bindingSha256:agentDigestSchema,reservationId:agentIdSchema,approverId:agentIdSchema}).strict();
export const agentJobRecordSchema=z.object({id:agentIdSchema,intentId:agentIdSchema,spec:agentJobSpecSchema,specSha256:agentDigestSchema,createdAt:evidenceDateSchema,retryOfJobId:agentIdSchema.nullable(),historical:z.boolean()}).strict();
export const agentDiagnosticSchema=z.enum(['ok','not_installed','capability_stale','policy_blocked','auth_required','quota_exhausted','model_mismatch','timeout','cancel_requested','exit_unconfirmed','artifact_invalid','transport_unavailable','unknown']);
const eventBase={schemaVersion:z.literal(1),attemptId:agentIdSchema,epoch:count,sequence:positive,observedAt:evidenceDateSchema,diagnostic:agentDiagnosticSchema};
export const agentJobEventSchema=z.discriminatedUnion('kind',[
 z.object({...eventBase,kind:z.literal('accepted'),details:z.object({specSha256:agentDigestSchema,capabilitySha256:agentDigestSchema}).strict()}).strict(),
 z.object({...eventBase,kind:z.literal('started'),details:z.object({runtimePackageSha256:agentDigestSchema,toolPolicySha256:agentDigestSchema,requestedModel:agentModelSchema,observedModel:agentModelSchema.nullable()}).strict()}).strict(),
 z.object({...eventBase,kind:z.literal('model_observed'),details:z.object({requestedModel:agentModelSchema,observedModel:agentModelSchema.nullable(),observedModels:z.array(agentModelSchema).max(32).refine(unique,'Duplicate observed model.'),modelVerified:z.boolean()}).strict().superRefine((value,ctx)=>{const observed=value.observedModels.length===1?value.observedModels[0]:null,verified=observed!==null&&observed===value.requestedModel;if(value.observedModel!==observed||value.modelVerified!==verified)ctx.addIssue({code:'custom',message:'Observed model evidence is contradictory.'});})}).strict(),
 z.object({...eventBase,kind:z.literal('progress'),details:z.object({stage:z.enum(['preparing','executing','validating','uploading']),completedUnits:count.max(10000),totalUnits:count.max(10000).nullable()}).strict()}).strict(),
 z.object({...eventBase,kind:z.literal('cancel_acknowledged'),details:z.object({requestId:agentIdSchema,exitConfirmed:z.boolean()}).strict()}).strict(),
 z.object({...eventBase,kind:z.literal('process_exit'),details:z.object({exitCode:z.number().int().min(-255).max(255).nullable(),processExitConfirmed:z.boolean(),terminationUnconfirmed:z.boolean()}).strict()}).strict(),
 z.object({...eventBase,kind:z.literal('artifact_ready'),details:z.object({artifactId:agentIdSchema,sha256:agentDigestSchema,bytes:count.max(AGENT_LIMITS.resultBytes),type:z.enum(['text/plain','text/markdown','text/x-diff','application/json'])}).strict()}).strict(),
 z.object({...eventBase,kind:z.literal('completed'),details:z.object({resultSha256:agentDigestSchema}).strict()}).strict(),
 z.object({...eventBase,kind:z.literal('blocked'),details:z.object({reason:agentDiagnosticSchema}).strict()}).strict()
]);
export const agentJobResultSchema=z.object({attemptId:agentIdSchema,epoch:count,disposition:z.enum(['succeeded','failed','cancelled','blocked']),requestedModel:agentModelSchema,observedModel:agentModelSchema.nullable(),modelVerified:z.boolean(),terminalProtocolObserved:z.boolean(),processExitConfirmed:z.boolean(),terminationUnconfirmed:z.boolean(),artifactIds:ids(100),usage:z.object({inputTokens:count.nullable(),outputTokens:count.nullable(),runtimeSeconds:z.number().finite().min(0).max(600).nullable(),costDollars:z.number().finite().nonnegative().nullable()}).strict().nullable(),diagnostic:agentDiagnosticSchema}).strict().superRefine((value,ctx)=>{if(value.observedModel===null&&value.modelVerified||value.observedModel!==null&&value.observedModel!==value.requestedModel&&value.modelVerified||value.processExitConfirmed&&value.terminationUnconfirmed)ctx.addIssue({code:'custom',message:'Execution evidence is contradictory.'});});
export type AgentOperation=z.infer<typeof agentOperationSchema>;
export type AgentProvider=z.infer<typeof agentProviderSchema>;
export type AgentEffort=z.infer<typeof agentEffortSchema>;
export type AgentJobStatus=z.infer<typeof agentJobStatusSchema>;
export type AgentJobSpecV1=z.infer<typeof agentJobSpecSchema>;
export type JobSpecV1=AgentJobSpecV1;
export type AgentJobRequestV1=z.infer<typeof agentJobRequestSchema>;
export type AgentRuntimeIdentityV1=z.infer<typeof agentRuntimeIdentitySchema>;
export type AgentExecutionBindingV1=z.infer<typeof agentExecutionBindingSchema>;
export type AgentApprovalV1=z.infer<typeof agentApprovalSchema>;
export type AgentApprovalEnvelopeV1=z.infer<typeof agentApprovalEnvelopeSchema>;
export type AgentJobRecordV1=z.infer<typeof agentJobRecordSchema>;
export type PortableAgentJobRecordV1=AgentJobRecordV1;
export type AgentJobEventV1=z.infer<typeof agentJobEventSchema>;
export type JobEventV1=AgentJobEventV1;
export type AgentJobResultV1=z.infer<typeof agentJobResultSchema>;
export type JobResultV1=AgentJobResultV1;

export const portableAgentJobRecordSchema=agentJobRecordSchema;
export type AgentRequest=AgentJobRequestV1;
export type AgentJobRecord=AgentJobRecordV1;
export type ExecutionBindingV1=AgentExecutionBindingV1;

export const agentCapabilitySchema=z.object({schemaVersion:z.literal(1),deviceId:agentIdSchema,configurationSha256:agentDigestSchema,provider:agentProviderSchema,runtime:agentRuntimeIdentitySchema,operations:z.array(agentOperationSchema).max(2).refine(values=>new Set(values).size===values.length),models:z.array(z.object({id:agentModelSchema,efforts:z.array(agentEffortSchema).min(1).max(6).refine(values=>new Set(values).size===values.length)}).strict()).max(32),repositoryKeys:z.array(agentAliasSchema).max(32).refine(values=>new Set(values).size===values.length),observedAt:evidenceDateSchema,expiresAt:evidenceDateSchema,maxConcurrent:z.literal(1),availableSlots:z.number().int().min(0).max(1),maxTimeoutSeconds:z.number().int().min(30).max(600),maxOutputBytesLimit:z.number().int().min(1).max(AGENT_LIMITS.outputBytes),allowedPathsSha256ByRepositoryKey:z.record(agentAliasSchema,agentDigestSchema),modelIdentityPolicy:z.enum(['require-observed','allow-unverified']),subscriptionOnly:z.literal(true),extraUsageOffAttested:z.literal(true)}).strict().superRefine((value,ctx)=>{const lifetime=Date.parse(value.expiresAt)-Date.parse(value.observedAt);if(lifetime<=0||lifetime>AGENT_LIMITS.capabilityMs)ctx.addIssue({code:'custom',message:'Capability expires within five minutes.'});if(new Set(value.models.map(row=>row.id)).size!==value.models.length)ctx.addIssue({code:'custom',message:'Duplicate exact model.'});const keys=Object.keys(value.allowedPathsSha256ByRepositoryKey);if(keys.length!==value.repositoryKeys.length||keys.some(key=>!value.repositoryKeys.includes(key)))ctx.addIssue({code:'custom',message:'Repository path digests differ from selected aliases.'});});
export type AgentCapabilityV1=z.infer<typeof agentCapabilitySchema>;

/** Portable historical result claims are never executable or owner acceptance grants. */
export const agentResultRecordSchema=z.object({id:agentIdSchema,jobId:agentIdSchema,attemptId:agentIdSchema,recordedAt:evidenceDateSchema,frozenJob:agentJobRecordSchema,result:agentJobResultSchema,resultSha256:agentDigestSchema,historical:z.boolean()}).strict().refine(value=>value.attemptId===value.result.attemptId&&value.jobId===value.frozenJob.id,'Result attempt or frozen proposal identity differs.').refine(value=>new TextEncoder().encode(JSON.stringify(value)).byteLength<=24_576,'Portable result metadata exceeds its reserved bound.');
export const portableAgentResultRecordSchema=agentResultRecordSchema;
export type AgentResultRecordV1=z.infer<typeof agentResultRecordSchema>;
export type PortableAgentResultRecordV1=AgentResultRecordV1;
