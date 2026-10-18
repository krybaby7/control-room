import type {EvidenceRef} from '../evidence-contract.ts';
import type {SourceObservationRef} from '../sources/contracts.ts';
export type BaselineParent={kind:'bundled';baselineId:'2026-10-17';key:'tamenni'|'trade-graph';packageHash:string}|{kind:'initial';projectHash:string}|{kind:'revision';id:string;hash:string};
/** Owner-reviewed context only. It grants no project, milestone, task or execution effects. */
export interface ProjectBaselineRevision {id:string;projectId:string;parent:BaselineParent;recordedAt:string;reviewedAsOf:string;snapshotRef:{id:string;hash:string};summary:string;accomplishments:string[];blockers:string[];unknowns:string[];ownerReason:string;observationRefs:SourceObservationRef[];evidenceRefs:EvidenceRef[];decisionRefs:EvidenceRef[];sourceWatermark:string;sourceFreshness:'verified-current'|'historical-or-unknown'}
export interface BaselineSourceProof {sourceId:string;observationId:string;contentDigest:string;operationalRevision:number;configurationHash:string;executionEpoch:number;lastSuccessAt:string;sourceRevision:string;origin:string}
export interface BaselinePreviewInput {projectId:string;snapshotId:string;snapshotHash:string;observationRefs:SourceObservationRef[];evidenceRefs:EvidenceRef[];decisionRefs:EvidenceRef[]}
export interface BaselineRevisionPreview {input:BaselinePreviewInput;parent:BaselineParent;workspaceRevision:number;operationalWatermarks:Record<string,number>;sourceProofs:BaselineSourceProof[];sourceWatermark:string;sourceFreshness:'verified-current'|'historical-or-unknown';limitations:string[];previewHash:string}
export const BASELINE_REVISION_LIMITS=Object.freeze({textCharacters:8000,listItems:50,citations:50,previewBytes:65536,ownerRows:1000});
