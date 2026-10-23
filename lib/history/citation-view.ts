import type {SqlDatabase} from '../workspace-store.ts';
import {readHistoryRecord} from './store.ts';
import {CitationSchema} from './validation.ts';
import {readHistoryObject,type PrivateHistoryBucket} from './object-store.ts';
import type {Citation} from './contracts.ts';
/** Server-resolved retained bytes only. Unicode windows avoid constructing an
 * unbounded array of every code point in a large private message. */
export async function retainedCitationView(db:SqlDatabase,bucket:PrivateHistoryBucket,owner:string,raw:Citation,offset=0){
 const citation=CitationSchema.parse(raw);if(!owner||!Number.isSafeInteger(offset)||offset<0||citation.end-citation.start>4000)throw Error('Invalid bounded citation view.');
 const retained=await readHistoryRecord(db,owner,'message',citation.messageRevisionId);if(!retained||retained.record.value.revisionDigest!==citation.revisionDigest)throw Error('Retained citation identity differs.');
 const message=retained.record.value,conversation=await readHistoryRecord(db,owner,'conversation',message.conversationId);if(!conversation)throw Error('Retained conversation unavailable.');
 const source=await readHistoryRecord(db,owner,'source',conversation.record.value.sourceId);if(!source)throw Error('Retained source unavailable.');
 const context={sourceLabel:source.record.value.capability.scopeLabel,conversationTitle:conversation.record.value.title,occurredAt:message.occurredAt,nativeThreadId:conversation.record.value.nativeThreadId,nativeMessageId:message.nativeMessageId,nativeLink:null};
 if(message.availability!=='complete'||source.record.value.removedAt)return {availability:'unavailable' as const,text:'',quote:'',context,codePointOffset:offset,nextOffset:null,totalCodePoints:null,reason:source.record.value.removedAt?'Source observations were explicitly removed; owner decisions remain retained.':'Original message bytes are unavailable.'};
 const ledger=await db.prepare("SELECT epoch,scope_revision FROM history_object_ledger WHERE user_id=? AND source_id=? AND key=? AND sha256=? AND bytes=? AND status='ready' AND pending_token IS NULL AND purged_at IS NULL").bind(owner,source.record.value.id,message.bodyObjectKey,message.revisionDigest,message.contentBytes).first<{epoch:string;scope_revision:number}>();
 if(!ledger)return {availability:'unavailable' as const,text:'',quote:'',context,codePointOffset:offset,nextOffset:null,totalCodePoints:null,reason:'Retained metadata has no verified physical object.'};
 const bytes=await readHistoryObject({db,bucket,authorize:async()=>{const current=await readHistoryRecord(db,owner,'source',source.record.value.id);return !!current&&!current.record.value.removedAt;}},{ownerId:owner,sourceId:source.record.value.id,epoch:ledger.epoch,scopeRevision:ledger.scope_revision},{key:message.bodyObjectKey,sha256:message.revisionDigest,bytes:message.contentBytes});
 const body=new TextDecoder('utf-8',{fatal:true}).decode(bytes);let count=0,text='',quote='';
 for(const point of body){if(count>=offset&&count<offset+16000)text+=point;if(count>=citation.start&&count<citation.end)quote+=point;count++;}
 if(citation.end>count||offset>count)throw Error('Citation or context window exceeds retained text.');
 return {availability:'complete' as const,text,quote,context,codePointOffset:offset,nextOffset:offset+16000<count?offset+16000:null,totalCodePoints:count,reason:null};
}
