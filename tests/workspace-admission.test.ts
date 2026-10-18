import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceAdmission,WorkspaceAdmissionOverloadError} from '../lib/workspace-admission.ts';
import {database} from './helpers/sqlite.ts';
import {workspaceFixture} from './helpers/workspace.ts';
import {loadWorkspace,readCurrent} from '../lib/workspace-store.ts';
import {executeWorkspaceCommand} from '../lib/workspace-transaction.ts';
import {workspaceHandlers} from '../lib/workspace-handlers.ts';
import {issueMutationId} from '../lib/idempotency-retention.ts';
const now='2026-10-18T12:00:00.000Z';
function gate(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}
test('actual SQLite native commands serialize same-owner CAS while unrelated owner commits in parallel',async()=>{
 const f=database(),admission=new WorkspaceAdmission({maximumOwners:2,maximumWaitersPerOwner:12}),hold=gate(),started=gate();let cleanup:Promise<unknown>[]=[];
 try{
  for(const owner of ['a','b'])await loadWorkspace(f.db,owner,()=>workspaceFixture(),now);
  const commands=await Promise.all(Array.from({length:10},async(_,index)=>({protocolVersion:1 as const,expectedRevision:1,mutationId:await issueMutationId(f.db,'a',now),command:{type:'capture.create' as const,capture:{title:'Synthetic admission '+index,body:'Bounded native concurrency fixture',projectId:null,kind:'idea' as const,sourceUrl:null}}})));
  const pending=commands.map((input,index)=>admission.run('a',async()=>{if(index===0){started.release();await hold.promise;}return executeWorkspaceCommand('a',input,{db:f.db,handlers:workspaceHandlers,now:()=>now});}));
  cleanup=pending;
  await started.promise;assert.deepEqual(admission.snapshot(),{owners:1,active:1,waiting:9});
  const bInput={...commands[0],mutationId:await issueMutationId(f.db,'b',now),command:{...commands[0].command,capture:{...commands[0].command.capture,title:'Independent owner b'}}};
  const b=await admission.run('b',()=>executeWorkspaceCommand('b',bInput,{db:f.db,handlers:workspaceHandlers,now:()=>now}));assert.equal(b.status,'committed');
  assert.equal((await readCurrent(f.db,'a',now)).revision,1);assert.equal((await readCurrent(f.db,'b',now)).revision,2);
  hold.release();const result=await Promise.all(pending);assert.equal(result[0].status,'committed');assert.equal(result.filter(row=>row.status==='conflict').length,9);
  const current=await readCurrent(f.db,'a',now);assert.equal(current.revision,2);assert.deepEqual(current.workspace.captures.map(row=>row.title),['Synthetic admission 0']);
  const audit=f.sqlite.prepare('SELECT COUNT(*) n FROM audit_events WHERE user_id=?').get('a')!.n;
  const replay=await admission.run('a',()=>executeWorkspaceCommand('a',commands[0],{db:f.db,handlers:workspaceHandlers,now:()=>now}));assert.equal(replay.status,'replayed');assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM audit_events WHERE user_id=?').get('a')!.n,audit);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_mutations WHERE user_id=?').get('a')!.n,1);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_mutations WHERE user_id=?').get('b')!.n,1);
  await Promise.resolve();assert.deepEqual(admission.snapshot(),{owners:0,active:0,waiting:0});
 }finally{hold.release();await Promise.allSettled(cleanup);f.sqlite.close();}
});
test('FIFO survives failure and drops all owner/work state after settling',async()=>{
 const admission=new WorkspaceAdmission(),hold=gate(),order:number[]=[];
 const first=admission.run('owner',async()=>{order.push(1);await hold.promise;throw new Error('Synthetic operation failed');});
 const second=admission.run('owner',async()=>{order.push(2);return {value:2};}),third=admission.run('owner',async()=>{order.push(3);return {value:3};});
 const failed=assert.rejects(first,/Synthetic operation failed/);hold.release();await failed;const [two,three]=await Promise.all([second,third]);assert.deepEqual(order,[1,2,3]);assert.notEqual(two,three);await Promise.resolve();assert.deepEqual(admission.snapshot(),{owners:0,active:0,waiting:0});
});
test('owner/waiter limits reject before work and retain unrelated admitted operations',async()=>{
 const admission=new WorkspaceAdmission({maximumOwners:2,maximumWaitersPerOwner:1,maximumWaiters:1}),hold=gate();let calls=0;
 const a=admission.run('a',()=>hold.promise),b=admission.run('b',()=>hold.promise),queued=admission.run('a',async()=>{calls++;});
 const rejects=(reason:string)=>(error:unknown)=>error instanceof WorkspaceAdmissionOverloadError&&error.temporary&&error.code==='workspace_admission_busy'&&error.reason===reason;
 await assert.rejects(admission.run('c',async()=>{calls++;}),rejects('owner_capacity'));
 await assert.rejects(admission.run('a',async()=>{calls++;}),error=>error instanceof WorkspaceAdmissionOverloadError&&error.reason==='owner_waiters');
 await assert.rejects(admission.run('b',async()=>{calls++;}),error=>error instanceof WorkspaceAdmissionOverloadError&&error.reason==='global_waiters');
 assert.equal(calls,0);hold.release();await Promise.all([a,b,queued]);assert.equal(calls,1);await Promise.resolve();assert.deepEqual(admission.snapshot(),{owners:0,active:0,waiting:0});
});
test('queued abort and real bounded deadline never invoke work; active abort never releases its slot early',async()=>{
 const admission=new WorkspaceAdmission({waitMilliseconds:10}),hold=gate(),activeSignal=new AbortController(),queuedSignal=new AbortController();let invoked=0;
 const active=admission.run('owner',()=>hold.promise,{signal:activeSignal.signal});
 const queued=admission.run('owner',async()=>{invoked++;},{signal:queuedSignal.signal}),cancelled=assert.rejects(queued,error=>error instanceof WorkspaceAdmissionOverloadError&&error.reason==='aborted');queuedSignal.abort();await cancelled;
 activeSignal.abort();assert.deepEqual(admission.snapshot(),{owners:1,active:1,waiting:0});
 await assert.rejects(admission.run('owner',async()=>{invoked++;}),error=>error instanceof WorkspaceAdmissionOverloadError&&error.reason==='wait_timeout');
 assert.equal(invoked,0);assert.deepEqual(admission.snapshot(),{owners:1,active:1,waiting:0});hold.release();await active;await Promise.resolve();assert.deepEqual(admission.snapshot(),{owners:0,active:0,waiting:0});
});
