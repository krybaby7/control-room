import test from 'node:test';
import assert from 'node:assert/strict';
import {AsyncLocalStorage} from 'node:async_hooks';
import type {SqlDatabase} from '../lib/workspace-store.ts';
import {registerRecoverabilityDiagnostics,startRecoverabilityPhase,type RecoverabilityPhase} from '../lib/recoverability-diagnostics.ts';
// Pure routing sentinels: no SQL adapter or owner data participates in this helper.
function db():SqlDatabase{return {} as SqlDatabase;}
test('interleaved request-local sinks capture at start and remain isolated across completion contexts',()=>{
 const database=db(),local=new AsyncLocalStorage<Array<{phase:RecoverabilityPhase;elapsed:number}>>(),left:Array<{phase:RecoverabilityPhase;elapsed:number}>=[],right:Array<{phase:RecoverabilityPhase;elapsed:number}>=[];
 const remove=registerRecoverabilityDiagnostics(database,phase=>{const sink=local.getStore();if(!sink)return;return elapsed=>{sink.push({phase,elapsed});};});
 const endLeft=local.run(left,()=>startRecoverabilityPhase(database,'hash-current')),endRight=local.run(right,()=>startRecoverabilityPhase(database,'bundleafter'));
 local.run(right,endLeft);local.run(left,endRight);endLeft();endRight();
 assert.deepEqual(left.map(value=>value.phase),['hash-current']);assert.deepEqual(right.map(value=>value.phase),['bundleafter']);
 for(const value of [...left,...right])assert.ok(Number.isFinite(value.elapsed)&&value.elapsed>=0);
 remove();local.run(left,()=>startRecoverabilityPhase(database,'measure')());assert.equal(left.length,1);
});
test('DB routing and cleanup generations cannot clear a newer registration, including reuse of the same callback',()=>{
 const first=db(),second=db(),values:string[]=[];
 const listener=(phase:RecoverabilityPhase)=>()=>{values.push(phase);};
 const old=registerRecoverabilityDiagnostics(first,listener),current=registerRecoverabilityDiagnostics(first,listener);old();
 startRecoverabilityPhase(second,'measure')();assert.deepEqual(values,[]);
 startRecoverabilityPhase(first,'projectplan')();assert.deepEqual(values,['projectplan']);
 current();startRecoverabilityPhase(first,'measure')();assert.deepEqual(values,['projectplan']);
});
test('observer failures, invalid tags, and completed phases never change application behavior',()=>{
 const database=db();assert.doesNotThrow(()=>startRecoverabilityPhase(database,'measure')());
 let calls=0;
 const remove=registerRecoverabilityDiagnostics(database,()=>{calls++;throw new Error('synthetic diagnostic failure');});
 assert.doesNotThrow(()=>startRecoverabilityPhase(database,'measure')());assert.equal(calls,1);
 assert.doesNotThrow(()=>startRecoverabilityPhase(database,'untrusted-tag' as RecoverabilityPhase)());assert.equal(calls,1);remove();
 registerRecoverabilityDiagnostics(database,()=>()=>{calls++;throw new Error('synthetic completion failure');});
 const finish=startRecoverabilityPhase(database,'finalreads');assert.doesNotThrow(finish);assert.doesNotThrow(finish);assert.equal(calls,2);
});
