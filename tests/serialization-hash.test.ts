import test from 'node:test';
import assert from 'node:assert/strict';
import {contentHash} from '../lib/canonical-json.ts';
import {createSerializationHashContext,closeSerializationHashContext,serializationHash,SERIALIZATION_HASH_LIMITS,type SerializationHashContext} from '../lib/serialization-hash.ts';
type DigestArgs=Parameters<typeof crypto.subtle.digest>;
test('exact immutable strings reuse genuine native SHA while distinct bytes and operation contexts remain independent',async t=>{
 const original=crypto.subtle.digest.bind(crypto.subtle);let calls=0;
 t.mock.method(crypto.subtle,'digest',(...args:DigestArgs)=>{calls++;return original(...args);});
 const left=createSerializationHashContext(),right=createSerializationHashContext();t.after(()=>{closeSerializationHashContext(left);closeSerializationHashContext(right);});
 const a=await serializationHash('{"a":1,"b":2}',left);assert.equal(await serializationHash('{"a":1,"b":2}',left),a);assert.equal(calls,1);
 const b=await serializationHash('{"b":2,"a":1}',left);assert.notEqual(a,b);assert.equal(calls,2);
 assert.equal(await serializationHash('{"a":1,"b":2}',right),a);assert.equal(calls,3);
 // Different JS strings that encode to the same UTF8 bytes remain separate keys.
 assert.equal(await serializationHash('\uD800',left),await serializationHash('\uFFFD',left));assert.equal(calls,5);
 await contentHash('{"a":1,"b":2}');assert.equal(calls,6,'ordinary physical hashing remains a real native digest');
 assert.deepEqual(Object.keys(left),[]);assert.equal(JSON.stringify(left),'{}');
 assert.throws(()=>serializationHash('x',JSON.parse(JSON.stringify(left)) as SerializationHashContext),/context/);
 assert.throws(()=>serializationHash(new Uint8Array([1]) as unknown as string,left),/string/);
});
test('identical in-flight requests share one native promise and closing never changes its eventual digest',async t=>{
 const native=crypto.subtle.digest.bind(crypto.subtle);let calls=0,release!:()=>void,reached!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;}),nativeReady=new Promise<void>(resolve=>{reached=resolve;});
 t.mock.method(crypto.subtle,'digest',(...args:DigestArgs)=>{calls++;return native(...args).then(async bytes=>{reached();await gate;return bytes;});});
 const context=createSerializationHashContext(),first=serializationHash('shared pending Unicode العربية',context),second=serializationHash('shared pending Unicode العربية',context);
 assert.equal(first,second);assert.equal(calls,1);await nativeReady;closeSerializationHashContext(context);
 assert.throws(()=>serializationHash('shared pending Unicode العربية',context),/closed/);release();
 assert.equal(await first,await second);assert.match(await first,/^[a-f0-9]{64}$/);
});
test('a native rejection is shared only in-flight, evicted, and recomputed without caching failure',async t=>{
 const native=crypto.subtle.digest.bind(crypto.subtle),failure=new Error('synthetic native failure');let calls=0;
 t.mock.method(crypto.subtle,'digest',(...args:DigestArgs)=>{calls++;return native(...args).then(bytes=>{if(calls===1)throw failure;return bytes;});});
 const context=createSerializationHashContext();t.after(()=>closeSerializationHashContext(context));
 const a=serializationHash('retry exact bytes',context),b=serializationHash('retry exact bytes',context);assert.equal(a,b);
 const outcomes=await Promise.allSettled([a,b]);assert.ok(outcomes.every(value=>value.status==='rejected'&&value.reason===failure));assert.equal(calls,1);
 assert.match(await serializationHash('retry exact bytes',context),/^[a-f0-9]{64}$/);assert.equal(calls,2);
 await serializationHash('retry exact bytes',context);assert.equal(calls,2);
});
test('entry, UTF8 byte and individual-input bounds fall back to actual native SHA without growing retained authority',async t=>{
 const native=crypto.subtle.digest.bind(crypto.subtle);let calls=0;t.mock.method(crypto.subtle,'digest',(...args:DigestArgs)=>{calls++;return native(...args);});
 const entries=createSerializationHashContext();t.after(()=>closeSerializationHashContext(entries));
 for(let index=0;index<SERIALIZATION_HASH_LIMITS.entries;index++)await serializationHash('unique-'+index,entries);
 const before=calls;await serializationHash('overflow',entries);await serializationHash('overflow',entries);assert.equal(calls,before+2);await serializationHash('unique-0',entries);assert.equal(calls,before+2);
 const bytes=createSerializationHashContext();t.after(()=>closeSerializationHashContext(bytes));const limit=SERIALIZATION_HASH_LIMITS.inputBytes;
 for(let index=0;index<4;index++)await serializationHash(String(index)+'x'.repeat(limit-1),bytes);
 const full=calls;await serializationHash('new after byte cap',bytes);await serializationHash('new after byte cap',bytes);assert.equal(calls,full+2);
 const individual=createSerializationHashContext();t.after(()=>closeSerializationHashContext(individual));const oversized='x'.repeat(limit+1),unicode='😀'.repeat(limit/4+1),start=calls;
 await serializationHash(oversized,individual);await serializationHash(oversized,individual);await serializationHash(unicode,individual);await serializationHash(unicode,individual);assert.equal(calls,start+4);
});
