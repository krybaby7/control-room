import type {JsonValue} from '../workspace-protocol.ts';
import type {AgentJobRecordV1,AgentApprovalEnvelopeV1,AgentExecutionBindingV1,AgentJobStatus,AgentJobResultV1} from './contracts.ts';
export interface AgentStateSnapshot {jobId:string;intentId:string;status:AgentJobStatus;operationalRevision:number;specHash:string;taskHash:string;deviceId:string|null;approvalId:string|null;attemptId:string|null;executionEpoch:number;cancelRequestedAt:string|null;cancelRequestId:string|null;updatedAt:string;result:AgentJobResultV1|null;acceptedAt:string|null;acceptedTaskHash:string|null;}
export interface AgentApprovalCandidate {deviceId:string;capabilityHash:string;bindingHash:string;budgetId:string;expiresAt:string;binding:AgentExecutionBindingV1;}
export interface AgentCommandContext {
 taskInputs:(taskId:string)=>Promise<JsonValue>;
 state:(jobId:string)=>Promise<AgentStateSnapshot|null>;
 candidate:(record:AgentJobRecordV1,deviceId:string,budgetId:string)=>Promise<AgentApprovalCandidate|null>;
 artifacts:(ids:string[])=>Promise<Array<{id:string;sha256:string;bytes:number}>>;
 dependencies:(record:AgentJobRecordV1)=>Promise<Array<{id:string;ownerId:string;dependsOnJobIds:string[];status:AgentJobStatus}>>;
}
export type AgentControls=
 |{action:'create';record:AgentJobRecordV1}
 |{action:'approve';jobId:string;expectedOperationalRevision:number;candidate:AgentApprovalCandidate;envelope:AgentApprovalEnvelopeV1}
 |{action:'cancel'|'reject';requestId:string;jobId:string;expectedOperationalRevision:number}
 |{action:'accept-result';jobId:string;expectedOperationalRevision:number;resultHash:string;taskHash:string}
 |{action:'budget';id:string;expectedOperationalRevision:number|null;maximumJobs:number;maximumSeconds:number;enabled:boolean};
