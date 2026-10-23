import { z } from 'zod';
import type * as C from './contracts.ts';
const str = z.string().min(1);
const count = z.number().int().nonnegative().safe();
export const digest = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.string().datetime({ offset: true });
export const WorkTypeSchema: z.ZodType<C.WorkType> = z.union([z.literal('planning'), z.literal('implementation'), z.literal('testing'), z.literal('review'), z.literal('research'), z.literal('decision'), z.literal('operations'), z.literal('other')]);
export const HistorySourceKindSchema: z.ZodType<C.HistorySourceKind> = z.union([z.literal('codex_local'), z.literal('codex_cloud'), z.literal('claude_code_local'), z.literal('claude_code_cloud')]);
export const AvailabilitySchema: z.ZodType<C.Availability> = z.union([z.literal('complete'), z.literal('partial'), z.literal('unavailable')]);
export const SourceCapabilitySchema: z.ZodType<C.SourceCapability> = z.object({
    sourceId: str, kind: HistorySourceKindSchema, scopeLabel: str, inventory: z.union([z.literal('verified'), z.literal('partial'), z.literal('unsupported'), z.literal('unverified')]), contentRead: z.union([z.literal('verified'), z.literal('partial'), z.literal('unsupported'), z.literal('unverified')]), unattendedRead: z.boolean(), verifiedAt: z.union([timestamp, z.null()]), proofRef: z.union([str, z.null()]), limitation: z.union([str, z.null()])
}).strict().refine(v => !v.unattendedRead || (v.inventory === 'verified' && v.contentRead === 'verified' && v.verifiedAt !== null && v.proofRef !== null), 'Unattended reading requires independent proof');
export const ConversationRecordSchema: z.ZodType<C.ConversationRecord> = z.object({
    id: str, sourceId: str, nativeThreadId: str, sessionTreeId: z.union([str, z.null()]), parentConversationId: z.union([str, z.null()]), title: z.union([str, z.null()]), projectId: z.union([str, z.null()]), repositoryIdentity: z.union([str, z.null()]), branch: z.union([str, z.null()]), createdAt: z.union([timestamp, z.null()]), sourceUpdatedAt: z.union([timestamp, z.null()]), archived: z.union([z.boolean(), z.null()]), availability: AvailabilitySchema
}).strict();
export const MessageRevisionSchema: z.ZodType<C.MessageRevision> = z.object({
    id: str, conversationId: str, nativeMessageId: str, revisionDigest: digest, normalizationVersion: str, parentNativeMessageId: z.union([str, z.null()]), sequence: count, role: z.union([z.literal('user'), z.literal('assistant'), z.literal('tool'), z.literal('system')]), occurredAt: z.union([timestamp, z.null()]), observedAt: timestamp, bodyObjectKey: str, contentBytes: count, availability: AvailabilitySchema
}).strict();
export const CitationSchema: z.ZodType<C.Citation> = z.object({
    messageRevisionId: str, revisionDigest: digest, start: count, end: count
}).strict().refine(v => v.end > v.start, 'Nonempty half-open range required');
export const HistoryGapSchema: z.ZodType<C.HistoryGap> = z.object({
    id: str, sourceId: str, conversationId: z.union([str, z.null()]), kind: z.union([z.literal('inventory'), z.literal('missing_transcript'), z.literal('missing_segment'), z.literal('truncated_content'), z.literal('attachment'), z.literal('parse'), z.literal('access'), z.literal('scope')]), explanation: str, detectedAt: timestamp, resolvedAt: z.union([timestamp, z.null()])
}).strict();
export const CoverageSnapshotSchema: z.ZodType<C.CoverageSnapshot> = z.object({
    sourceId: str, scopeLabel: str, inventoryComplete: z.boolean(), contentComplete: z.boolean(), discovered: count, complete: count, partial: count, unavailable: count, unresolvedGaps: count, lastInventorySuccessAt: z.union([timestamp, z.null()]), lastContentSuccessAt: z.union([timestamp, z.null()]), status: z.union([z.literal('unverified'), z.literal('syncing'), z.literal('current'), z.literal('partial'), z.literal('stale'), z.literal('error')])
}).strict().refine(v => v.complete + v.partial + v.unavailable === v.discovered && (!v.contentComplete || (v.inventoryComplete && v.partial === 0 && v.unavailable === 0 && v.unresolvedGaps === 0)), 'Inconsistent coverage').refine(v => v.status !== 'current' || (v.inventoryComplete && v.contentComplete && v.lastInventorySuccessAt !== null && v.lastContentSuccessAt !== null), 'Current coverage requires successful complete inventory and content');
export const HistorySegmentSchema: z.ZodType<C.HistorySegment> = z.object({
    id: str, sourceId: str, conversationId: str, nativeSegmentId: str, inheritedFromSegmentId: z.union([str, z.null()]), inheritedRange: z.union([z.object({
            unit: z.union([z.literal('bytes'), z.literal('records')]), start: count, end: count
        }).strict().refine(v => v.end > v.start), z.null()]), sha256: z.union([digest, z.null()]), bytes: z.union([count, z.null()]), objectKey: z.union([str, z.null()]), availability: AvailabilitySchema, unavailableReason: z.union([str, z.null()])
}).strict().refine(v => v.availability === 'complete' ? v.sha256 !== null && v.bytes !== null && v.objectKey !== null : v.availability !== 'unavailable' || (v.sha256 === null && v.objectKey === null && v.unavailableReason !== null), 'Invalid content availability').refine(v => (v.inheritedFromSegmentId === null) === (v.inheritedRange === null), 'Inherited lineage requires a paired range');
export const HistoryAttachmentSchema: z.ZodType<C.HistoryAttachment> = z.object({
    id: str, messageRevisionId: str, nativeAttachmentId: z.union([str, z.null()]), name: str, mediaType: z.union([str, z.null()]), sha256: z.union([digest, z.null()]), bytes: z.union([count, z.null()]), objectKey: z.union([str, z.null()]), availability: AvailabilitySchema, unavailableReason: z.union([str, z.null()])
}).strict().refine(v => v.availability === 'complete' ? v.sha256 !== null && v.bytes !== null && v.objectKey !== null : v.availability !== 'unavailable' || (v.sha256 === null && v.objectKey === null && v.unavailableReason !== null), 'Invalid content availability');
export const CollectionPageSchema: z.ZodType<C.CollectionPage> = z.object({
    codecVersion: z.literal(1), sourceId: str, runId: str, pageId: str, previousCursor: z.union([str, z.null()]), nextCursor: z.union([str, z.null()]), inventoryExhausted: z.boolean(), conversations: z.array(ConversationRecordSchema), messages: z.array(MessageRevisionSchema).max(250), segments: z.array(HistorySegmentSchema), attachments: z.array(HistoryAttachmentSchema), gaps: z.array(HistoryGapSchema), objectManifest: z.array(z.object({
        key: str, sha256: digest, bytes: count
    }).strict())
}).strict();
export const CollectionEnvelopeSchema: z.ZodType<C.CollectionEnvelope> = z.object({
    protocolVersion: z.literal(1), epoch: str, scopeRevision: z.number().int().positive().safe(), page: CollectionPageSchema
}).strict();
export const IngestReceiptSchema: z.ZodType<C.IngestReceipt> = z.object({
    sourceId: str, epoch: str, scopeRevision: z.number().int().positive().safe(), pageId: str, pageDigest: digest, committedCursor: z.union([str, z.null()]), watermark: str, committedAt: timestamp
}).strict();
export const AreaStorySchema: z.ZodType<C.AreaStory> = z.object({
    id: str, projectId: str, areaId: str, planningRevision: count, sourceWatermark: str, generatedAt: timestamp, finished: z.array(z.object({
        text: str, citations: z.array(CitationSchema), claimIds: z.array(str), basis: z.union([z.literal('observed'), z.literal('inferred'), z.literal('accepted')]), acceptanceRef: z.union([str, z.null()])
    }).strict().refine(v => v.basis === 'accepted' ? v.acceptanceRef !== null : v.acceptanceRef === null && (v.citations.length > 0 || v.claimIds.length > 0), 'Missing evidence or acceptance')), open: z.array(z.object({
        workItemId: str, text: str, citations: z.array(CitationSchema)
    }).strict()), next: z.array(z.object({
        text: str, citations: z.array(CitationSchema), taskId: z.union([str, z.null()])
    }).strict()), unknowns: z.array(str), contradictions: z.array(str)
}).strict();
export const RoadmapScopeSchema = z.object({
    id: str, projectId: str, areaId: str, revision: count, agreedAt: z.union([timestamp, z.null()]), checkpoints: z.array(z.object({
        id: str, label: str, acceptance: str, mandatory: z.boolean(), milestoneId: z.union([str, z.null()]), taskIds: z.array(str)
    }).strict()).max(100)
}).strict();
export const CheckpointAcceptanceSchema = z.object({
    id: str, scopeId: str, scopeRevision: z.number().int().positive().safe(), checkpointId: str, verdict: z.union([z.literal('accepted'), z.literal('reopened')]), reason: str, claimIds: z.array(str), recordedAt: timestamp
}).strict();
export const RoadmapCommandSchema: z.ZodType<C.RoadmapCommand> = z.union([z.object({
        type: z.literal('roadmap.set'), projectId: str, areaId: str, expectedScopeRevision: z.union([count, z.null()]), checkpoints: RoadmapScopeSchema.shape.checkpoints
    }).strict(), z.object({
        type: z.literal('roadmap.agree'), scopeId: str, expectedScopeRevision: count
    }).strict(), z.object({
        type: z.literal('checkpoint.assess'), scopeId: str, expectedScopeRevision: count, checkpointId: str, verdict: CheckpointAcceptanceSchema.shape.verdict, reason: str, claimIds: z.array(str)
    }).strict()]);
export const SourceContextSchema: z.ZodType<C.SourceContext> = z.object({
    sourceId: str, conversationId: str, messageRevisionId: str, repositoryIdentity: z.union([str, z.null()]), branch: z.union([str, z.null()]), commit: z.union([str, z.null()]), basis: z.union([z.literal('provider_metadata'), z.literal('cited_text'), z.literal('owner_override')])
}).strict();
export const HistoryClaimSchema: z.ZodType<C.HistoryClaim> = z.object({
    id: str, projectId: str, areaId: z.union([str, z.null()]), kind: z.union([z.literal('intent'), z.literal('implementation'), z.literal('verification'), z.literal('release'), z.literal('decision'), z.literal('cancellation'), z.literal('supersession')]), text: str, basis: z.union([z.literal('observed'), z.literal('inferred')]), citations: z.array(CitationSchema), supportingEvidence: z.array(z.object({
        kind: z.literal('repository'), snapshotId: str, digest: digest
    }).strict()), context: SourceContextSchema, supersedesClaimId: z.union([str, z.null()]), extractorVersion: str
}).strict();
export const HistoryWorkItemSchema: z.ZodType<C.HistoryWorkItem> = z.object({
    id: str, projectId: str, areaId: z.union([str, z.null()]), workType: WorkTypeSchema, title: str, state: z.union([z.literal('open'), z.literal('observed_finished'), z.literal('cancelled'), z.literal('superseded')]), disposition: z.union([z.literal('requested'), z.literal('idea'), z.literal('proposal')]), taskId: z.union([str, z.null()]), claimIds: z.array(str), supersededById: z.union([str, z.null()]), rowRevision: count
}).strict();
export const AreaProgressSchema: z.ZodType<C.AreaProgress> = z.object({
    projectId: str, areaId: str, planningRevision: count, sourceWatermark: str, observedFinishedWorkItemIds: z.array(str), acceptedTaskIds: z.array(str), openWorkItemIds: z.array(str), roadmap: z.union([z.object({
            scopeId: str, scopeRevision: z.number().int().positive().safe(), agreed: z.boolean(), defined: count, ownerAccepted: count, checkpoints: z.array(z.object({
                id: str, mandatory: z.boolean(), observedStage: z.union([z.literal('unknown'), z.literal('planned'), z.literal('in_progress'), z.literal('implemented'), z.literal('verified'), z.literal('released')]), claimIds: z.array(str), ownerAccepted: z.boolean(), acceptanceRef: z.union([str, z.null()])
            }).strict())
        }).strict(), z.null()]), coverageComplete: z.boolean(), unknowns: z.array(str)
}).strict();
export const RepositoryEvidenceSnapshotSchema: z.ZodType<C.RepositoryEvidenceSnapshot> = z.object({
    id: str, repositoryIdentity: str, kind: z.union([z.literal('commit'), z.literal('pull_request'), z.literal('check'), z.literal('deployment')]), sourceUrl: str, nativeRecordId: str, candidate: z.union([str, z.null()]), environment: z.union([str, z.null()]), conclusion: z.union([str, z.null()]), observedAt: timestamp, contentDigest: digest, bodyObjectKey: str, availability: AvailabilitySchema
}).strict();
export const SourceConfigurationSchema: z.ZodType<C.SourceConfiguration> = z.object({
    codecVersion: z.literal(1), sourceId: str, kind: HistorySourceKindSchema, epoch: str, scopeRevision: z.number().int().positive().safe(), roots: z.array(str), accountId: z.union([str, z.null()]), deviceId: z.union([str, z.null()]), includeArchived: z.boolean(), exclusions: z.array(str), parserVersion: str, normalizationVersion: str
}).strict();
export const InventoryMembershipSchema: z.ZodType<C.InventoryMembership> = z.object({
    codecVersion: z.literal(1), sourceId: str, epoch: str, scopeRevision: z.number().int().positive().safe(), generation: str, conversationId: str, archived: z.union([z.boolean(), z.null()]), observedAt: timestamp
}).strict();
export const AssociationRuleSchema: z.ZodType<C.AssociationRule> = z.object({
    id: str, projectId: str, areaId: z.union([str, z.null()]), scope: z.union([z.literal('conversation'), z.literal('repository'), z.literal('messages')]), targetIds: z.array(str), reason: str, provenanceRef: str, rowRevision: count
}).strict();
export const AnalysisCheckpointSchema: z.ZodType<C.AnalysisCheckpoint> = z.object({
    id: str, sourceWatermark: str, inputDigest: digest, normalizationVersion: str, extractorVersion: str, processedMessageRevisionIds: z.array(str), processedSegmentIds: z.array(str), affectedAreaIds: z.array(str), state: z.union([z.literal('pending'), z.literal('complete'), z.literal('invalid_result'), z.literal('not_configured'), z.literal('budget_exhausted'), z.literal('unavailable'), z.literal('cancelled')])
}).strict();
export const StoryCheckpointSchema: z.ZodType<C.StoryCheckpoint> = z.object({
    storyId: str, planningRevision: count, sourceWatermark: str, associationVersion: str, extractorVersion: str, inputDigest: digest
}).strict();
export const WorkItemEventSchema: z.ZodType<C.WorkItemEvent> = z.object({
    id: str, workItemId: str, operationId: str, inputDigest: digest, claimIds: z.array(str), state: z.enum(['open', 'observed_finished', 'cancelled', 'superseded']), recordedAt: timestamp
}).strict();
export const AreaLaneSummarySchema: z.ZodType<C.AreaLaneSummary> = z.object({
    projectId: str, areaId: z.union([str, z.null()]), title: str, agreedScope: z.boolean(), checkpoints: z.array(z.object({
        id: str, label: str, observed: z.union([z.literal('unknown'), z.literal('planned'), z.literal('in_progress'), z.literal('implemented'), z.literal('verified'), z.literal('released')]), accepted: z.boolean()
    }).strict()), needsOwnerCount: count, nextAction: z.union([str, z.null()]), storyId: z.union([str, z.null()]), freshness: z.union([z.literal('current'), z.literal('syncing'), z.literal('partial'), z.literal('stale'), z.literal('error'), z.literal('unverified')])
}).strict();
export const MAX_PAGE_MESSAGES = 250;
export const MAX_PAGE_METADATA_BYTES = 2 * 1024 * 1024;
/** RFC-style sorted JSON keys; arrays preserve order. Credentials must never enter this value. */
export function canonicalJson(value: unknown): string {
    if (value === null || typeof value === 'string' || typeof value === 'boolean')
        return JSON.stringify(value);
    if (typeof value === 'number' && Number.isFinite(value))
        return JSON.stringify(value);
    if (Array.isArray(value))
        return '[' + value.map(canonicalJson).join(',') + ']';
    if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
        return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonicalJson((value as Record<string, unknown>)[k])).join(',') + '}';
    }
    throw new Error('Not a JSON value');
}
export async function canonicalEnvelopeDigest(value: unknown): Promise<string> {
    const bytes = new TextEncoder().encode(canonicalJson(value));
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}
export interface VerifiedObject {
    key: string;
    sha256: string;
    bytes: number;
}
/** Private storage references, never accepted from a collector or wire request.
 * The caller supplies authenticatedOwnerId from authentication and owner/source
 * columns from its retained rows. Both dimensions are checked before IDs bind.
 */
export interface RetainedReferences {
    authenticatedOwnerId: string;
    conversations?: readonly { id: string; ownerId: string; sourceId: string }[];
    messages?: readonly { id: string; ownerId: string; sourceId: string }[];
}
/** Storage supplies finalized objects; a manifest declaration alone is never proof. */
export function validateCollectionEnvelope(input: unknown, verifiedObjects: readonly VerifiedObject[], retained?: RetainedReferences): C.CollectionEnvelope {
    const envelope = CollectionEnvelopeSchema.parse(input);
    const page = envelope.page;
    if (page.messages.length > MAX_PAGE_MESSAGES || new TextEncoder().encode(JSON.stringify(page)).length > MAX_PAGE_METADATA_BYTES)
        throw new Error('Page exceeds transport bounds');
    const unique = (values: string[]) => {
        if (new Set(values).size !== values.length)
            throw new Error('Duplicate identity');
    };
    unique(page.conversations.map(c => c.id));
    unique(page.conversations.map(c => c.sourceId + '\0' + c.nativeThreadId));
    unique(page.messages.map(m => m.id));
    unique(page.messages.map(m => m.conversationId + '\0' + m.nativeMessageId + '\0' + m.revisionDigest));
    unique(page.segments.map(s => s.id));
    unique(page.attachments.map(a => a.id));
    unique(page.objectManifest.map(o => o.key));
    for (const row of [...page.conversations, ...page.segments, ...page.gaps])
        if (row.sourceId !== page.sourceId)
            throw new Error('Foreign source');
    const retainedMessages = retained?.messages ?? [];
    const retainedConversations = retained?.conversations ?? [];
    for (const ref of [...retainedMessages, ...retainedConversations]) {
        if (!retained?.authenticatedOwnerId || ref.ownerId !== retained.authenticatedOwnerId || ref.sourceId !== page.sourceId)
            throw new Error('Foreign retained owner or source');
    }
    const messageIds = new Set([...page.messages.map(m => m.id), ...retainedMessages.map(r=>r.id)]);
    const conversationIds = new Set([...page.conversations.map(c => c.id), ...retainedConversations.map(r=>r.id)]);
    for (const row of [...page.messages, ...page.segments])
        if (!conversationIds.has(row.conversationId))
            throw new Error('Foreign conversation');
    for (const gap of page.gaps)
        if (gap.conversationId !== null && !conversationIds.has(gap.conversationId))
            throw new Error('Foreign conversation gap');
    for (const attachment of page.attachments)
        if (!messageIds.has(attachment.messageRevisionId))
            throw new Error('Foreign message attachment');
    const objects = new Map(verifiedObjects.map(o => [o.key, o]));
    for (const manifest of page.objectManifest) {
        const object = objects.get(manifest.key);
        if (!object || object.sha256 !== manifest.sha256 || object.bytes !== manifest.bytes)
            throw new Error('Unverified object');
    }
    const requireObject = (key: string, sha256: string, bytes: number) => {
        if (!page.objectManifest.some(o => o.key === key && o.sha256 === sha256 && o.bytes === bytes))
            throw new Error('Missing manifest object');
    };
    for (const m of page.messages)
        if (m.availability === 'complete')
            requireObject(m.bodyObjectKey, m.revisionDigest, m.contentBytes);
    for (const row of [...page.segments, ...page.attachments]) {
        if (row.availability === 'complete') {
            if (row.objectKey === null || row.sha256 === null || row.bytes === null)
                throw new Error('Complete content requires bytes');
            requireObject(row.objectKey, row.sha256, row.bytes);
        }
        else if (row.availability === 'unavailable' && (row.objectKey !== null || row.sha256 !== null || !row.unavailableReason))
            throw new Error('Unavailable content needs an explanation and no object');
    }
    return envelope;
}
/** Resolve from authenticated immutable storage before invoking; offsets count code points. */
export function validateCitation(citation: C.Citation, message: C.MessageRevision, text: string): string {
    CitationSchema.parse(citation);
    if (citation.messageRevisionId !== message.id || citation.revisionDigest !== message.revisionDigest || message.availability !== 'complete')
        throw new Error('Foreign or unavailable citation');
    const points = Array.from(text);
    if (citation.end > points.length)
        throw new Error('Citation out of range');
    return points.slice(citation.start, citation.end).join('');
}
