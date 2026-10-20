import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {workspaceFixture} from './helpers/workspace.ts';
import {loadWorkspace} from '../lib/workspace-store.ts';
import {handleWorkspaceStream,readOwnerWorkspaceStreamNotice,registeredWorkspaceStreamCapability,workspaceStreamCursor,parseWorkspaceStreamCursor,type WorkspaceStreamCapability} from '../lib/workspace-stream.ts';
const now='2026-10-18T12:00:00.000Z',origin='https://synthetic.example.invalid',capability:WorkspaceStreamCapability={runtime:'cloudflare-workers',sourceCommit:'a'.repeat(40),verifiedAt:now,origin};
class Clock{now=Date.parse(now);next=0;timers=new Map<number,{at:number;fn:()=>void}>();set=(fn:()=>void,ms:number)=>{const id=++this.next;this.timers.set(id,{at:this.now+ms,fn});return id;};clear=(id:unknown)=>{this.timers.delete(id as number);};advance(ms:number){this.now+=ms;for(const [id,value] of [...this.timers])if(value.at<=this.now){this.timers.delete(id);value.fn();}}}
const request=(headers:Record<string,string>={})=>new Request(origin+'/api/workspace/events',{headers:{Origin:origin,Accept:'text/event-stream',...headers}});
const flush=async()=>{for(let i=0;i<80;i++)await Promise.resolve();};
test('unregistered production capability never streams, no owner read or request flag can grant capability',async()=>{
 assert.equal(await registeredWorkspaceStreamCapability(),null);let reads=0;
 const deps={capability:null,authorize:async()=>true,read:async()=>{reads++;return {workspaceRevision:1,operationalWatermarksHash:'a'.repeat(64)};}};
 assert.equal((await handleWorkspaceStream(request(),deps)).status,503);assert.equal(reads,0);
 assert.equal((await handleWorkspaceStream(new Request(origin+'/api/workspace/events?supported=true',{headers:{Origin:origin,Accept:'text/event-stream'}}),deps)).status,403);
 assert.equal((await handleWorkspaceStream(request(),{...deps,authorize:async()=>false})).status,401);
});
test('same-origin, closed cursor and protocol checks reject before owner metadata reads',async()=>{
 let reads=0;const deps={capability,authorize:async()=>true,read:async()=>{reads++;return {workspaceRevision:1,operationalWatermarksHash:'a'.repeat(64)};}};
 for(const req of [new Request(origin+'/api/workspace/events',{headers:{Accept:'text/event-stream'}}),request({Origin:'https://foreign.invalid'}),request({'sec-fetch-site':'cross-site'}),request({'Last-Event-ID':'w1.1.bad'}),request({Accept:'application/json'})])assert.ok((await handleWorkspaceStream(req,deps)).status>=400);
 assert.equal(reads,0);for(const value of ['w1.0.'+'a'.repeat(64),'w1.9007199254740992.'+'a'.repeat(64),'w1.1.'+'a'.repeat(64)+'\n','owner-a'])assert.throws(()=>parseWorkspaceStreamCursor(value));
});
test('actual SQLite owner boundaries stream only revision and operational digest, then terminate at20seconds',async()=>{
 const f=database(),clock=new Clock();try{for(const owner of ['a','b'])await loadWorkspace(f.db,owner,()=>workspaceFixture(),now);
 f.sqlite.prepare('INSERT INTO operational_stream_heads(user_id,stream_id,last_sequence,revision) VALUES(?,?,?,1)').run('b','sources',99);
 const notice=await readOwnerWorkspaceStreamNotice(f.db,'a');assert.equal(notice.workspaceRevision,1);assert.notEqual(notice.operationalWatermarksHash,(await readOwnerWorkspaceStreamNotice(f.db,'b')).operationalWatermarksHash);
 const response=await handleWorkspaceStream(request({'Last-Event-ID':workspaceStreamCursor(await readOwnerWorkspaceStreamNotice(f.db,'b'))}),{capability,authorize:async()=>true,read:()=>readOwnerWorkspaceStreamNotice(f.db,'a'),now:()=>clock.now,setTimer:clock.set,clearTimer:clock.clear});assert.equal(response.status,200);assert.match(response.headers.get('content-type')!,/text\/event-stream/);
 const reader=response.body!.getReader(),initial=new TextDecoder().decode((await reader.read()).value);assert.match(initial,/event: ready/);assert.ok(initial.includes(workspaceStreamCursor(notice)));assert.ok(!initial.includes('owner')&&!initial.includes('projects')&&!initial.includes('credential'));
 f.sqlite.prepare('UPDATE workspaces SET revision=revision+1 WHERE user_id=?').run('b');clock.advance(2000);await flush();
 f.sqlite.prepare('UPDATE workspaces SET revision=revision+1 WHERE user_id=?').run('a');clock.advance(2000);await flush();const changed=new TextDecoder().decode((await reader.read()).value);assert.match(changed,/event: workspace/);assert.match(changed,/"workspaceRevision":2/);
 f.sqlite.prepare('INSERT INTO operational_stream_heads(user_id,stream_id,last_sequence,revision) VALUES(?,?,?,1)').run('a','sources',1);clock.advance(2000);await flush();const operational=new TextDecoder().decode((await reader.read()).value);assert.match(operational,/"workspaceRevision":2/);assert.notEqual(operational,changed);
 clock.advance(14000);await flush();assert.equal((await reader.read()).done,true);assert.equal(clock.timers.size,0);reader.releaseLock();
 }finally{f.sqlite.close();}
});
test('abort and session expiry close streams with no later owner reads or retained timers',async()=>{
 for(const mode of ['abort','expire']){const clock=new Clock(),controller=new AbortController();let authorized=true,reads=0;const req=new Request(origin+'/api/workspace/events',{headers:{Origin:origin,Accept:'text/event-stream'},signal:controller.signal});const response=await handleWorkspaceStream(req,{capability,authorize:async()=>authorized,read:async()=>{reads++;return {workspaceRevision:1,operationalWatermarksHash:'a'.repeat(64)};},now:()=>clock.now,setTimer:clock.set,clearTimer:clock.clear});const reader=response.body!.getReader();await reader.read();if(mode==='abort')controller.abort();else{authorized=false;clock.advance(2000);await flush();assert.match(new TextDecoder().decode((await reader.read()).value),/session-expired/);}assert.equal((await reader.read()).done,true);assert.equal(reads,1);assert.equal(clock.timers.size,0);reader.releaseLock();}
});
test('hung authorization or initial metadata has a finite response deadline',async()=>{
 for(const phase of ['auth','read']){const clock=new Clock(),response=handleWorkspaceStream(request(),{capability,authorize:phase==='auth'?()=>new Promise<boolean>(()=>{}):async()=>true,read:()=>new Promise(()=>{}),now:()=>clock.now,setTimer:clock.set,clearTimer:clock.clear});await flush();clock.advance(phase==='auth'?5000:10000);await flush();assert.equal((await response).status,503);assert.equal(clock.timers.size,0);}
});

test('an authorization check settling after abort cannot start another owner read',async()=>{
 const clock=new Clock(),controller=new AbortController();let resolve!:(value:boolean)=>void,calls=0,reads=0;
 const response=await handleWorkspaceStream(new Request(origin+'/api/workspace/events',{headers:{Origin:origin,Accept:'text/event-stream'},signal:controller.signal}),{capability,authorize:async()=>{calls++;return calls===1?true:new Promise<boolean>(yes=>{resolve=yes;});},read:async()=>{reads++;return {workspaceRevision:1,operationalWatermarksHash:'a'.repeat(64)};},now:()=>clock.now,setTimer:clock.set,clearTimer:clock.clear});
 const reader=response.body!.getReader();await reader.read();clock.advance(2000);await flush();controller.abort();resolve(true);await flush();assert.equal(reads,1);assert.equal((await reader.read()).done,true);assert.equal(clock.timers.size,0);reader.releaseLock();
});
