import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkspacePolling } from '../lib/workspace-polling.ts';
import { SessionExpiredError } from '../lib/workspace-client.ts';
class FakeClock {
 now=0;private next=0;timers=new Map<number,{at:number;callback:()=>void}>();
 set=(callback:()=>void,delay:number)=>{const id=++this.next;this.timers.set(id,{at:this.now+delay,callback});return id;};
 clear=(handle:unknown)=>{this.timers.delete(handle as number);};
 advance(ms:number){this.now+=ms;for(const [id,timer] of [...this.timers])if(timer.at<=this.now){this.timers.delete(id);timer.callback();}}
 delay(){return Math.min(...[...this.timers.values()].map(timer=>timer.at-this.now));}
}
function deferred<T>() {let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
function fixture(read:()=>Promise<{revision:number}>,random=0.5){const clock=new FakeClock(),accepted:number[]=[],errors:unknown[]=[];let expired=0;const polling=new WorkspacePolling({read,accept:value=>accepted.push(value.revision),onExpire:()=>{expired++;},onError:error=>errors.push(error),now:()=>clock.now,setTimer:clock.set,clearTimer:clock.clear,random:()=>random});return {polling,clock,accepted,errors,expired:()=>expired};}
test('focus/online/manual share one in-flight read and periodic polling resumes at 30 seconds',async()=>{
 const request=deferred<{revision:number}>();let reads=0;const f=fixture(()=>{reads++;return request.promise;});f.polling.start();await flush();
 const focused=f.polling.focus(),manual=f.polling.manual();assert.equal(focused,manual);assert.equal(reads,1);
 request.resolve({revision:1});await flush();
 // Events share the current read instead of scheduling duplicate GETs.
 assert.equal(reads,1);assert.deepEqual(f.accepted,[1]);assert.equal(f.clock.delay(),30_000);
 f.clock.advance(29_999);await flush();assert.equal(reads,1);f.clock.advance(1);await flush();assert.equal(reads,2);f.polling.dispose();assert.equal(f.clock.timers.size,0);
});
test('hidden and signed-out states pause timers; returning visible/focus/online refresh immediately',async()=>{
 let reads=0;const f=fixture(async()=>({revision:++reads}));f.polling.start();await flush();f.polling.setVisible(false);assert.equal(f.clock.timers.size,0);f.clock.advance(100000);await f.polling.focus();assert.equal(reads,1);
 f.polling.setVisible(true);await flush();assert.equal(reads,2);await f.polling.online();assert.equal(reads,3);
 f.polling.setSignedIn(false);assert.equal(f.clock.timers.size,0);await f.polling.manual();assert.equal(reads,3);f.polling.setSignedIn(true);await flush();assert.equal(reads,4);f.polling.dispose();
});
test('failure retry backoff is 30/60/120/300 seconds with bounded jitter and resets after success',async()=>{
 let fail=true;const f=fixture(async()=>{if(fail)throw new Error('offline');return {revision:1};});f.polling.start();await flush();
 for(const delay of [30000,60000,120000,300000,300000]){assert.equal(f.clock.delay(),delay);f.clock.advance(delay);await flush();}
 fail=false;await f.polling.manual();assert.equal(f.polling.snapshot().failures,0);assert.equal(f.clock.delay(),30000);f.polling.dispose();
 for(const [random,expected] of [[0,27000],[1,33000]]){const jitter=fixture(async()=>({revision:1}),random);jitter.polling.start();await flush();assert.equal(jitter.clock.delay(),expected);jitter.polling.dispose();}
});
test('focus during save queues exactly one next eligible read without competing requests',async()=>{
 let reads=0;const f=fixture(async()=>({revision:++reads}));f.polling.start();await flush();f.polling.setBusy(true);await f.polling.focus();await f.polling.online();assert.equal(reads,1);assert.equal(f.clock.timers.size,0);
 f.polling.observeRevision(9);f.polling.setBusy(false);await flush();assert.equal(reads,2);assert.deepEqual(f.accepted,[1]);assert.equal(f.polling.snapshot().lastRevision,9);f.polling.dispose();
});
test('responses from prior sessions are discarded and a newer save revision never moves backward',async()=>{
 const first=deferred<{revision:number}>();let calls=0;const f=fixture(()=>++calls===1?first.promise:Promise.resolve({revision:2}));f.polling.start();await flush();f.polling.setSignedIn(false);f.polling.setSignedIn(true);first.resolve({revision:99});await flush();assert.deepEqual(f.accepted,[2]);
 f.polling.observeRevision(8);await f.polling.manual();assert.deepEqual(f.accepted,[2]);assert.equal(f.polling.snapshot().lastRevision,8);f.polling.dispose();
});
test('401 expires session, clears future polling, and never repeatedly calls onExpire',async()=>{
 const f=fixture(async()=>{throw new SessionExpiredError();});f.polling.start();await flush();assert.equal(f.expired(),1);assert.equal(f.polling.snapshot().signedIn,false);assert.equal(f.clock.timers.size,0);assert.equal(f.errors.length,0);f.clock.advance(999999);await f.polling.focus();assert.equal(f.expired(),1);f.polling.dispose();
});
test('stop and disposal invalidate late private responses and leave no timer',async()=>{
 const read=deferred<{revision:number}>(),f=fixture(()=>read.promise);f.polling.start();await flush();f.polling.stop();read.resolve({revision:1});await flush();assert.deepEqual(f.accepted,[]);assert.equal(f.clock.timers.size,0);f.polling.dispose();f.polling.start();await flush();assert.equal(f.polling.snapshot().running,false);
});
test('a read finishing during save is deferred and a timed-out read is retried after backoff',async()=>{
 const first=deferred<{revision:number}>();let calls=0;const f=fixture(()=>{calls++;if(calls===1)return first.promise;if(calls===2)return Promise.reject(new Error('deadline exceeded'));return Promise.resolve({revision:8});});
 f.polling.start();await flush();f.polling.setBusy(true);first.resolve({revision:2});await flush();assert.deepEqual(f.accepted,[]);assert.equal(f.polling.snapshot().pending,true);assert.equal(f.clock.timers.size,0);
 f.polling.observeRevision(7);f.polling.setBusy(false);await flush();assert.equal(calls,2);assert.equal(f.clock.delay(),30000);f.clock.advance(30000);await flush();assert.deepEqual(f.accepted,[8]);assert.equal(f.polling.snapshot().failures,0);f.polling.dispose();
});

test('a refresh failure during save waits for an immediate fresh read instead of surfacing a stale error',async()=>{
 const first=deferred<{revision:number}>();let calls=0;const f=fixture(()=>++calls===1?first.promise:Promise.resolve({revision:9}));
 f.polling.start();await flush();f.polling.setBusy(true);first.reject(new Error('stale read transport failed'));await flush();assert.equal(f.polling.snapshot().pending,true);assert.equal(f.polling.snapshot().failures,0);assert.equal(f.clock.timers.size,0);
 f.polling.observeRevision(8);f.polling.setBusy(false);await flush();assert.equal(calls,2);assert.deepEqual(f.accepted,[9]);assert.equal(f.polling.snapshot().pending,false);f.polling.dispose();
});
