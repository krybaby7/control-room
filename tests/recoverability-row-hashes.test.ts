import test from 'node:test';
import assert from 'node:assert/strict';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {BUNDLE_LIMITS} from '../lib/workspace-export-core.ts';
import {verifyRecoverabilityRowHashes,RECOVERABILITY_HASH_CONCURRENCY} from '../lib/recoverability-row-hashes.ts';
type DigestArgs=Parameters<typeof crypto.subtle.digest>;
async function rows(count:number){return Promise.all(Array.from({length:count},async(_,index)=>{const value={id:'original-'+index,text:'مرحبا 😀 é / punctuation',index};return {payload_json:JSON.stringify(value,null,index%2?2:0),content_hash:await contentHash(canonical(value))};}));}
test('all512 original canonical hashes use actual WebCrypto with at most32 active digests and no input rewriting',async context=>{
 const input=await rows(512),before=structuredClone(input),original=crypto.subtle.digest.bind(crypto.subtle);let calls=0,active=0,maximum=0;
 context.mock.method(crypto.subtle,'digest',(...args:DigestArgs)=>{calls++;active++;maximum=Math.max(maximum,active);return original(...args).finally(()=>{active--;});});
 await verifyRecoverabilityRowHashes(input);assert.equal(calls,512);assert.equal(maximum,RECOVERABILITY_HASH_CONCURRENCY);assert.equal(active,0);assert.deepEqual(input,before);
 await verifyRecoverabilityRowHashes(input);assert.equal(calls,1024,'no cross-call hash cache');assert.equal(active,0);
});
test('canonical UTF8 identity is exact and a corrupt late row cannot certify any successful snapshot',async context=>{
 const input=await rows(75),original=crypto.subtle.digest.bind(crypto.subtle);let calls=0,active=0;
 input[74]={...input[74],payload_json:JSON.stringify({id:'original-74',text:'Changed original content',index:74})};const before=structuredClone(input);
 context.mock.method(crypto.subtle,'digest',(...args:DigestArgs)=>{calls++;active++;return original(...args).finally(()=>{active--;});});
 await assert.rejects(verifyRecoverabilityRowHashes(input),/Current normalized content hash differs/);assert.equal(calls,75);assert.equal(active,0);assert.deepEqual(input,before);
 input[74].content_hash=await contentHash(canonical(JSON.parse(input[74].payload_json)));await verifyRecoverabilityRowHashes(input);assert.equal(active,0);
});
test('UTF8 aggregate overflow is refused before scheduling even the first actual digest',async context=>{
 const first=(await rows(1))[0],oversized={payload_json:JSON.stringify({text:'😀'.repeat(BUNDLE_LIMITS.bytes/4)}),content_hash:'a'.repeat(64)},original=crypto.subtle.digest.bind(crypto.subtle);let calls=0;
 assert.ok(oversized.payload_json.length<BUNDLE_LIMITS.bytes);assert.ok(new TextEncoder().encode(oversized.payload_json).byteLength>BUNDLE_LIMITS.bytes);
 context.mock.method(crypto.subtle,'digest',(...args:DigestArgs)=>{calls++;return original(...args);});
 await assert.rejects(verifyRecoverabilityRowHashes([first,oversized]),/Physical snapshot byte bound exceeded/);assert.equal(calls,0);
});
test('invalid JSON retains its original parse refusal and every other started digest settles before return',async context=>{
 const input=await rows(40),original=crypto.subtle.digest.bind(crypto.subtle);let active=0,calls=0;input[3]={payload_json:'not original JSON',content_hash:'b'.repeat(64)};
 context.mock.method(crypto.subtle,'digest',(...args:DigestArgs)=>{calls++;active++;return original(...args).finally(()=>{active--;});});
 await assert.rejects(verifyRecoverabilityRowHashes(input),SyntaxError);assert.equal(calls,39);assert.equal(active,0);
 await verifyRecoverabilityRowHashes([]);assert.equal(calls,39);
});
