import {contentHash} from './canonical-json.ts';
export const SERIALIZATION_HASH_LIMITS=Object.freeze({entries:4096,retainedUtf8Bytes:1024*1024,inputBytes:256*1024});
const brand:unique symbol=Symbol('serialization-hash-context');
/** Trusted operation-local digest reuse, never serialized authority or rows. */
export interface SerializationHashContext {readonly [brand]:true}
type Entry={promise:Promise<string>;bytes:number};
type State={closed:boolean;bytes:number;entries:Map<string,Entry>};
const states=new WeakMap<SerializationHashContext,State>();
export function createSerializationHashContext():SerializationHashContext{
 const context:SerializationHashContext=Object.freeze({[brand]:true as const});
 states.set(context,{closed:false,bytes:0,entries:new Map()});return context;
}
export function closeSerializationHashContext(context:SerializationHashContext):void{
 const state=states.get(context);if(!state)throw new Error('Invalid serialization hash context.');
 state.closed=true;state.entries.clear();state.bytes=0;
}
/** Reuse only exact immutable STRING input with the existing UTF8 SHA-256.
 * Byte arrays and arbitrary callbacks cannot enter the context. Overflow falls
 * back to actual native hashing. Failed/pending results never become authority.
 * Every caller must still compare the digest and run all schema/reference/CAS
 * checks. Close in finally; no context may be retained between operations. */
export function serializationHash(value:string,context?:SerializationHashContext):Promise<string>{
 if(typeof value!=='string')throw new Error('Serialization hashing requires a string.');
 if(context===undefined)return contentHash(value);
 const state=states.get(context);if(!state||state.closed)throw new Error('Invalid or closed serialization hash context.');
 const existing=state.entries.get(value);if(existing)return existing.promise;
 if(value.length>SERIALIZATION_HASH_LIMITS.inputBytes||state.entries.size>=SERIALIZATION_HASH_LIMITS.entries)return contentHash(value);
 const bytes=new TextEncoder().encode(value).byteLength;
 if(bytes>SERIALIZATION_HASH_LIMITS.inputBytes||state.bytes+bytes>SERIALIZATION_HASH_LIMITS.retainedUtf8Bytes)return contentHash(value);
 const entry:Entry={promise:contentHash(value),bytes};state.entries.set(value,entry);state.bytes+=bytes;
 // Identity check prevents a late failed promise from deleting another entry.
 void entry.promise.catch(()=>{if(state.entries.get(value)===entry){state.entries.delete(value);state.bytes-=bytes;}});
 return entry.promise;
}
