import {canonical} from '../canonical-json.ts';
import type {HistoryObjectScope} from './object-store.ts';
/** Server-secret domain separation yields opaque server-issued keys. A client
 * supplies only a finite attempt ID; it never selects an object namespace/key. */
export async function historyUploadReservationKey(secret:Uint8Array,scope:HistoryObjectScope,attemptId:string):Promise<string>{
 if(secret.length!==32||!/^upload_[a-f0-9]{64}$/.test(attemptId))throw Error('Invalid private upload identity.');
 const key=await crypto.subtle.importKey('raw',Uint8Array.from(secret).buffer,{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const digest=new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(canonical(['history-upload-v1',scope.ownerId,scope.sourceId,scope.epoch,scope.scopeRevision,attemptId]))));
 const uuid=(part:Uint8Array)=>{part=part.slice();part[6]=(part[6]&15)|64;part[8]=(part[8]&63)|128;const hex=Array.from(part,b=>b.toString(16).padStart(2,'0')).join('');return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;};
 return `history/${uuid(digest.slice(0,16))}/${uuid(digest.slice(16))}`;
}
