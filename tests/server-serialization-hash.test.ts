import test from 'node:test';
import assert from 'node:assert/strict';
import {contentHash} from '../lib/canonical-json.ts';
import {createSerializationHashContext,closeSerializationHashContext,serializationHash,SERIALIZATION_HASH_LIMITS,type SerializationHashContext} from '../lib/serialization-hash.ts';
import {createServerSerializationHashContext,SERVER_SERIALIZATION_SHA_BYTES} from '../lib/server/serialization-hash.ts';
import {bindServerSerializationDigest} from '../lib/internal/serialization-hash-state.ts';
type DigestArgs=Parameters<typeof crypto.subtle.digest>;
test('server fixed SHA matches genuine WebCrypto for Unicode, malformed surrogates and exact UTF8 threshold',async t=>{
 const values=['','abc','العربية 😀 é','\uD800','\uDC00','\uD800x\uDC00','a'.repeat(65536),'😀'.repeat(16384),'a'.repeat(65537),'😀'.repeat(16384)+'x'];
 const expected=await Promise.all(values.map(value=>contentHash(value))),native=crypto.subtle.digest.bind(crypto.subtle);let webCalls=0;
 t.mock.method(crypto.subtle,'digest',(...args:DigestArgs)=>{webCalls++;return native(...args);});
 const context=createServerSerializationHashContext();try{for(const [index,value]of values.entries())assert.equal(await serializationHash(value,context),expected[index]);assert.equal(webCalls,2,'only >64KiB UTF8 uses WebCrypto');}finally{closeSerializationHashContext(context);}
 assert.equal(SERVER_SERIALIZATION_SHA_BYTES,65536);
});
test('default and no-context stay WebCrypto; server cache overflow and large input retain original fallback',async t=>{
 const native=crypto.subtle.digest.bind(crypto.subtle);let webCalls=0;t.mock.method(crypto.subtle,'digest',(...args:DigestArgs)=>{webCalls++;return native(...args);});
 const ordinary=createSerializationHashContext(),server=createServerSerializationHashContext();
 try{
  await serializationHash('default',ordinary);await serializationHash('default');assert.equal(webCalls,2);
  await serializationHash('server',server);await serializationHash('server',server);assert.equal(webCalls,2,'bounded server bytes bypass asynchronous WebCrypto and reuse genuine digest');
  const oversized='x'.repeat(SERIALIZATION_HASH_LIMITS.inputBytes+1);await serializationHash(oversized,server);await serializationHash(oversized,server);assert.equal(webCalls,4);
  for(let index=0;index<SERIALIZATION_HASH_LIMITS.entries-1;index++)await serializationHash('distinct-'+index,server);
  await serializationHash('entry overflow',server);await serializationHash('entry overflow',server);assert.equal(webCalls,6);
  const byteBound=createServerSerializationHashContext();try{for(let index=0;index<16;index++)await serializationHash(String.fromCharCode(65+index)+'x'.repeat(65535),byteBound);assert.equal(webCalls,6);await serializationHash('byte overflow',byteBound);await serializationHash('byte overflow',byteBound);assert.equal(webCalls,8,'retained byte overflow uses uncached WebCrypto even for small server strings');}finally{closeSerializationHashContext(byteBound);}
 }finally{closeSerializationHashContext(ordinary);closeSerializationHashContext(server);}
});
test('code-only capability is one-time and unused; forged, serialized, closed contexts and public options fail closed',async()=>{
 const context=createServerSerializationHashContext(),ordinary=createSerializationHashContext();
 assert.throws(()=>Reflect.apply(createSerializationHashContext,undefined,[{backend:'native'}]),/no options/);
 assert.throws(()=>Reflect.apply(createServerSerializationHashContext,undefined,[()=> 'a'.repeat(64)]),/no options/);
 assert.throws(()=>serializationHash('x',JSON.parse(JSON.stringify(context)) as SerializationHashContext),/context/);
 assert.throws(()=>serializationHash(new Uint8Array([1]) as unknown as string,context),/string/);
 assert.throws(()=>bindServerSerializationDigest(context,()=> 'a'.repeat(64)),/capability/);
 await serializationHash('used',ordinary);assert.throws(()=>bindServerSerializationDigest(ordinary,()=> 'a'.repeat(64)),/capability/);
 closeSerializationHashContext(ordinary);closeSerializationHashContext(context);
 assert.throws(()=>serializationHash('x',context),/closed/);
 assert.throws(()=>bindServerSerializationDigest(context,()=> 'a'.repeat(64)),/capability/);
 assert.throws(()=>bindServerSerializationDigest({},()=> 'a'.repeat(64)),/capability/);
});
test('actual nodejs_compat Worker server capability matches WebCrypto including threshold and surrogate fallback',{timeout:120000},async()=>{
 const {build}=await import('esbuild'),{Miniflare}=await import('miniflare');
 const bundled=await build({stdin:{contents:`import {createServerSerializationHashContext} from './lib/server/serialization-hash.ts';import {serializationHash,closeSerializationHashContext} from './lib/serialization-hash.ts';import {contentHash} from './lib/canonical-json.ts';export default {async fetch(){const values=['abc','العربية 😀 é','\\uD800','a'.repeat(65536),'😀'.repeat(16384)+'x'];const context=createServerSerializationHashContext();try{const results=[];for(const value of values)results.push([await serializationHash(value,context),await contentHash(value)]);return Response.json(results);}finally{closeSerializationHashContext(context);}}};`,resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'neutral',external:['node:crypto']});
 const mf=new Miniflare({modules:true,script:bundled.outputFiles[0].text,compatibilityDate:'2026-05-15',compatibilityFlags:['nodejs_compat']});
 try{const response=await mf.dispatchFetch('http://worker.test/');assert.equal(response.status,200);const results=await response.json() as [string,string][];assert.equal(results.length,5);for(const [actual,expected]of results){assert.match(actual,/^[a-f0-9]{64}$/u);assert.equal(actual,expected);}}finally{await mf.dispose();}
});
