import test from 'node:test';
import assert from 'node:assert/strict';
import {contentHash} from '../lib/canonical-json.ts';
import {serverContentHash,SERVER_SYNC_SHA_MAX_BYTES} from '../lib/server-content-hash.ts';
const limit=SERVER_SYNC_SHA_MAX_BYTES;
const strings=['','abc','العربية 😀','\\ud800','\\udfff','x'.repeat(limit-1),'x'.repeat(limit),'x'.repeat(limit+1),'é'.repeat(limit/2),'é'.repeat(limit/2+1),'😀'.repeat(limit/4),'😀'.repeat(limit/4+1)];
test('server small-string native SHA preserves actual UTF8 digest bytes at all boundaries',async()=>{
 for(const value of strings)assert.equal(await serverContentHash(value),await contentHash(value));
});
test('all binary inputs and larger strings retain WebCrypto rather than synchronous hashing',async()=>{
 const original=crypto.subtle.digest,inputs:Array<BufferSource>=[];
 crypto.subtle.digest=async function(algorithm,data){inputs.push(data);return original.call(this,algorithm,data);};
 try{
 const binary=new Uint8Array([0,255,128,65]);
 await serverContentHash('abc');assert.equal(inputs.length,0);
 await serverContentHash('é'.repeat(limit/2));assert.equal(inputs.length,0);
 await serverContentHash('é'.repeat(limit/2+1));assert.equal(inputs.length,1);
 await serverContentHash('x'.repeat(limit+1));assert.equal(inputs.length,2);
 await serverContentHash(binary);assert.equal(inputs.length,3);assert.equal(inputs[2],binary);
 }finally{crypto.subtle.digest=original;}
});
test('actual Miniflare Worker nodejs_compat executes native SHA with exact WebCrypto parity',{timeout:120000},async()=>{
 const {Miniflare}=await import('miniflare'),{build}=await import('esbuild');
 const modulePath=new URL('../lib/server-content-hash.ts',import.meta.url).pathname;
 const bundled=await build({stdin:{contents:`import {serverContentHash} from ${JSON.stringify(modulePath)}; export default {async fetch(request){const values=await request.json();const result=[];for(const value of values){const bytes=new TextEncoder().encode(value);const expected=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');result.push({same:await serverContentHash(value)===expected});}return Response.json(result);}}`,resolveDir:process.cwd()},bundle:true,write:false,platform:'neutral',format:'esm',external:['node:crypto']});
 const mf=new Miniflare({modules:true,script:bundled.outputFiles[0].text,compatibilityDate:'2026-05-15',compatibilityFlags:['nodejs_compat']});
 try{
 const response=await mf.dispatchFetch('http://synthetic.invalid/',{method:'POST',body:JSON.stringify(strings)});
 assert.equal(response.status,200);assert.deepEqual(await response.json(),strings.map(()=>({same:true})));
 }finally{await mf.dispose();}
});
