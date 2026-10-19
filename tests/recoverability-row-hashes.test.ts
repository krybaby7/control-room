import test from 'node:test';
import assert from 'node:assert/strict';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {BUNDLE_LIMITS} from '../lib/workspace-export-core.ts';
import {verifyRecoverabilityRowHashes,RECOVERABILITY_HASH_CONCURRENCY} from '../lib/recoverability-row-hashes.ts';
import {createSerializationHashContext,closeSerializationHashContext,serializationHash} from '../lib/serialization-hash.ts';
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

test('physical verification shares genuine exact canonical digests with only its operation serializer',async t=>{
 const input=await rows(75),before=structuredClone(input),native=crypto.subtle.digest.bind(crypto.subtle);let calls=0;
 t.mock.method(crypto.subtle,'digest',(...args:DigestArgs)=>{calls++;return native(...args);});
 const operation=createSerializationHashContext();
 try{
  await verifyRecoverabilityRowHashes(input,operation);assert.equal(calls,75);
  for(const row of input)assert.equal(await serializationHash(canonical(JSON.parse(row.payload_json)),operation),row.content_hash);
  assert.equal(calls,75,'adapter serialization reuses actual verified bytes');assert.deepEqual(input,before);
  const changed={...JSON.parse(input[0].payload_json),text:'different owner content'};
  assert.notEqual(await serializationHash(canonical(changed),operation),input[0].content_hash);assert.equal(calls,76);
 }finally{closeSerializationHashContext(operation);}
 assert.throws(()=>serializationHash(canonical(JSON.parse(input[0].payload_json)),operation),/closed/);
 const next=createSerializationHashContext();try{await verifyRecoverabilityRowHashes(input,next);assert.equal(calls,151,'a fresh owner operation genuinely digests all rows');}finally{closeSerializationHashContext(next);}
});
test('shared digest bytes never authorize another claimed hash or modified physical payload',async t=>{
 const input=await rows(40),native=crypto.subtle.digest.bind(crypto.subtle);let active=0;
 t.mock.method(crypto.subtle,'digest',(...args:DigestArgs)=>{active++;return native(...args).finally(()=>{active--;});});
 const operation=createSerializationHashContext();
 try{
  await verifyRecoverabilityRowHashes(input,operation);
  await assert.rejects(verifyRecoverabilityRowHashes([...input,{...input[0],content_hash:'f'.repeat(64)}],operation),/Current normalized content hash differs/);
  await assert.rejects(verifyRecoverabilityRowHashes([...input.slice(0,39),{...input[39],payload_json:JSON.stringify({changed:true})}],operation),/Current normalized content hash differs/);
  assert.equal(active,0,'all started genuine digests settle on either refusal');
 }finally{closeSerializationHashContext(operation);}
 await assert.rejects(verifyRecoverabilityRowHashes(input,operation),/closed/);
 assert.equal(active,0);
});

test('server physical verification and subsequent serializer share genuine bounded native SHA without cross-operation state',async t=>{
 const {createServerSerializationHashContext}=await import('../lib/server/serialization-hash.ts'),{default:nodeCrypto}=await import('node:crypto'),{syncBuiltinESMExports}=await import('node:module');
 const originalCreateHash=nodeCrypto.createHash.bind(nodeCrypto);let nativeCalls=0;t.mock.method(nodeCrypto,'createHash',(...args:Parameters<typeof nodeCrypto.createHash>)=>{nativeCalls++;return originalCreateHash(...args);});syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
 const input=await rows(512),expected=await Promise.all(input.map(row=>contentHash(canonical(JSON.parse(row.payload_json))))),native=crypto.subtle.digest.bind(crypto.subtle);let calls=0;
 t.mock.method(crypto.subtle,'digest',(...args:DigestArgs)=>{calls++;return native(...args);});
 const operation=createServerSerializationHashContext();
 try{
  await verifyRecoverabilityRowHashes(input,operation);assert.equal(calls,0,'small physical bytes use the fixed genuine server SHA');assert.equal(nativeCalls,512);
  for(const [index,row]of input.entries())assert.equal(await serializationHash(canonical(JSON.parse(row.payload_json)),operation),expected[index]);
  assert.equal(calls,0,'later exact serialization reuses the genuinely computed digest');assert.equal(nativeCalls,512);
  await assert.rejects(verifyRecoverabilityRowHashes([...input,{...input[511],content_hash:'f'.repeat(64)}],operation),/Current normalized content hash differs/);
  await assert.rejects(verifyRecoverabilityRowHashes([{...input[0],payload_json:JSON.stringify({changed:'different canonical bytes'})}],operation),/Current normalized content hash differs/);
 }finally{closeSerializationHashContext(operation);}
 await assert.rejects(verifyRecoverabilityRowHashes(input,operation),/closed/);
 const next=createServerSerializationHashContext(),{serializationState}=await import('../lib/internal/serialization-hash-state.ts');try{assert.equal(serializationState(next)!.entries.size,0,'a new operation starts with no retained digest');const beforeNative=nativeCalls;await verifyRecoverabilityRowHashes(input,next);assert.equal(calls,0);assert.equal(nativeCalls,beforeNative+512,'every new operation computes genuine native SHA again');assert.equal(serializationState(next)!.entries.size,512);}finally{closeSerializationHashContext(next);}
});

test('combined 512-row physical and portable serializer image retains actual byte bounds; oversized and full contexts use genuine WebCrypto',async t=>{
 const {createServerSerializationHashContext}=await import('../lib/server/serialization-hash.ts'),{serializationState}=await import('../lib/internal/serialization-hash-state.ts'),{SERIALIZATION_HASH_LIMITS}=await import('../lib/serialization-hash.ts');
 // Same 256 head/version topology and 364-byte statement filler as the retained
 // near-cap benchmark, with independent synthetic IDs and no fixture reduction.
 const values=Array.from({length:256},(_,index)=>{const id='bounded-evidence-'+String(index).padStart(4,'0');return [{id,currentVersion:1,archivedAt:null},{id,version:1,basis:'owner-statement',scope:'implementation',title:'Synthetic bounded context '+index,statement:'Synthetic benchmark context. '+'x'.repeat(364),observedAt:null,recordedAt:'2026-10-18T12:00:00.000Z',candidate:null,environment:null,sourceUrl:null,sourceRevision:null,sourceRecordId:null,attachmentIds:[],supersedesVersion:null}];}).flat();
 const input=await Promise.all(values.map(async value=>({payload_json:JSON.stringify(value,null,2),content_hash:await contentHash(canonical(value))}))),portable=values.map((record,index)=>({kind:index%2?'version':'head',physicalId:'physical-'+index,record})),expected=await Promise.all(portable.map(value=>contentHash(canonical(value))));
 const native=crypto.subtle.digest.bind(crypto.subtle);let calls=0;t.mock.method(crypto.subtle,'digest',(...args:DigestArgs)=>{calls++;return native(...args);});
 const operation=createServerSerializationHashContext();
 try{
  await verifyRecoverabilityRowHashes(input,operation);assert.equal(calls,0);
  for(const [index,value]of portable.entries())assert.equal(await serializationHash(canonical(value),operation),expected[index]);
  assert.equal(calls,0);const state=serializationState(operation)!;const expectedBytes=[...values,...portable].reduce((total,value)=>total+new TextEncoder().encode(canonical(value)).byteLength,0);assert.equal(state.bytes,expectedBytes);assert.ok(state.bytes>400000&&state.bytes<600000);assert.equal(state.entries.size,1024);assert.ok(state.bytes<=SERIALIZATION_HASH_LIMITS.retainedUtf8Bytes);
  // Fill only the remaining admitted byte allowance. An overflow is never
  // retained and must use the unchanged WebCrypto fallback, even for small data.
  let index=0;while(state.bytes+65536<=SERIALIZATION_HASH_LIMITS.retainedUtf8Bytes)await serializationHash(String(index++).padStart(5,'0')+'x'.repeat(65531),operation);
  const remainder=SERIALIZATION_HASH_LIMITS.retainedUtf8Bytes-state.bytes;if(remainder)await serializationHash('z'.repeat(remainder),operation);
  assert.equal(state.bytes,SERIALIZATION_HASH_LIMITS.retainedUtf8Bytes);const retainedEntries=state.entries.size;
  await serializationHash('uncached-overflow',operation);await serializationHash('uncached-overflow',operation);assert.equal(calls,2);assert.equal(state.bytes,SERIALIZATION_HASH_LIMITS.retainedUtf8Bytes);assert.equal(state.entries.size,retainedEntries);
 }finally{closeSerializationHashContext(operation);}
 const fallback=createServerSerializationHashContext();try{const value={text:'😀'.repeat(16384)},canonicalValue=canonical(value),row={payload_json:canonicalValue,content_hash:await contentHash(canonicalValue)};const before=calls;await verifyRecoverabilityRowHashes([row],fallback);assert.equal(calls,before+1,'physical input greater than 64KiB UTF8 uses real WebCrypto');}finally{closeSerializationHashContext(fallback);}
});
