import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentComplete } from '../lib/history/segments.ts';
test('unresolved inherited segments and unavailable attachments prevent complete', () => {
    assert.equal(contentComplete([], [], []), true);
    assert.equal(contentComplete([{ id: 's', availability: 'complete', inheritedFromSegmentId: 'missing', inheritedRange: null }], [], []), false);
    assert.equal(contentComplete([], [{ availability: 'unavailable' }], []), false);
});
import { HistoryAttachmentSchema, HistorySegmentSchema, validateCollectionEnvelope } from '../lib/history/validation.ts';
test('unavailable objects need explanations; complete objects need digests', () => {
    const attachment = { id: 'a', messageRevisionId: 'foreign', nativeAttachmentId: null, name: 'test.txt', mediaType: null, sha256: null, bytes: null, objectKey: null, availability: 'unavailable', unavailableReason: 'not retained' };
    assert.equal(HistoryAttachmentSchema.safeParse(attachment).success, true);
    assert.equal(HistoryAttachmentSchema.safeParse({ ...attachment, availability: 'complete' }).success, false);
    assert.equal(HistoryAttachmentSchema.safeParse({ ...attachment, unavailableReason: null }).success, false);
    assert.throws(() => validateCollectionEnvelope({ protocolVersion: 1, epoch: 'e', scopeRevision: 1, page: { codecVersion: 1, sourceId: 's', runId: 'r', pageId: 'p', previousCursor: null, nextCursor: null, inventoryExhausted: true, conversations: [], messages: [], segments: [], attachments: [attachment], gaps: [], objectManifest: [] } }, []), /Foreign message/);
    assert.equal(HistorySegmentSchema.safeParse({ id: 's', sourceId: 'source', conversationId: 'c', nativeSegmentId: 'n', inheritedFromSegmentId: 'i', inheritedRange: { unit: 'bytes', start: 3, end: 2 }, sha256: null, bytes: null, objectKey: null, availability: 'unavailable', unavailableReason: 'missing' }).success, false);
});
test('inherited lineage requires a paired range and verified unit-specific bounds',()=>{
 const base={id:'base',availability:'complete' as const,inheritedFromSegmentId:null,inheritedRange:null};
 const inherited={...base,id:'child',inheritedFromSegmentId:'base',inheritedRange:{unit:'bytes' as const,start:0,end:11}};
 assert.equal(contentComplete([base,inherited],[],[]),false);
 const wire={id:'s',sourceId:'source',conversationId:'c',nativeSegmentId:'n',inheritedFromSegmentId:'i',inheritedRange:null,sha256:'a'.repeat(64),bytes:1,objectKey:'key',availability:'complete',unavailableReason:null};
 assert.equal(HistorySegmentSchema.safeParse(wire).success,false);
});
test('verified byte and record bounds must match their source unit',()=>{
 const base={id:'base',availability:'complete' as const,inheritedFromSegmentId:null,inheritedRange:null};
 const child={...base,id:'child',inheritedFromSegmentId:'base',inheritedRange:{unit:'bytes' as const,start:2,end:10}};
 const metadata=[{id:'base',verified:true as const,bytes:10,recordCount:3},{id:'child',verified:true as const,bytes:4,recordCount:1}];
 assert.equal(contentComplete([base,child],[],[],metadata),true);
 assert.equal(contentComplete([base,{...child,inheritedRange:{...child.inheritedRange,end:11}}],[],[],metadata),false);
 const records={...child,inheritedRange:{unit:'records' as const,start:0,end:3}};
 assert.equal(contentComplete([base,records],[],[],metadata),true);
 assert.equal(contentComplete([base,{...records,inheritedRange:{...records.inheritedRange,end:4}}],[],[],metadata),false);
 assert.equal(contentComplete([base,records],[],[],metadata.map(m=>({...m,recordCount:null}))),false);
 assert.equal(contentComplete([base,child],[],[],metadata.filter(m=>m.id!=='base')),false);
 assert.equal(contentComplete([{...base,inheritedFromSegmentId:'child',inheritedRange:{unit:'records',start:0,end:1}},child],[],[],metadata),false);
});
