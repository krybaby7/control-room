import type {ConversationRecord,HistoryGap,HistorySegment,HistoryAttachment,IngestReceipt,MessageRevision} from './contracts.ts';
import {canonicalJson,canonicalEnvelopeDigest,ConversationRecordSchema,HistoryGapSchema,HistorySegmentSchema,HistoryAttachmentSchema,IngestReceiptSchema,MessageRevisionSchema,type VerifiedObject} from './validation.ts';
import {contentComplete} from './segments.ts';

/** Private server inputs only: caller authenticates owner AND source, verifies the
 * finalized object ledger, and guards all retained rows in the admission batch.
 * A wire manifest is never a verifiedObjects implementation. No bytes are made here. */
export interface RecoveryObservationContext {
 sourceId:string;
 conversation:ConversationRecord;
 verifiedObjects:readonly VerifiedObject[];
}
const equal=(left:unknown,right:unknown)=>canonicalJson(left)===canonicalJson(right);
function objectVerified(objects:readonly VerifiedObject[],key:string,sha256:string,bytes:number):boolean{
 return /^[a-f0-9]{64}$/.test(sha256)&&Number.isSafeInteger(bytes)&&bytes>=0&&objects.some(object=>object.key===key&&object.sha256===sha256&&object.bytes===bytes);
}
function contextMatches(context:RecoveryObservationContext,conversationId:string):boolean{
 return ConversationRecordSchema.safeParse(context.conversation).success&&context.conversation.id===conversationId&&context.conversation.sourceId===context.sourceId;
}
/** Promote only the same immutable normalized revision. Acquisition clocks and
 * original logical IDs survive; an available retained revision never downgrades. */
export function recoverMessageObservation(retained:MessageRevision,incoming:MessageRevision,context:RecoveryObservationContext):MessageRevision|null{
 if(!MessageRevisionSchema.safeParse(retained).success||!MessageRevisionSchema.safeParse(incoming).success||retained.availability==='complete'||incoming.availability!=='complete'||!contextMatches(context,incoming.conversationId))return null;
 const core=(value:MessageRevision)=>{const {availability,observedAt,bodyObjectKey,...rest}=value;void availability;void observedAt;void bodyObjectKey;return rest;};
 if(!equal(core(retained),core(incoming))||!objectVerified(context.verifiedObjects,incoming.bodyObjectKey,incoming.revisionDigest,incoming.contentBytes))return null;
 return {...incoming,observedAt:retained.observedAt};
}
/** Inherited segment promotion requires a separate typed lineage proof. This
 * bounded helper deliberately handles only directly retained segment objects. */
export function recoverSegmentObservation(retained:HistorySegment,incoming:HistorySegment,context:RecoveryObservationContext):HistorySegment|null{
 if(!HistorySegmentSchema.safeParse(retained).success||!HistorySegmentSchema.safeParse(incoming).success||retained.availability==='complete'||incoming.availability!=='complete'||incoming.inheritedFromSegmentId!==null||!contextMatches(context,incoming.conversationId)||incoming.sourceId!==context.sourceId||retained.sourceId!==context.sourceId)return null;
 const core=(value:HistorySegment)=>{const {availability,sha256,bytes,objectKey,unavailableReason,...rest}=value;void availability;void sha256;void bytes;void objectKey;void unavailableReason;return rest;};
 if(!equal(core(retained),core(incoming))||retained.sha256!==null&&retained.sha256!==incoming.sha256||retained.bytes!==null&&retained.bytes!==incoming.bytes||incoming.sha256===null||incoming.bytes===null||incoming.objectKey===null||!objectVerified(context.verifiedObjects,incoming.objectKey,incoming.sha256,incoming.bytes))return null;
 return {...incoming};
}
export interface ConversationTraversalProof {
 sourceId:string;conversationId:string;epoch:string;scopeRevision:number;runId:string;complete:true;
 requiredMessageIds:readonly string[];requiredSegmentIds:readonly string[];requiredAttachmentIds:readonly string[];
}
export interface MissingTranscriptRecoveryInput extends RecoveryObservationContext {
 /** Private completed traversal proof supplied by the server, never inferred
  * from inventoryExhausted or a collector capability declaration. */
 traversalProof?:ConversationTraversalProof;
 runId:string;
 attachments:readonly HistoryAttachment[];
 originalGap:HistoryGap;
 /** Trusted server-computed resolution permission, never a collector field. The
  * original gap itself can have been reported by a collector. */
 serverGenerated:boolean;
 segments:readonly HistorySegment[];
 messages:readonly MessageRevision[];
 /** All failures observed by the completed traversal, excluding the historical
  * originalGap unless that same failure was actually observed again now. */
 currentGaps:readonly HistoryGap[];
 /** Receipt computed for these exact admitted observations in the same batch. */
 receipt:IngestReceipt;
 now:string;
}
export interface MissingTranscriptRecovery {
 gapUpdate:HistoryGap;
 provenanceMarker:HistoryGap;
}
/** Missing-transcript is the only automatically resolvable gap kind here. Parse,
 * attachment and missing-segment failures need their own typed target proofs.
 * Returned rows are proposals: caller applies both with receipt and CAS atomically. */
export async function resolveMissingTranscriptGap(input:MissingTranscriptRecoveryInput):Promise<MissingTranscriptRecovery|null>{
 const {originalGap:gap,conversation,sourceId,receipt,now,traversalProof:proof}=input;
 if(!proof||proof.complete!==true||proof.sourceId!==sourceId||proof.conversationId!==conversation.id||proof.epoch!==receipt.epoch||proof.scopeRevision!==receipt.scopeRevision||!input.runId||proof.runId!==input.runId)return null;
 const validIds=(ids:readonly string[])=>Array.isArray(ids)&&ids.length<=1000&&ids.every(id=>typeof id==='string'&&id.length>0&&id.length<=4096)&&new Set(ids).size===ids.length;
 if(!validIds(proof.requiredMessageIds)||!validIds(proof.requiredSegmentIds)||!validIds(proof.requiredAttachmentIds)||!proof.requiredMessageIds.length||!proof.requiredSegmentIds.length)return null;
 if(!input.serverGenerated||!HistoryGapSchema.safeParse(gap).success||!IngestReceiptSchema.safeParse(receipt).success||gap.kind!=='missing_transcript'||gap.resolvedAt!==null||gap.conversationId===null||gap.sourceId!==sourceId||receipt.sourceId!==sourceId||now!==receipt.committedAt||Date.parse(now)<Date.parse(gap.detectedAt)||!contextMatches(input,gap.conversationId)||conversation.availability!=='complete')return null;
 if(input.currentGaps.length>1000||input.messages.length>250||input.segments.length>1000||input.attachments.length>1000||input.verifiedObjects.length>1000)return null;
 if(input.currentGaps.some(current=>!HistoryGapSchema.safeParse(current).success||current.sourceId!==sourceId||current.conversationId===conversation.id&&current.resolvedAt===null))return null;
 const messages=input.messages.filter(message=>message.conversationId===conversation.id);
 const segments=input.segments.filter(segment=>segment.conversationId===conversation.id);
 const messageIds=new Set(messages.map(message=>message.id));
 const attachments=input.attachments.filter(attachment=>messageIds.has(attachment.messageRevisionId));
 if(!proof.requiredMessageIds.every(id=>messages.some(row=>row.id===id))||!proof.requiredSegmentIds.every(id=>segments.some(row=>row.id===id))||!proof.requiredAttachmentIds.every(id=>attachments.some(row=>row.id===id)))return null;
 if(attachments.some(attachment=>!HistoryAttachmentSchema.safeParse(attachment).success||attachment.availability!=='complete'||attachment.objectKey===null||attachment.sha256===null||attachment.bytes===null||!objectVerified(input.verifiedObjects,attachment.objectKey,attachment.sha256,attachment.bytes)))return null;
 if(!messages.length||!segments.length||new Set(messages.map(row=>row.id)).size!==messages.length||new Set(segments.map(row=>row.id)).size!==segments.length)return null;
 if(messages.some(message=>!MessageRevisionSchema.safeParse(message).success||message.availability!=='complete'||!objectVerified(input.verifiedObjects,message.bodyObjectKey,message.revisionDigest,message.contentBytes)))return null;
 if(segments.some(segment=>!HistorySegmentSchema.safeParse(segment).success||segment.sourceId!==sourceId||segment.availability!=='complete'||segment.objectKey===null||segment.sha256===null||segment.bytes===null||!objectVerified(input.verifiedObjects,segment.objectKey,segment.sha256,segment.bytes)))return null;
 if(!contentComplete(segments,attachments,messages,segments.map(segment=>({id:segment.id,verified:true,bytes:segment.bytes!,recordCount:null}))))return null;
 const sortedMessages=[...messages].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0),sortedSegments=[...segments].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
 const provenance={codecVersion:1,kind:'missing_transcript_resolution',traversalProof:{...proof,requiredMessageIds:[...proof.requiredMessageIds].sort(),requiredSegmentIds:[...proof.requiredSegmentIds].sort(),requiredAttachmentIds:[...proof.requiredAttachmentIds].sort()},originalGapId:gap.id,originalGapRecordHash:await canonicalEnvelopeDigest(gap),conversationId:conversation.id,messageRevisionIds:sortedMessages.map(row=>row.id),segmentIds:sortedSegments.map(row=>row.id),attachmentIds:attachments.map(row=>row.id).sort(),objects:[...new Map([...sortedMessages.map(row=>({key:row.bodyObjectKey,sha256:row.revisionDigest,bytes:row.contentBytes})),...sortedSegments.map(row=>({key:row.objectKey!,sha256:row.sha256!,bytes:row.bytes!})),...attachments.map(row=>({key:row.objectKey!,sha256:row.sha256!,bytes:row.bytes!}))].map(object=>[object.key,object])).values()].sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0),receipt:{sourceId:receipt.sourceId,epoch:receipt.epoch,scopeRevision:receipt.scopeRevision,pageId:receipt.pageId,pageDigest:receipt.pageDigest,watermark:receipt.watermark,committedAt:receipt.committedAt}};
 const explanation=canonicalJson(provenance);
 if(new TextEncoder().encode(explanation).byteLength>16*1024)return null;
 const id='resolved_'+await canonicalEnvelopeDigest([gap.id,receipt.pageDigest]);
 return {gapUpdate:{...gap,resolvedAt:now},provenanceMarker:{id,sourceId,conversationId:conversation.id,kind:'missing_transcript',explanation,detectedAt:now,resolvedAt:now}};
}
/** A later actual observation of the identical gap reopens its original row;
 * resolved provenance markers remain immutable historical evidence. */
export function reopenHistoryGap(retained:HistoryGap,incoming:HistoryGap):HistoryGap|null{
 if(!HistoryGapSchema.safeParse(retained).success||!HistoryGapSchema.safeParse(incoming).success||retained.resolvedAt===null||incoming.resolvedAt!==null)return null;
 if(retained.id.startsWith('resolved_'))return null;
 const core=(gap:HistoryGap)=>{const {detectedAt,resolvedAt,...rest}=gap;void detectedAt;void resolvedAt;return rest;};
 return equal(core(retained),core(incoming))?{...retained,resolvedAt:null}:null;
}
