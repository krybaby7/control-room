import {contentHash} from './canonical-json.ts';
import {initializeSerializationState,serializationState} from './internal/serialization-hash-state.ts';
export const SERIALIZATION_HASH_LIMITS=Object.freeze({entries:4096,retainedUtf8Bytes:1024*1024,inputBytes:256*1024});
const brand:unique symbol=Symbol('serialization-hash-context');
/** Trusted operation-local digest reuse, never serialized authority or rows. */
export interface SerializationHashContext {readonly [brand]:true}
export function createSerializationHashContext():SerializationHashContext{
 if(arguments.length)throw new Error('Serialization context accepts no options.');
 const context:SerializationHashContext=Object.freeze({[brand]:true as const});
 initializeSerializationState(context);return context;
}
export function closeSerializationHashContext(context:SerializationHashContext):void{
 const state=serializationState(context);if(!state)throw new Error('Invalid serialization hash context.');
 state.closed=true;state.entries.clear();state.bytes=0;state.serverDigest=undefined;
}
/** Reuse only exact immutable STRING input with the existing UTF8 SHA-256.
 * Byte arrays and arbitrary callbacks cannot enter this public API. Overflow falls
 * back to actual native hashing. Failed/pending results never become authority.
 * Every caller must still compare the digest and run all schema/reference/CAS
 * checks. Close in finally; no context may be retained between operations. */
export function serializationHash(value:string,context?:SerializationHashContext):Promise<string>{
 if(typeof value!=='string')throw new Error('Serialization hashing requires a string.');
 if(context===undefined)return contentHash(value);
 const state=serializationState(context);if(!state||state.closed)throw new Error('Invalid or closed serialization hash context.');
 state.used=true;
 const existing=state.entries.get(value);if(existing)return existing.promise;
 if(value.length>SERIALIZATION_HASH_LIMITS.inputBytes||state.entries.size>=SERIALIZATION_HASH_LIMITS.entries)return contentHash(value);
 const utf8=new TextEncoder().encode(value),bytes=utf8.byteLength;
 if(bytes>SERIALIZATION_HASH_LIMITS.inputBytes||state.bytes+bytes>SERIALIZATION_HASH_LIMITS.retainedUtf8Bytes)return contentHash(value);
 // Server capability is code-created only; public/default contexts use WebCrypto.
 // The fixed 64KiB UTF8 ceiling does not expand existing cache admission bounds.
 let promise:Promise<string>;try{promise=state.serverDigest&&bytes<=65536?Promise.resolve(state.serverDigest(utf8)):contentHash(value);}catch(error){promise=Promise.reject(error);}
 const entry={promise,bytes};state.entries.set(value,entry);state.bytes+=bytes;
 // Identity check prevents a late failed promise from deleting another entry.
 void entry.promise.catch(()=>{if(state.entries.get(value)===entry){state.entries.delete(value);state.bytes-=bytes;}});
 return entry.promise;
}
