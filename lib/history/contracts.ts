export type WorkType = 'planning' | 'implementation' | 'testing' | 'review' | 'research' | 'decision' | 'operations' | 'other';
// Wire codec v1. Owner identity is supplied by authenticated storage, never wire data.
export type HistorySourceKind = 'codex_local' | 'codex_cloud' | 'claude_code_local' | 'claude_code_cloud';
export type Availability = 'complete' | 'partial' | 'unavailable';
export interface SourceCapability {
    sourceId: string;
    kind: HistorySourceKind;
    scopeLabel: string;
    inventory: 'verified' | 'partial' | 'unsupported' | 'unverified';
    contentRead: 'verified' | 'partial' | 'unsupported' | 'unverified';
    unattendedRead: boolean;
    verifiedAt: string | null;
    proofRef: string | null;
    limitation: string | null;
}
export interface ConversationRecord {
    id: string;
    sourceId: string;
    nativeThreadId: string;
    sessionTreeId: string | null;
    parentConversationId: string | null;
    title: string | null;
    projectId: string | null;
    repositoryIdentity: string | null;
    branch: string | null;
    createdAt: string | null;
    sourceUpdatedAt: string | null;
    archived: boolean | null;
    availability: Availability;
}
export interface MessageRevision {
    id: string;
    conversationId: string;
    nativeMessageId: string;
    revisionDigest: string;
    normalizationVersion: string;
    parentNativeMessageId: string | null;
    sequence: number;
    role: 'user' | 'assistant' | 'tool' | 'system';
    occurredAt: string | null;
    observedAt: string;
    bodyObjectKey: string;
    contentBytes: number;
    availability: Availability;
}
export interface Citation {
    messageRevisionId: string;
    revisionDigest: string;
    start: number;
    end: number;
}
export interface HistoryGap {
    id: string;
    sourceId: string;
    conversationId: string | null;
    kind: 'inventory' | 'missing_transcript' | 'missing_segment' | 'truncated_content' | 'attachment' | 'parse' | 'access' | 'scope';
    explanation: string;
    detectedAt: string;
    resolvedAt: string | null;
}
export interface CoverageSnapshot {
    sourceId: string;
    scopeLabel: string;
    inventoryComplete: boolean;
    contentComplete: boolean;
    discovered: number;
    complete: number;
    partial: number;
    unavailable: number;
    unresolvedGaps: number;
    lastInventorySuccessAt: string | null;
    lastContentSuccessAt: string | null;
    status: 'unverified' | 'syncing' | 'current' | 'partial' | 'stale' | 'error';
}
export interface CollectionPage {
    codecVersion: 1;
    sourceId: string;
    runId: string;
    pageId: string;
    previousCursor: string | null;
    nextCursor: string | null;
    inventoryExhausted: boolean;
    conversations: ConversationRecord[];
    messages: MessageRevision[];
    segments: HistorySegment[];
    attachments: HistoryAttachment[];
    gaps: HistoryGap[];
    objectManifest: Array<{
        key: string;
        sha256: string;
        bytes: number;
    }>;
}
export interface HistoryAdapter {
    capability(): Promise<SourceCapability>;
    readPage(cursor: string | null, signal: AbortSignal): Promise<CollectionPage>;
}
export interface CollectionEnvelope {
    protocolVersion: 1;
    epoch: string;
    scopeRevision: number;
    page: CollectionPage;
}
export interface IngestReceipt {
    sourceId: string;
    epoch: string;
    scopeRevision: number;
    pageId: string;
    pageDigest: string;
    committedCursor: string | null;
    watermark: string;
    committedAt: string;
}
export interface AreaStory {
    id: string;
    projectId: string;
    areaId: string;
    planningRevision: number;
    sourceWatermark: string;
    generatedAt: string;
    finished: Array<{
        text: string;
        citations: Citation[];
        claimIds: string[];
        basis: 'observed' | 'inferred' | 'accepted';
        acceptanceRef: string | null;
    }>;
    open: Array<{
        workItemId: string;
        text: string;
        citations: Citation[];
    }>;
    next: Array<{
        text: string;
        citations: Citation[];
        taskId: string | null;
    }>;
    unknowns: string[];
    contradictions: string[];
}
export interface HistorySegment {
    id: string;
    sourceId: string;
    conversationId: string;
    nativeSegmentId: string;
    inheritedFromSegmentId: string | null;
    inheritedRange: {
        unit: 'bytes' | 'records';
        start: number;
        end: number;
    } | null;
    sha256: string | null;
    bytes: number | null;
    objectKey: string | null;
    availability: Availability;
    unavailableReason: string | null;
}
export interface HistoryAttachment {
    id: string;
    messageRevisionId: string;
    nativeAttachmentId: string | null;
    name: string;
    mediaType: string | null;
    sha256: string | null;
    bytes: number | null;
    objectKey: string | null;
    availability: Availability;
    unavailableReason: string | null;
}
export interface RoadmapScope {
    id: string;
    projectId: string;
    areaId: string;
    revision: number;
    agreedAt: string | null;
    checkpoints: Array<{
        id: string;
        label: string;
        acceptance: string;
        mandatory: boolean;
        milestoneId: string | null;
        taskIds: string[];
    }>;
}
export interface CheckpointAcceptance {
    id: string;
    scopeId: string;
    scopeRevision: number;
    checkpointId: string;
    verdict: 'accepted' | 'reopened';
    reason: string;
    claimIds: string[];
    recordedAt: string;
}
export type RoadmapCommand = {
    type: 'roadmap.set';
    projectId: string;
    areaId: string;
    expectedScopeRevision: number | null;
    checkpoints: RoadmapScope['checkpoints'];
} | {
    type: 'roadmap.agree';
    scopeId: string;
    expectedScopeRevision: number;
} | {
    type: 'checkpoint.assess';
    scopeId: string;
    expectedScopeRevision: number;
    checkpointId: string;
    verdict: CheckpointAcceptance['verdict'];
    reason: string;
    claimIds: string[];
};
export interface SourceContext {
    sourceId: string;
    conversationId: string;
    messageRevisionId: string;
    repositoryIdentity: string | null;
    branch: string | null;
    commit: string | null;
    basis: 'provider_metadata' | 'cited_text' | 'owner_override';
}
export interface HistoryClaim {
    id: string;
    projectId: string;
    areaId: string | null;
    kind: 'intent' | 'implementation' | 'verification' | 'release' | 'decision' | 'cancellation' | 'supersession';
    text: string;
    basis: 'observed' | 'inferred';
    citations: Citation[];
    supportingEvidence: Array<{
        kind: 'repository';
        snapshotId: string;
        digest: string;
    }>;
    context: SourceContext;
    supersedesClaimId: string | null;
    extractorVersion: string;
}
export interface HistoryWorkItem {
    id: string;
    projectId: string;
    areaId: string | null;
    workType: WorkType;
    title: string;
    state: 'open' | 'observed_finished' | 'cancelled' | 'superseded';
    disposition: 'requested' | 'idea' | 'proposal';
    taskId: string | null;
    claimIds: string[];
    supersededById: string | null;
    rowRevision: number;
}
export interface AreaProgress {
    projectId: string;
    areaId: string;
    planningRevision: number;
    sourceWatermark: string;
    observedFinishedWorkItemIds: string[];
    acceptedTaskIds: string[];
    openWorkItemIds: string[];
    roadmap: {
        scopeId: string;
        scopeRevision: number;
        agreed: boolean;
        defined: number;
        ownerAccepted: number;
        checkpoints: Array<{
            id: string;
            mandatory: boolean;
            observedStage: 'unknown' | 'planned' | 'in_progress' | 'implemented' | 'verified' | 'released';
            claimIds: string[];
            ownerAccepted: boolean;
            acceptanceRef: string | null;
        }>;
    } | null;
    coverageComplete: boolean;
    unknowns: string[];
}
export interface RepositoryEvidenceSnapshot {
    id: string;
    repositoryIdentity: string;
    kind: 'commit' | 'pull_request' | 'check' | 'deployment';
    sourceUrl: string;
    nativeRecordId: string;
    candidate: string | null;
    environment: string | null;
    conclusion: string | null;
    observedAt: string;
    contentDigest: string;
    bodyObjectKey: string;
    availability: Availability;
}
export interface SourceConfiguration {
    codecVersion: 1;
    sourceId: string;
    kind: HistorySourceKind;
    epoch: string;
    scopeRevision: number;
    roots: string[];
    accountId: string | null;
    deviceId: string | null;
    includeArchived: boolean;
    exclusions: string[];
    parserVersion: string;
    normalizationVersion: string;
}
export interface InventoryMembership {
    codecVersion: 1;
    sourceId: string;
    epoch: string;
    scopeRevision: number;
    generation: string;
    conversationId: string;
    archived: boolean | null;
    observedAt: string;
}
export interface AssociationRule {
    id: string;
    projectId: string;
    areaId: string | null;
    scope: 'conversation' | 'repository' | 'messages';
    targetIds: string[];
    reason: string;
    provenanceRef: string;
    rowRevision: number;
}
export interface AnalysisCheckpoint {
    id: string;
    sourceWatermark: string;
    inputDigest: string;
    normalizationVersion: string;
    extractorVersion: string;
    processedMessageRevisionIds: string[];
    processedSegmentIds: string[];
    affectedAreaIds: string[];
    state: 'pending' | 'complete' | 'invalid_result' | 'not_configured' | 'budget_exhausted' | 'unavailable' | 'cancelled';
}
export interface StoryCheckpoint {
    storyId: string;
    planningRevision: number;
    sourceWatermark: string;
    associationVersion: string;
    extractorVersion: string;
    inputDigest: string;
}
export interface WorkItemEvent {
    id: string;
    workItemId: string;
    operationId: string;
    inputDigest: string;
    claimIds: string[];
    state: HistoryWorkItem['state'];
    recordedAt: string;
}
export interface AreaLaneSummary {
    projectId: string;
    areaId: string | null;
    title: string;
    agreedScope: boolean;
    checkpoints: Array<{
        id: string;
        label: string;
        observed: 'unknown' | 'planned' | 'in_progress' | 'implemented' | 'verified' | 'released';
        accepted: boolean;
    }>;
    needsOwnerCount: number;
    nextAction: string | null;
    storyId: string | null;
    freshness: 'current' | 'syncing' | 'partial' | 'stale' | 'error' | 'unverified';
}

/**
 * S1 freeze proposal (integrator approval required before dependent workers):
 * - Codec/protocol v1, complete F3/C1/U1-U6/F6 records, and lane projection.
 * - MessageRevision adds required normalizationVersion so citation digests name
 *   immutable normalized text. revisionDigest hashes those UTF-8 bytes.
 * - SourceConfiguration is PRIVATE selection data, never capability/public export;
 *   exports must redact roots/account/device and restore disconnected enrollment.
 * - InventoryMembership names epoch + scope revision + inventory generation;
 *   partial generations cannot prove deletions or inventory exhaustion.
 * - AssociationRule, AnalysisCheckpoint, WorkItemEvent and StoryCheckpoint are
 *   additive proposals for persisted versioned inputs, not executable authority.
 * - Runtime schemas validate shape. Stores must resolve authenticated ownership,
 *   immutable supporting snapshots, acceptanceRef, claim IDs, branch/candidate,
 *   and citation semantic support; parsers cannot establish those truths.
 * - validateCollectionEnvelope accepts only finalized verified object metadata
 *   and retained IDs resolved under the authenticated owner by storage.
 * - canonicalEnvelopeDigest covers the complete envelope. Receipt pageDigest
 *   retains the proposed field name but means this entire-envelope digest.
 * - WorkType is locally declared until the integrator supplies shared planning
 *   classification; aliases must remain exactly equivalent at integration.
 * - No capabilities are enabled, and no runtime inference is configured here.
 */
/** Pre-freeze review clarification: retained-reference validation requires private
 * owner/source columns plus authenticatedOwnerId (never wire-provided). Segment
 * completeness requires verified byte/record metadata and paired bounded lineage;
 * unknown record bounds are incomplete. Current coverage requires both complete
 * inventories/content and nonnull success dates; freshness expiry remains a
 * projection responsibility and is not inferred from fixture/schema success. */
/** Inventory generation is server-side state: bind CollectionPage.runId to one
 * persisted generation at initial inventory under authenticated owner, source,
 * epoch and scopeRevision. A page never selects or changes that generation.
 * InventoryMembership.generation must match this binding. Exhausted run cursors
 * cannot establish completeness for another generation or changed scope. */
