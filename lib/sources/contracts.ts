import type {JsonValue} from '../workspace-protocol.ts';
import type {EvidenceRef} from '../evidence-contract.ts';

export type SourceKind='github_repository'|'github_file'|'document'|'conversation_export';
export type AccessMode='interactive'|'unattended';
export type SourceState='disconnected'|'needs_connection'|'syncing'|'fresh'|'stale'|'failed'|'unsupported'|'paused';
/** Owner selection only. This never contains credentials, provider grants or a principal. */
export interface SourceConnection {id:string;provider:'github'|'documents'|'conversation-export';label:string;accessMode:AccessMode;enabled:boolean;archivedAt:string|null}
export interface SourceTarget {id:string;connectionId:string;projectId:string;kind:SourceKind;providerResourceId:string;canonicalUrl:string|null;selectedPaths:string[];staleAfterSeconds:number;selectionVersion:number;archivedAt:string|null}
export interface SourceObservation {id:string;sourceId:string;externalId:string;sourceRevision:string;sourceUpdatedAt:string|null;observedAt:string;title:string;canonicalUrl:string|null;contentDigest:string;payload:{[key:string]:JsonValue};origin:'provider-read'|'manual-import'|'historical-import';contentAttachmentRef?:{id:string;sha256:string;bytes:number}}
export interface SourcePage {observations:SourceObservation[];nextCursor:string|null;nextEtag:string|null;unchanged:boolean}
export interface AdapterCapabilities {sourceKinds:SourceKind[];interactiveRead:boolean;unattendedRead:boolean;verifiedAt:string|null;blockedReason:string|null}
export interface SourceAdapter {capabilities(mode:AccessMode):Promise<AdapterCapabilities>;readPage(target:SourceTarget,context:{cursor:string|null;etag:string|null;observedAt:string;signal:AbortSignal}):Promise<SourcePage>}
/** Facet cursors/ETags belong to an exact selected resource and representation. */
export interface SourceCursor {version:1;selectionHash:string;resourceId:string;facet:string;pinnedRevision:string|null;continuation:string|null;etag:string|null}
export type SourceFailure='binding_unavailable'|'unsupported'|'request_context_expired'|'reauthentication_required'|'connector_access_disabled'|'rate_limited'|'not_found'|'invalid_content'|'timeout'|'upstream_error'|'configuration_changed'|'revoked'|'storage_capacity';
export class SourceReadError extends Error {readonly code:SourceFailure;readonly retryAfterMs:number|null;constructor(code:SourceFailure,message:string,retryAfterMs:number|null=null){super(message);this.name='SourceReadError';this.code=code;this.retryAfterMs=retryAfterMs;}}
export interface SourceObservationRef {id:string;contentDigest:string}
export type ProposalEntityKind='project'|'milestone'|'task'|'capture';
export interface ProposedField {field:string;before:JsonValue;after:JsonValue}
export interface SourceProposal {id:string;sourceId:string;observationRefs:SourceObservationRef[];evidenceRefs:EvidenceRef[];entity:{kind:ProposalEntityKind;id:string};baseWorkspaceRevision:number;fields:ProposedField[];rationale:string;confidence:'direct-source'|'inferred'|'unknown';createdAt:string;state:'pending'|'accepted'|'rejected'|'deferred'|'conflict';dedupKey:string;decision:{at:string;reason:string;selectedFields:string[]}|null}
export interface SourceRunHistory {id:string;sourceId:string;startedAt:string;finishedAt:string;outcome:'success'|'partial'|'unchanged'|'failed'|'cancelled';pages:number;observations:number;failure:SourceFailure|null;retryAt:string|null;sourceRevision:string|null}
/** Exported historical activity is data only; it cannot create executable intents. */
export interface IntegrationHistory {id:string;sourceId:string;kind:'source_refresh';attempt:number;startedAt:string;finishedAt:string;outcome:'success'|'partial'|'failed'|'cancelled';failure:SourceFailure|null}
export interface SourceSyncState {sourceId:string;operationalRevision:number;configurationHash:string;executionEpoch:number;paused:boolean;cursor:string|null;etag:string|null;attemptedAt:string|null;lastSuccessAt:string|null;lastSourceRevision:string|null;failure:SourceFailure|null;retryAt:string|null;failureCount:number}
export const SOURCE_LIMITS=Object.freeze({pageBytes:2*1024*1024,pageObservations:100,runPages:5,runObservations:250,runProviderMs:20_000,ownerObservations:10_000,ownerSources:100,ownerProposals:1000,payloadBytes:64*1024,excerptCharacters:8000,cursorBytes:16_000});
