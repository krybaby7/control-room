import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type Server} from 'node:http';
import {once} from 'node:events';
import {database} from './helpers/sqlite.ts';
import {workspaceFixture} from './helpers/workspace.ts';
import {loadWorkspace} from '../lib/workspace-store.ts';
import {handleWorkspaceStream,readOwnerWorkspaceStreamNotice,workspaceStreamCursor} from '../lib/workspace-stream.ts';
const now='2026-10-18T12:00:00.000Z';
async function close(server:Server){server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
test('actual isolated native HTTP delivers SSE incrementally and reconnects with exact owner cursor, not a buffered JSON replacement',async()=>{
 const f=database();for(const owner of ['synthetic-a','synthetic-b'])await loadWorkspace(f.db,owner,()=>workspaceFixture(),now);
 let origin='',accepted=0;const timers=new Map<number,()=>void>();let serial=0;
 const server=createServer(async(incoming,outgoing)=>{
  const abort=new AbortController();outgoing.once('close',()=>abort.abort());
  // Synthetic test ingress only. This is not the production private-Site authentication adapter.
  const owner=incoming.headers.cookie==='synthetic_session=a'?'synthetic-a':incoming.headers.cookie==='synthetic_session=b'?'synthetic-b':null;
  const headers=new Headers();for(const [key,value] of Object.entries(incoming.headers))if(typeof value==='string')headers.set(key,value);
  const request=new Request(origin+(incoming.url??'/'),{method:'GET',headers,signal:abort.signal});
  try{const result=await handleWorkspaceStream(request,{capability:{runtime:'cloudflare-workers',sourceCommit:'a'.repeat(40),verifiedAt:now,origin},authorize:async()=>owner!==null,read:()=>{accepted++;return readOwnerWorkspaceStreamNotice(f.db,owner!);},now:()=>Date.parse(now),setTimer:callback=>{const id=++serial;timers.set(id,callback);return id;},clearTimer:id=>{timers.delete(id as number);}});
   outgoing.writeHead(result.status,Object.fromEntries(result.headers));outgoing.flushHeaders();if(!result.body){outgoing.end();return;}const reader=result.body.getReader();try{for(;;){const {done,value}=await reader.read();if(done)break;outgoing.write(value);}}finally{reader.releaseLock();}outgoing.end();
  }catch{if(!outgoing.headersSent)outgoing.writeHead(503);outgoing.end();}
 });server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');origin='http://127.0.0.1:'+address.port;
 try{
  const denied=await fetch(origin+'/api/workspace/events',{headers:{Origin:origin,Accept:'text/event-stream'}});assert.equal(denied.status,401);await denied.text();assert.equal(accepted,0);
  const controller=new AbortController(),response=await fetch(origin+'/api/workspace/events',{headers:{Origin:origin,Accept:'text/event-stream',Cookie:'synthetic_session=a'},signal:controller.signal});assert.equal(response.status,200);assert.match(response.headers.get('content-type')!,/text\/event-stream/);const reader=response.body!.getReader(),initial=new TextDecoder().decode((await reader.read()).value),cursor=workspaceStreamCursor(await readOwnerWorkspaceStreamNotice(f.db,'synthetic-a'));assert.ok(initial.includes('id: '+cursor));assert.match(initial,/event: ready/);
  f.sqlite.prepare('UPDATE workspaces SET revision=revision+1 WHERE user_id=?').run('synthetic-a');
  // Drive only the injected fixture poll callback; bytes still traverse the actual HTTP socket.
  const poll=[...timers].at(-1)!;timers.delete(poll[0]);poll[1]();const event=new TextDecoder().decode((await reader.read()).value);assert.match(event,/event: workspace/);assert.match(event,/"workspaceRevision":2/);controller.abort();await reader.cancel().catch(()=>{});reader.releaseLock();
  const reconnectController=new AbortController(),reconnected=await fetch(origin+'/api/workspace/events',{headers:{Origin:origin,Accept:'text/event-stream',Cookie:'synthetic_session=b','Last-Event-ID':cursor},signal:reconnectController.signal});const next=reconnected.body!.getReader(),foreign=new TextDecoder().decode((await next.read()).value);assert.match(foreign,/"workspaceRevision":1/);assert.ok(!foreign.includes('synthetic-a'));reconnectController.abort();await next.cancel().catch(()=>{});next.releaseLock();
 }finally{await close(server);f.sqlite.close();}
});
