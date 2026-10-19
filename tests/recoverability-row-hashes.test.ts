import nodeCrypto from 'node:crypto';
import {syncBuiltinESMExports} from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {BUNDLE_LIMITS} from '../lib/workspace-export-core.ts';
import {verifyRecoverabilityRowHashes,RECOVERABILITY_HASH_CONCURRENCY} from '../lib/recoverability-row-hashes.ts';
type DigestArgs=Parameters<typeof crypto.subtle.digest>;
async function rows(count:number){return Promise.all(Array.from({length:count},async(_,index)=>{const value={id:'original-'+index,text:'مرحبا 😀 é / punctuation',index};return {payload_json:JSON.stringify(value,null,index%2?2:0),content_hash:await contentHash(canonical(value))};}));}
test('all512 original canonical hashes use actual native SHA without input rewriting or cross-call cache',async context=>{
 const input=await rows(512),before=structuredClone(input),original=nodeCrypto.createHash;let calls=0;
 context.mock.method(nodeCrypto,'createHash',(...args:Parameters<typeof nodeCrypto.createHash>)=>{calls++;return original(...args);});syncBuiltinESMExports();
 try{
 await verifyRecoverabilityRowHashes(input);assert.equal(calls,512);assert.deepEqual(input,before);assert.equal(RECOVERABILITY_HASH_CONCURRENCY,32);
 await verifyRecoverabilityRowHashes(input);assert.equal(calls,1024,'no cross-call hash cache');
 }finally{context.mock.restoreAll();syncBuiltinESMExports();}
});
test('canonical UTF8 identity is exact and a corrupt late row cannot certify any successful snapshot',async context=>{
 const input=await rows(75),original=crypto.subtle.digest.bind(crypto.subtle);let calls=0,active=0;
 input[74]={...input[74],payload_json:JSON.stringify({id:'original-74',text:'Changed original content',index:74})};const before=structuredClone(input);
 context.mock.method(crypto.subtle,'digest',(...args:DigestArgs)=>{calls++;active++;return original(...args).finally(()=>{active--;});});
 await assert.rejects(verifyRecoverabilityRowHashes(input),/Current normalized content hash differs/);assert.equal(calls,0,'small immutable strings use native SHA');assert.equal(active,0);assert.deepEqual(input,before);
 input[74].content_hash=await contentHash(canonical(JSON.parse(input[74].payload_json)));await verifyRecoverabilityRowHashes(input);assert.equal(active,0);
});
test('UTF8 aggregate overflow is refused before scheduling even the first actual digest',async context=>{
 const first=(await rows(1))[0],oversized={payload_json:JSON.stringify({text:'😀'.repeat(BUNDLE_LIMITS.bytes/4)}),content_hash:'a'.repeat(64)},original=crypto.subtle.digest.bind(crypto.subtle);let calls=0,nativeCalls=0;const native=nodeCrypto.createHash;
 assert.ok(oversized.payload_json.length<BUNDLE_LIMITS.bytes);assert.ok(new TextEncoder().encode(oversized.payload_json).byteLength>BUNDLE_LIMITS.bytes);
 context.mock.method(crypto.subtle,'digest',(...args:DigestArgs)=>{calls++;return original(...args);});
 context.mock.method(nodeCrypto,'createHash',(...args:Parameters<typeof nodeCrypto.createHash>)=>{nativeCalls++;return native(...args);});syncBuiltinESMExports();
 try{await assert.rejects(verifyRecoverabilityRowHashes([first,oversized]),/Physical snapshot byte bound exceeded/);assert.equal(calls,0);assert.equal(nativeCalls,0);}finally{context.mock.restoreAll();syncBuiltinESMExports();}
});
test('invalid JSON retains its original parse refusal and every other started digest settles before return',async context=>{
 const large={text:'x'.repeat(65536)},payload_json=JSON.stringify(large),content_hash=await contentHash(canonical(large)),input=Array.from({length:40},()=>({payload_json,content_hash})),original=crypto.subtle.digest.bind(crypto.subtle);let active=0,calls=0;input[3]={payload_json:'not original JSON',content_hash:'b'.repeat(64)};
 context.mock.method(crypto.subtle,'digest',(...args:DigestArgs)=>{calls++;active++;return original(...args).finally(()=>{active--;});});
 await assert.rejects(verifyRecoverabilityRowHashes(input),SyntaxError);assert.equal(calls,39);assert.equal(active,0);
 await verifyRecoverabilityRowHashes([]);assert.equal(calls,39);
});

test('large immutable row strings keep actual WebCrypto and the existing32-worker bound',async context=>{
 const original=crypto.subtle.digest.bind(crypto.subtle),value={text:'x'.repeat(65536)},payload_json=JSON.stringify(value),content_hash=await contentHash(canonical(value));
 let calls=0,active=0,maximum=0;
 context.mock.method(crypto.subtle,'digest',(...args:DigestArgs)=>{calls++;active++;maximum=Math.max(maximum,active);return original(...args).finally(()=>{active--;});});
 const input=Array.from({length:40},()=>({payload_json,content_hash}));
 await verifyRecoverabilityRowHashes(input);assert.equal(calls,40);assert.equal(maximum,32);assert.equal(active,0);
 input[39]={...input[39],content_hash:'a'.repeat(64)};
 await assert.rejects(verifyRecoverabilityRowHashes(input),/Current normalized content hash differs/);assert.equal(calls,80);assert.equal(active,0);
});
