import test from 'node:test';
import assert from 'node:assert/strict';
import {backupArchiveObjectStream} from '../lib/backup-archive-object-stream.ts';
import {createBackupArchiveStorage,backupArchiveKey} from '../lib/backup-archive-storage.ts';
import {contentHash} from '../lib/canonical-json.ts';
const namespace='f3da590c-2a12-4c48-b680-d177ccbb2469';
const chunks=[{part:0,bytes:3,sha256:'a'.repeat(64)},{part:1,bytes:1,sha256:'b'.repeat(64)}];
function gate<T>(){let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
test('cancellation waits for its actual in-flight bounded GET and never reads or enqueues a later chunk',async()=>{
 const entered=gate<void>(),body=gate<Uint8Array|null>();let calls=0,settled=false;
 const stream=backupArchiveObjectStream({async get(){calls++;entered.resolve();return body.promise;}},namespace,chunks);
 await entered.promise;const cancellation=stream.cancel().then(()=>{settled=true;});
 await Promise.resolve();await Promise.resolve();assert.equal(settled,false);assert.equal(calls,1);
 body.resolve(new Uint8Array([1,2,3]));await cancellation;assert.equal(settled,true);assert.equal(calls,1);
 assert.deepEqual(await stream.getReader().read(),{done:true,value:undefined});
});
test('a failing in-flight GET is settled and suppressed after cancellation, without a late controller error',async()=>{
 const entered=gate<void>(),body=gate<Uint8Array|null>();let calls=0;
 const stream=backupArchiveObjectStream({async get(){calls++;entered.resolve();return body.promise;}},namespace,chunks);
 await entered.promise;const cancellation=stream.cancel();body.reject(new Error('synthetic bounded GET failure'));await cancellation;
 assert.equal(calls,1);assert.deepEqual(await stream.getReader().read(),{done:true,value:undefined});
});
test('cancelling a real verified native-storage body waits for its pending read, preserving digest, length and physical key checks',async()=>{
 const entered=gate<void>(),release=gate<void>(),bytes=new Uint8Array([1,2,3]),sha256=await contentHash(bytes);let gets=0,reads=0;
 const storage=createBackupArchiveStorage({async put(){throw new Error('No PUT is authorized by this fixture.');},async get(key){
  gets++;assert.equal(key,backupArchiveKey(namespace,0));return {size:3,customMetadata:{sha256},httpMetadata:{contentType:'application/octet-stream'},body:new ReadableStream<Uint8Array>({async pull(controller){reads++;entered.resolve();await release.promise;controller.enqueue(bytes);controller.close();}})};
 }});
 const stream=backupArchiveObjectStream(storage,namespace,[{part:0,bytes:3,sha256}]);await entered.promise;
 let settled=false;const cancellation=stream.cancel().then(()=>{settled=true;});await Promise.resolve();assert.equal(settled,false);
 release.resolve();await cancellation;assert.equal(gets,1);assert.equal(reads,1);assert.equal(settled,true);
});
test('ordinary reads preserve ordered exact bytes and close after the last chunk',async()=>{
 const seen:number[]=[],stream=backupArchiveObjectStream({async get(_namespace,chunk){seen.push(chunk.part);return new Uint8Array(chunk.part===0?[1,2,3]:[4]);}},namespace,chunks),reader=stream.getReader();
 assert.deepEqual((await reader.read()).value,new Uint8Array([1,2,3]));assert.deepEqual((await reader.read()).value,new Uint8Array([4]));assert.equal((await reader.read()).done,true);assert.deepEqual(seen,[0,1]);
});
test('missing and failed GETs remain read errors when the consumer has not cancelled',async()=>{
 for(const failure of [null,new Error('synthetic storage deadline')]){
  let calls=0;const stream=backupArchiveObjectStream({async get(){calls++;if(failure)throw failure;return null;}},namespace,chunks);
  await assert.rejects(stream.getReader().read(),failure?/synthetic storage deadline/:/reserved archive object is missing/);assert.equal(calls,1);
 }
});
test('an original abort prevents a new GET and an in-flight abort error remains visible without consumer cancellation',async()=>{
 const before=new AbortController();before.abort();let calls=0;
 await assert.rejects(backupArchiveObjectStream({async get(){calls++;return new Uint8Array([1,2,3]);}},namespace,chunks,before.signal).getReader().read(),/cancelled before/);assert.equal(calls,0);
 const active=new AbortController(),entered=gate<void>();
 const stream=backupArchiveObjectStream({async get(_namespace,_chunk,signal){calls++;entered.resolve();return new Promise<Uint8Array>((_resolve,reject)=>signal!.addEventListener('abort',()=>reject(new Error('synthetic original abort')),{once:true}));}},namespace,chunks,active.signal),read=stream.getReader().read();
 await entered.promise;active.abort();await assert.rejects(read,/synthetic original abort/);assert.equal(calls,1);
});
