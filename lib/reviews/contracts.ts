import type {JsonValue} from '../workspace-protocol.ts';
import type {EvidenceRef} from '../evidence-contract.ts';
import type {SourceObservationRef} from '../sources/contracts.ts';
export type ReviewEntityKind='project'|'milestone'|'task'|'capture';
export interface PlanningSnapshotRef {kind:ReviewEntityKind;id:string;workspaceRevision:number;contentHash:string}
export interface FrozenPlanningRecord extends PlanningSnapshotRef {value:{[key:string]:JsonValue}}
export type AuditSnapshotRef=
 |{eventId:string;contentHash:string;workspaceRevision:number;ordinal:number;streamId:null;sequence:null}
 |{eventId:string;contentHash:string;workspaceRevision:null;ordinal:null;streamId:string;sequence:number};
export interface FrozenAuditRecord {ref:AuditSnapshotRef;value:{[key:string]:JsonValue}}
export interface ReviewFact {id:string;projectId:string;kind:'progress'|'blocker'|'decision'|'deadline'|'stale';text:string;evidenceRefs:EvidenceRef[];decisionRefs:EvidenceRef[];observationRefs:SourceObservationRef[];planningRefs:PlanningSnapshotRef[];auditRefs:AuditSnapshotRef[];observedAt:string|null;sourceUpdatedAt:string|null;basis:'observed'|'documented'|'owner_decision'|'inference';href:string}
export interface ReviewScope {projectIds:string[];filterDigest:string}
export interface ReviewSnapshot {sourceStateBoundary?:Array<{sourceId:string;operationalRevision:number|null}>;id:string;scope:ReviewScope;workspaceRevision:number;operationalWatermarks:Record<string,number>;sourceWatermark:string;sourceSet:SourceObservationRef[];generatedAt:string;facts:ReviewFact[];unknowns:string[];decisionVersions:import('../evidence-contract.ts').DecisionVersion[];planningRecords:FrozenPlanningRecord[];auditRecords:FrozenAuditRecord[];coverage:{complete:boolean;remainingFacts:number;includedFactIds:string[];includedEventIds:string[]};modelRunId:string|null}
/** Portable acknowledgement is a historical claim. A private matching owner grant supplies read authority. */
export interface ReviewAcknowledgement {id:string;snapshotId:string;snapshotHash:string;scope:ReviewScope;acknowledgedAt:string;coveredFactIds:string[];coveredEventIds:string[]}
export type NotificationKind='blocker'|'decision'|'deadline'|'stale'|'job_completed'|'job_failed'|'recovery';
export interface NotificationEvent {id:string;dedupKey:string;kind:NotificationKind;severity:'info'|'warning'|'error';projectId:string|null;sourceId:string|null;title:string;body:string;href:string;createdAt:string;factIds:string[];snapshotRef:{id:string;hash:string}|null;observationRefs:SourceObservationRef[];evidenceRefs:EvidenceRef[]}
export interface NotificationPreferences {id:'notifications';mutedKinds:NotificationKind[];mutedSourceIds:string[];quietHours:{enabled:boolean;timezone:'Africa/Cairo';start:string;end:string};externalDelivery:'disabled'}
export interface AnalysisPolicy {id:'analysis';enabled:boolean;provider:string|null;model:string|null;maxCostDollars:number|null;maxInputBytes:number;maxOutputTokens:number;timeoutMs:number}
export type AnalysisStatus='not_configured'|'budget_exhausted'|'unavailable'|'cancelled'|'invalid_result'|'completed'|'uncertain';
export interface ReviewAnalysis {id:string;snapshotId:string;snapshotHash:string;provider:string;model:string;inputDigest:string;status:AnalysisStatus;startedAt:string;finishedAt:string|null;usage:{inputTokens:number|null;outputTokens:number|null;costDollars:number|null};suggestions:Array<{id:string;text:string;factIds:string[];evidenceRefs:EvidenceRef[];observationRefs:SourceObservationRef[]}>;diagnostic:string|null}
export const REVIEW_LIMITS=Object.freeze({facts:500,citationsPerFact:50,planningRecords:1000,auditRecords:1000,streams:100,factCharacters:8000,unknowns:100,unknownCharacters:1000,snapshotBytes:2*1024*1024,assemblyRows:10000,assemblyBytes:8*1024*1024,notifications:10000});
/** Server-selected, owner-scoped input. A caller must capture the revision/watermark vector coherently. */
export interface ReviewAssemblyInput {historyTruncated?:boolean;envelope:import('../types.ts').WorkspaceEnvelope;projectIds:string[];filterDigest:string;operationalWatermarks:Record<string,number>;observations:import('../sources/contracts.ts').SourceObservation[];sourceTargets:import('../sources/contracts.ts').SourceTarget[];sourceStates:import('../sources/contracts.ts').SourceSyncState[];evidence:import('../evidence-contract.ts').EvidenceVersion[];evidenceLinks:import('../evidence-contract.ts').EvidenceLink[];decisions:import('../evidence-contract.ts').DecisionVersion[];assessments:Array<{subject:import('../evidence-contract.ts').EvidenceSubject;status:'current'|'historical'|'needs-review'|'not-assessed';reasons:string[]}>;auditRecords:FrozenAuditRecord[];now:string}
