import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CitationSchema, canonicalEnvelopeDigest, SourceCapabilitySchema } from '../lib/history/validation.ts';
test('citation offsets must be nonempty and capability cannot invent unattended verification', () => {
    assert.equal(CitationSchema.safeParse({ messageRevisionId: 'm', revisionDigest: 'a'.repeat(64), start: 2, end: 1 }).success, false);
    assert.equal(SourceCapabilitySchema.safeParse({ sourceId: 's', kind: 'codex_cloud', scopeLabel: 'Selected', inventory: 'unverified', contentRead: 'unverified', unattendedRead: true, verifiedAt: null, proofRef: null, limitation: null }).success, false);
});
test('canonical digest covers the entire envelope with stable key ordering', async () => {
    assert.equal(await canonicalEnvelopeDigest({ a: 1, b: 2 }), await canonicalEnvelopeDigest({ b: 2, a: 1 }));
    assert.notEqual(await canonicalEnvelopeDigest({ epoch: 'a' }), await canonicalEnvelopeDigest({ epoch: 'b' }));
});
import { CollectionEnvelopeSchema, ConversationRecordSchema, RoadmapCommandSchema, validateCitation, validateCollectionEnvelope } from '../lib/history/validation.ts';
const page = { codecVersion: 1, sourceId: 's', runId: 'r', pageId: 'p', previousCursor: null, nextCursor: null, inventoryExhausted: true, conversations: [], messages: [], segments: [], attachments: [], gaps: [], objectManifest: [] };
const envelope = { protocolVersion: 1, epoch: 'e', scopeRevision: 1, page };
const message = { id: 'm', conversationId: 'c', nativeMessageId: 'n', normalizationVersion: 'nfc-v1', revisionDigest: 'a'.repeat(64), parentNativeMessageId: null, sequence: 0, role: 'user' as const, occurredAt: null, observedAt: '2026-10-22T00:00:00Z', bodyObjectKey: 'body', contentBytes: 8, availability: 'complete' as const };
test('strict versions, keys, enums, digests, counts and nullable source dates', () => {
    assert.equal(CollectionEnvelopeSchema.safeParse({ ...envelope, ownerId: 'forged' }).success, false);
    assert.equal(CollectionEnvelopeSchema.safeParse({ ...envelope, page: { ...page, codecVersion: 2 } }).success, false);
    assert.equal(CitationSchema.safeParse({ messageRevisionId: 'm', revisionDigest: 'bad', start: -1, end: 3 }).success, false);
    const conversation = { id: 'c', sourceId: 's', nativeThreadId: 'n', sessionTreeId: null, parentConversationId: null, title: null, projectId: null, repositoryIdentity: null, branch: null, createdAt: null, sourceUpdatedAt: null, archived: null, availability: 'partial' };
    assert.equal(ConversationRecordSchema.safeParse(conversation).success, true);
    assert.throws(() => validateCollectionEnvelope({ ...envelope, page: { ...page, conversations: [conversation, conversation] } }, []), /Duplicate/);
    assert.equal(ConversationRecordSchema.safeParse({ ...conversation, availability: 'invented' }).success, false);
});
test('verified objects and bounded complete pages; immutable Unicode citation membership', () => {
    const object = { key: 'body', sha256: message.revisionDigest, bytes: 8 };
    const input = { ...envelope, page: { ...page, messages: [message], objectManifest: [object] } };
    assert.throws(() => validateCollectionEnvelope(input, [], { authenticatedOwnerId:'owner', conversations: [{id:'c',ownerId:'owner',sourceId:'s'}] }), /Unverified/);
    assert.doesNotThrow(() => validateCollectionEnvelope(input, [object], { authenticatedOwnerId:'owner', conversations: [{id:'c',ownerId:'owner',sourceId:'s'}] }));
    assert.throws(() => validateCollectionEnvelope({ ...envelope, page: { ...page, messages: Array(251).fill(message) } }, []));
    assert.throws(() => validateCollectionEnvelope({ ...envelope, page: { ...page, gaps: [{ id: 'g', sourceId: 's', conversationId: null, kind: 'scope', explanation: 'x'.repeat(2 * 1024 * 1024), detectedAt: message.observedAt, resolvedAt: null }] } }, []), /bounds/);
    const citation = { messageRevisionId: 'm', revisionDigest: message.revisionDigest, start: 1, end: 2 };
    assert.equal(validateCitation(citation, message, 'ع😀ب'), '😀');
    assert.throws(() => validateCitation({ ...citation, messageRevisionId: 'foreign' }, message, 'ع😀ب'));
    assert.throws(() => validateCitation({ ...citation, end: 4 }, message, 'ع😀ب'));
    assert.throws(() => validateCollectionEnvelope({ ...input, page: { ...input.page, messages: [message, message] } }, [object]), /Duplicate/);
});
test('roadmap commands cap scope and cannot accept extra authority fields', () => {
    assert.equal(RoadmapCommandSchema.safeParse({ type: 'roadmap.agree', scopeId: 's', expectedScopeRevision: 1, ownerId: 'forged' }).success, false);
    assert.equal(RoadmapCommandSchema.safeParse({ type: 'roadmap.set', projectId: 'p', areaId: 'a', expectedScopeRevision: null, checkpoints: Array(101).fill({ id: 'c', label: 'Test', acceptance: 'Pass', mandatory: true, milestoneId: null, taskIds: [] }) }).success, false);
});
import {CoverageSnapshotSchema} from '../lib/history/validation.ts';
test('current coverage needs both completeness proofs and successful collection dates',()=>{
 const snapshot={sourceId:'s',scopeLabel:'Selected',inventoryComplete:false,contentComplete:false,discovered:0,complete:0,partial:0,unavailable:0,unresolvedGaps:0,lastInventorySuccessAt:null,lastContentSuccessAt:null,status:'current'};
 assert.equal(CoverageSnapshotSchema.safeParse(snapshot).success,false);
 assert.equal(CoverageSnapshotSchema.safeParse({...snapshot,inventoryComplete:true,contentComplete:true}).success,false);
});
test('gap conversation references must belong to the same authenticated source',()=>{
 const gap={id:'g',sourceId:'s',conversationId:'foreign',kind:'missing_transcript',explanation:'Missing',detectedAt:message.observedAt,resolvedAt:null};
 assert.throws(()=>validateCollectionEnvelope({...envelope,page:{...page,gaps:[gap]}},[]),/Foreign conversation/);
});
test('retained gap IDs bind only under authenticated owner and source rows',()=>{
 const gap={id:'g',sourceId:'s',conversationId:'retained',kind:'missing_transcript',explanation:'Missing',detectedAt:message.observedAt,resolvedAt:null};
 const packet={...envelope,page:{...page,gaps:[gap]}};
 assert.doesNotThrow(()=>validateCollectionEnvelope(packet,[],{authenticatedOwnerId:'owner',conversations:[{id:'retained',ownerId:'owner',sourceId:'s'}]}));
 assert.throws(()=>validateCollectionEnvelope(packet,[],{authenticatedOwnerId:'owner',conversations:[{id:'retained',ownerId:'foreign',sourceId:'s'}]}),/Foreign retained/);
 assert.throws(()=>validateCollectionEnvelope(packet,[],{authenticatedOwnerId:'owner',conversations:[{id:'retained',ownerId:'owner',sourceId:'other'}]}),/Foreign retained/);
 const current={sourceId:'s',scopeLabel:'Selected',inventoryComplete:true,contentComplete:true,discovered:0,complete:0,partial:0,unavailable:0,unresolvedGaps:0,lastInventorySuccessAt:message.observedAt,lastContentSuccessAt:message.observedAt,status:'current'};
 assert.equal(CoverageSnapshotSchema.safeParse(current).success,true);
 assert.equal(CoverageSnapshotSchema.safeParse({...current,lastContentSuccessAt:null}).success,false);
 assert.equal(CoverageSnapshotSchema.safeParse({...current,contentComplete:false}).success,false);
});
