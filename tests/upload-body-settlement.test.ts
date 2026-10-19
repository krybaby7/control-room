import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {Miniflare} from 'miniflare';
import {settleUploadBody} from '../lib/upload-body-settlement.ts';
test('small denial body drains to EOF and unlocks before response without retaining bytes',async()=>{
 let pulls=0;const body=new ReadableStream<Uint8Array>({pull(controller){if(++pulls===3)controller.close();else controller.enqueue(new Uint8Array(16));}});assert.equal(await settleUploadBody(body),'drained');assert.equal(body.locked,false);assert.equal(pulls,3);assert.equal(await settleUploadBody(null),'empty');
});
test('oversize cancellation is awaited, while a hung read or hung cancellation stays bounded',async()=>{
 let complete=false;const body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(64));},async cancel(){await new Promise(resolve=>setTimeout(resolve,20));complete=true;}});assert.equal(await settleUploadBody(body,{maxBytes:32}),'cancelled');assert.equal(complete,true);assert.equal(body.locked,false);
 let cancelled=false;const hanging=new ReadableStream<Uint8Array>({cancel(){cancelled=true;}});assert.equal(await settleUploadBody(hanging,{drainMs:10}),'cancelled');assert.equal(cancelled,true);assert.equal(hanging.locked,false);
 const ambiguous=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(64));},cancel(){return new Promise(()=>{});}});assert.equal(await settleUploadBody(ambiguous,{maxBytes:32,cancelMs:10}),'unsettled');assert.equal(ambiguous.locked,false);
});
test('closed, errored and locked streams do not create unhandled disposal errors',async()=>{
 const closed=new ReadableStream<Uint8Array>({start(controller){controller.close();}});assert.equal(await settleUploadBody(closed),'drained');
 const failed=new ReadableStream<Uint8Array>({start(controller){controller.error(new Error('Synthetic disconnection'));}});assert.equal(await settleUploadBody(failed),'unsettled');assert.equal(failed.locked,false);
 const locked=new ReadableStream<Uint8Array>();const reader=locked.getReader();assert.equal(await settleUploadBody(locked),'unsettled');await reader.cancel();reader.releaseLock();
});
test('actual workerd HTTP denial statuses settle uploaded bodies before repeated healthy requests',async()=>{
 const implementation=stripTypeScriptTypes(readFileSync(new URL('../lib/upload-body-settlement.ts',import.meta.url),'utf8'));
 const mf=new Miniflare({modules:[{type:'ESModule',path:'worker.js',contents:`import {settleUploadBody} from './settle.js';export default {async fetch(request){const status=Number(new URL(request.url).pathname.slice(1));if(status!==200){const settled=await settleUploadBody(request.body);return Response.json({status,settled},{status});}const text=await request.text();await settleUploadBody(request.body);return Response.json({text});}};`},{type:'ESModule',path:'settle.js',contents:implementation}],compatibilityDate:'2026-05-15',cf:false});
 try{const base=await mf.ready;
  for(let round=0;round<3;round++)for(const status of [409,403,404,401]){const response=await fetch(new URL(`/${status}`,base),{method:'PUT',body:'Synthetic rejected upload body.',signal:AbortSignal.timeout(5000)});assert.equal(response.status,status);assert.deepEqual(await response.json(),{status,settled:'drained'});const healthy=await fetch(new URL('/200',base),{method:'PUT',body:'Synthetic healthy upload body.',signal:AbortSignal.timeout(5000)});assert.equal(healthy.status,200);assert.deepEqual(await healthy.json(),{text:'Synthetic healthy upload body.'});}
 }finally{await mf.dispose();}
});
