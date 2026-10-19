import test from 'node:test';
import assert from 'node:assert/strict';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {registerHashWorkDiagnostics,startHashWork} from '../lib/hash-work-diagnostics.ts';
test('diagnostics retain canonical bytes and actual native SHA, without recursive timing double count',async()=>{
 const events:Array<{stage:string;bytes:number}>=[];
 const stop=registerHashWorkDiagnostics(stage=>bytes=>events.push({stage,bytes}));
 try{
 assert.equal(canonical({z:['العربية',1],a:true}),'{"a":true,"z":["العربية",1]}');
 assert.equal(await contentHash('abc'),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
 assert.equal(events.filter(event=>event.stage==='canonical').length,1);
 assert.deepEqual(events.filter(event=>event.stage.startsWith('sha-')).map(event=>event.stage),['sha-encode','sha-submit','sha-await','sha-hex']);
 assert.equal(events.find(event=>event.stage==='sha-submit')!.bytes,3);
 assert.equal(events.find(event=>event.stage==='sha-await')!.bytes,3);
 }finally{stop();}
});
test('observer failures, replacement and repeated completion never change hashing or leak an old registration',async()=>{
 let first=0,second=0;
 const old=registerHashWorkDiagnostics(()=>()=>{first++;});
 const current=registerHashWorkDiagnostics(()=>()=>{second++;throw new Error('synthetic diagnostic failure');});
 old();const finish=startHashWork('canonical');finish();finish();assert.equal(first,0);assert.equal(second,1);
 assert.equal(await contentHash(new TextEncoder().encode('abc')),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
 current();const stopped=second;canonical({private:'not emitted'});assert.equal(second,stopped);
 const broken=registerHashWorkDiagnostics(()=>{throw new Error('synthetic observer start failure');});
 try{assert.equal(canonical({a:1}),'{"a":1}');}finally{broken();}
});
