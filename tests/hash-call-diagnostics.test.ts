import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createHashCallFrame,finishHashCallFrame,installHashCallDiagnostics,HASH_DIAGNOSTIC_LIMITS} from '../scripts/lib/hash-call-diagnostics.mjs';
const encode=(value:string)=>new TextEncoder().encode(value);
test('native SHA executes for every repeated exact input while only safe counters leave the diagnostic frame',async t=>{
 const subtle=webcrypto.subtle,original=subtle.digest,native=subtle.digest.bind(subtle),state=createHashCallFrame(),marker='synthetic-private-input-never-report',bytes=encode(JSON.stringify({marker}));
 const expected=await native('SHA-256',bytes),restore=installHashCallDiagnostics(subtle,()=>({state,phase:'originalserializer'}));t.after(restore);
 for(let index=0;index<3;index++)assert.deepEqual(await subtle.digest('SHA-256',bytes),expected);
 await subtle.digest('SHA-256',encode(JSON.stringify({marker,changed:true})));await subtle.digest('SHA-1',bytes);
 const summary=finishHashCallFrame(state);assert.equal(summary.nativeDigestCalls,5);assert.equal(summary.sha256Calls,4);assert.equal(summary.uniqueInputs,2);assert.equal(summary.duplicateCalls,2);assert.equal(summary.trackedCalls,4);
 assert.equal(summary.untrackedCalls,0);assert.equal(summary.diagnosticFailures,0);assert.equal(JSON.stringify(summary).includes(marker),false);assert.equal(summary.byPhase.originalserializer.duplicateCalls,2);
 restore();assert.equal(subtle.digest,original);
});
test('interleaved real native digests count input identity only inside each ALS request and preserve native errors',async t=>{
 const local=new AsyncLocalStorage<ReturnType<typeof createHashCallFrame>>(),left=createHashCallFrame(),right=createHashCallFrame(),subtle=webcrypto.subtle;
 const restore=installHashCallDiagnostics(subtle,()=>{const state=local.getStore();return state?{state,phase:'outside-recovery'}:null;});t.after(restore);
 const bytes=encode('same synthetic input, distinct request');
 const [a,b]=await Promise.all([local.run(left,()=>subtle.digest('SHA-256',bytes)),local.run(right,()=>subtle.digest('SHA-256',bytes))]);assert.deepEqual(a,b);
 await local.run(left,()=>assert.rejects(subtle.digest('not-an-algorithm',bytes),{name:'NotSupportedError'}));
 const x=finishHashCallFrame(left),y=finishHashCallFrame(right);assert.equal(x.nativeDigestCalls,2);assert.equal(y.nativeDigestCalls,1);assert.equal(x.uniqueInputs,1);assert.equal(y.uniqueInputs,1);assert.equal(x.duplicateCalls,0);assert.equal(y.duplicateCalls,0);
});
test('UTF8 identity preserves BOM bytes, rejects invalid decoding from tracking, and bounds retained input bytes',async t=>{
 const subtle=webcrypto.subtle,state=createHashCallFrame(),restore=installHashCallDiagnostics(subtle,()=>({state,phase:'hash-current'}));t.after(restore);
 await subtle.digest('SHA-256',encode('a'));await subtle.digest('SHA-256',encode('\uFEFFa'));await subtle.digest('SHA-256',new Uint8Array([0xc0,0x80]));
 let summary=finishHashCallFrame(state);assert.equal(summary.uniqueInputs,2);assert.equal(summary.duplicateCalls,0);assert.equal(summary.invalidUtf8Calls,1);assert.equal(summary.untrackedCalls,1);
 restore();
 const bounded=createHashCallFrame(),remove=installHashCallDiagnostics(subtle,()=>({state:bounded,phase:'hash-current'}));t.after(remove);
 for(let index=0;index<6;index++)await subtle.digest('SHA-256',encode(String(index)+'x'.repeat(200000)));
 await subtle.digest('SHA-256',new Uint8Array(HASH_DIAGNOSTIC_LIMITS.inputBytes+1));
 summary=finishHashCallFrame(bounded);assert.equal(summary.nativeDigestCalls,7);assert.equal(summary.uniqueInputs,5);assert.equal(summary.untrackedCalls,2);assert.ok(summary.retainedUtf8Bytes<=HASH_DIAGNOSTIC_LIMITS.retainedUtf8Bytes);
});
test('entry bounds, restoration and diagnostic listener failure never suppress actual native digest work',async t=>{
 const subtle=webcrypto.subtle,original=subtle.digest,state=createHashCallFrame(),restore=installHashCallDiagnostics(subtle,()=>({state,phase:'unknown-untrusted-label'}));t.after(restore);
 for(let index=0;index<HASH_DIAGNOSTIC_LIMITS.uniqueInputs+1;index++)await subtle.digest('SHA-256',encode('bounded-'+index));
 const summary=finishHashCallFrame(state);assert.equal(summary.uniqueInputs,HASH_DIAGNOSTIC_LIMITS.uniqueInputs);assert.equal(summary.untrackedCalls,1);assert.equal(summary.nativeDigestCalls,HASH_DIAGNOSTIC_LIMITS.uniqueInputs+1);assert.deepEqual(Object.keys(summary.byPhase),['outside-recovery']);
 restore();assert.equal(subtle.digest,original);
 const remove=installHashCallDiagnostics(subtle,()=>{throw new Error('synthetic diagnostics failure');});t.after(remove);
 assert.equal((await subtle.digest('SHA-256',encode('still native'))).byteLength,32);remove();assert.equal(subtle.digest,original);
});
