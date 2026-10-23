import test from 'node:test';
import assert from 'node:assert/strict';
import type {ConversationRecord,HistoryGap,HistorySegment,MessageRevision,IngestReceipt} from '../lib/history/contracts.ts';
import {recoverMessageObservation,recoverSegmentObservation,resolveMissingTranscriptGap,reopenHistoryGap} from '../lib/history/recovery-observations.ts';
const first='2026-10-20T00:00:00.000Z',now='2026-10-22T00:00:00.000Z',hash='a'.repeat(64);
const conversation:ConversationRecord={id:'c',sourceId:'s',nativeThreadId:'native-c',sessionTreeId:null,parentConversationId:null,title:null,projectId:null,repositoryIdentity:null,branch:null,createdAt:null,sourceUpdatedAt:null,archived:null,availability:'complete'};
const message:MessageRevision={id:'m',conversationId:'c',nativeMessageId:'native-m',revisionDigest:hash,normalizationVersion:'unicode-nfc-lf-v1',parentNativeMessageId:null,sequence:0,role:'user',occurredAt:null,observedAt:now,bodyObjectKey:'message-key',contentBytes:4,availability:'complete'};
const segment:HistorySegment={id:'seg',sourceId:'s',conversationId:'c',nativeSegmentId:'native-seg',inheritedFromSegmentId:null,inheritedRange:null,sha256:hash,bytes:4,objectKey:'segment-key',availability:'complete',unavailableReason:null};
const gap:HistoryGap={id:'g',sourceId:'s',conversationId:'c',kind:'missing_transcript',explanation:'retained source transcript was missing',detectedAt:first,resolvedAt:null};
const receipt:IngestReceipt={sourceId:'s',epoch:'e',scopeRevision:1,pageId:'p',pageDigest:'b'.repeat(64),committedCursor:null,watermark:'2',committedAt:now};
const objects=[{key:'message-key',sha256:hash,bytes:4},{key:'segment-key',sha256:hash,bytes:4}];
const context={sourceId:'s',conversation,verifiedObjects:objects};
const proof={sourceId:'s',conversationId:'c',epoch:'e',scopeRevision:1,runId:'r',complete:true as const,requiredMessageIds:['m'],requiredSegmentIds:['seg'],requiredAttachmentIds:[]};
const input=()=>({traversalProof:proof,runId:'r',attachments:[],originalGap:gap,serverGenerated:true as const,sourceId:'s',conversation,segments:[segment],messages:[message],currentGaps:[],verifiedObjects:objects,receipt,now});
test('verified unavailable and partial observations promote without changing IDs or first observation clocks',()=>{
 const old={...message,availability:'unavailable' as const,observedAt:first,bodyObjectKey:'old-key'};
 assert.deepEqual(recoverMessageObservation(old,message,context),{...message,observedAt:first});
 assert.deepEqual(recoverMessageObservation({...old,availability:'partial'},message,context),{...message,observedAt:first});
 assert.equal(recoverMessageObservation(old,{...message,sequence:1},context),null);
 assert.equal(recoverMessageObservation(old,{...message,role:'assistant'},context),null);
 const missing={...segment,availability:'unavailable' as const,sha256:null,bytes:null,objectKey:null,unavailableReason:'missing'};
 assert.deepEqual(recoverSegmentObservation(missing,segment,context),segment);
 assert.equal(recoverMessageObservation(message,{...message,availability:'partial'},context),null);
 assert.equal(recoverMessageObservation(old,{...message,normalizationVersion:'different'},context),null);
 assert.equal(recoverMessageObservation(old,{...message,nativeMessageId:'other'},context),null);
 assert.equal(recoverMessageObservation(old,{...message,revisionDigest:'unknown'},context),null);
 assert.equal(recoverMessageObservation(old,message,{...context,verifiedObjects:[]}),null);
 assert.equal(recoverSegmentObservation(missing,segment,{...context,sourceId:'foreign'}),null);
});
test('missing transcript resolves only with complete same-source verified content and appends deterministic bounded provenance',async()=>{
 const result=await resolveMissingTranscriptGap(input());assert.ok(result);
 assert.deepEqual(result.gapUpdate,{...gap,resolvedAt:now});assert.equal(result.provenanceMarker.detectedAt,now);assert.equal(result.provenanceMarker.resolvedAt,now);
 const explanation=JSON.parse(result.provenanceMarker.explanation);assert.equal(explanation.originalGapId,gap.id);assert.match(explanation.originalGapRecordHash,/^[a-f0-9]{64}$/);assert.deepEqual(explanation.messageRevisionIds,['m']);
 assert.deepEqual(await resolveMissingTranscriptGap(input()),result);
 assert.notEqual((await resolveMissingTranscriptGap({...input(),receipt:{...receipt,pageDigest:'c'.repeat(64)}}))?.provenanceMarker.id,result.provenanceMarker.id);
 assert.deepEqual(reopenHistoryGap(result.gapUpdate,{...gap,detectedAt:now}),gap);
 assert.equal(reopenHistoryGap(result.provenanceMarker,{...result.provenanceMarker,resolvedAt:null}),null);
 assert.equal(reopenHistoryGap(result.gapUpdate,{...gap,explanation:'changed cause'}),null);
});
test('no matching content, gaps, unknown digests, incomplete lineage or foreign source cannot resolve gaps',async()=>{
 for(const invalid of [
  {...input(),traversalProof:undefined},{...input(),traversalProof:{...proof,requiredMessageIds:['missing']}},{...input(),traversalProof:{...proof,requiredAttachmentIds:['missing']}},{...input(),traversalProof:{...proof,scopeRevision:2}},{...input(),traversalProof:{...proof,runId:'other'}},
  {...input(),messages:[]},{...input(),segments:[]},{...input(),verifiedObjects:[]},
  {...input(),currentGaps:[gap]},{...input(),conversation:{...conversation,availability:'partial' as const}},
  {...input(),sourceId:'foreign'},{...input(),receipt:{...receipt,sourceId:'foreign'}},
  {...input(),serverGenerated:false},{...input(),originalGap:{...gap,kind:'parse' as const}},
  {...input(),messages:[{...message,revisionDigest:'unknown'}]},
  {...input(),segments:[{...segment,inheritedFromSegmentId:'unknown',inheritedRange:{unit:'bytes' as const,start:0,end:1}}]},
 ])assert.equal(await resolveMissingTranscriptGap(invalid),null);
});
test('completed traversal requires every required message and attachment with verified bytes',async()=>{
 const attachment={id:'a',messageRevisionId:'m',nativeAttachmentId:null,name:'synthetic.txt',mediaType:'text/plain',sha256:hash,bytes:4,objectKey:'attachment-key',availability:'complete' as const,unavailableReason:null};
 const bound={...input(),traversalProof:{...proof,requiredAttachmentIds:['a']},attachments:[attachment]};
 assert.equal(await resolveMissingTranscriptGap(bound),null);
 const verified={...bound,verifiedObjects:[...objects,{key:'attachment-key',sha256:hash,bytes:4}]};
 assert.ok(await resolveMissingTranscriptGap(verified));
 assert.equal(await resolveMissingTranscriptGap({...verified,attachments:[{...attachment,availability:'partial'}]}),null);
 assert.equal(await resolveMissingTranscriptGap({...verified,traversalProof:{...verified.traversalProof,requiredMessageIds:['m','m2']}}),null);
});
