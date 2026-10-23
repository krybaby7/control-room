import type {AttachmentBucket} from '../attachments.ts';
import type {PrivateHistoryBucket} from './object-store.ts';
import {readHistoryTransportBytes} from './http.ts';
/** Reuse the existing private bucket binding. No public URL or replacement bucket. */
export function historyPrivateBucket(bucket?:AttachmentBucket):PrivateHistoryBucket|undefined{
 if(!bucket)return undefined;
 return {put:async(key,bytes)=>{const result=await bucket.put(key,bytes,{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/octet-stream'},customMetadata:{sha256:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',Uint8Array.from(bytes).buffer)),b=>b.toString(16).padStart(2,'0')).join('')}});if(!result)throw Error('Private history object already exists.');return result;},get:async(key,maxBytes)=>{const object=await bucket.get(key);if(!object)return null;if(!Number.isSafeInteger(object.size)||object.size<0||object.size>maxBytes){await object.body.cancel();throw Error('Private history object exceeds bounded read.');}return readHistoryTransportBytes(object.body,maxBytes);},delete:key=>bucket.delete(key)};
}
