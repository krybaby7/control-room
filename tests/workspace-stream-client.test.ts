import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceStreamClient,consumeWorkspaceStream,type WorkspaceStreamStatus} from '../lib/workspace-stream-client.ts';
import {workspaceStreamCursor,type WorkspaceStreamNotice} from '../lib/workspace-stream-codec.ts';
class Clock{now=0;next=0;timers=new Map<number,{at:number;fn:()=>void}>();set=(fn:()=>void,ms:number)=>{const id=++this.next;this.timers.set(id,{at:this.now+ms,fn});return id;};clear=(id:unknown)=>{this.timers.delete(id as number);};advance(ms:number){this.now+=ms;for(const [id,value] of [...this.timers])if(value.at<=this.now){this.timers.delete(id);value.fn();}}}
const notice=(revision=1,hash='a'):WorkspaceStreamNotice=>({workspaceRevision:revision,operationalWatermarksHash:hash.repeat(64)}),frame=(value=notice(),type='ready')=>'id: '+workspaceStreamCursor(value)+'\nevent: '+type+'\ndata: '+JSON.stringify(value)+'\n\n';
const response=(text:string)=>new Response(text,{headers:{'Content-Type':'text/event-stream; charset=utf-8'}});
const flush=async()=>{for(let i=0;i<80;i++)await Promise.resolve();};
test('stream reader enforces exact cursor/body/hash, duplicate fields, UTF8 and finite bytes',async()=>{
 const accepted:WorkspaceStreamNotice[]=[];await consumeWorkspaceStream(response(frame()),new AbortController().signal,event=>{if(event.type==='ready')accepted.push(event.notice);});assert.deepEqual(accepted,[notice()]);
 for(const text of [frame().replace('event: ready','event: ready\nevent: workspace'),frame().replace('w1.1.','w1.2.'),frame().replace('"workspaceRevision":1','"workspaceRevision":1,"ownerId":"forged"'),frame().replace('\n\n',''),frame()+':'+ 'x'.repeat(65536),frame().replace('event: ready','event: owner-command')])await assert.rejects(consumeWorkspaceStream(response(text),new AbortController().signal,()=>{}));
 await assert.rejects(consumeWorkspaceStream(new Response(Uint8Array.of(0xff),{headers:{'Content-Type':'text/event-stream'}}),new AbortController().signal,()=>{}));
});
test('default unverified transport performs zero reads and labels polling honestly',async()=>{
 let calls=0;const client=new WorkspaceStreamClient({fetch:async()=>{calls++;return response(frame());},onNotice:()=>assert.fail('No notice expected'),onExpire:()=>assert.fail('No expiry expected')});client.start();await flush();assert.equal(calls,0);assert.equal(client.snapshot().status,'polling-unverified');client.dispose();
});
test('bounded stream reconnect retains exact cursor; notices queue while editor/save is busy and never apply workspace data',async()=>{
 const clock=new Clock(),hints:WorkspaceStreamNotice[]=[],statuses:WorkspaceStreamStatus[]=[],requests:Array<RequestInit|undefined>=[];let active!:ReadableStreamDefaultController<Uint8Array>;let number=0;
 const client=new WorkspaceStreamClient({enabled:true,fetch:async(_url,init)=>{requests.push(init);number++;const stream=new ReadableStream<Uint8Array>({start(controller){active=controller;controller.enqueue(new TextEncoder().encode(frame(number===1?notice():notice(2,'b'))));}});return new Response(stream,{headers:{'Content-Type':'text/event-stream'}});},onNotice:value=>hints.push(value),onExpire:()=>assert.fail('No expiry'),onStatus:value=>statuses.push(value),now:()=>clock.now,setTimer:clock.set,clearTimer:clock.clear});
 client.setBusy(true);client.start();await flush();assert.equal(hints.length,0);assert.equal(client.snapshot().status,'streaming');client.setBusy(false);assert.deepEqual(hints,[notice()]);assert.equal(requests[0]?.credentials,'same-origin');assert.equal(requests[0]?.mode,'same-origin');
 clock.advance(20000);active.close();await flush();clock.advance(1000);await flush();assert.equal(requests.length,2);assert.equal((requests[1]!.headers as Record<string,string>)['Last-Event-ID'],workspaceStreamCursor(notice()));assert.deepEqual(hints,[notice(),notice(2,'b')]);client.setSignedIn(false);await flush();assert.equal(client.snapshot().cursor,null);assert.equal(clock.timers.size,0);assert.equal(client.snapshot().status,'expired');assert.ok(statuses.includes('streaming'));client.dispose();
});
test('unverified server/failed transport switches to polling fallback without repeated stream requests',async()=>{
 for(const status of [503,500]){let calls=0;const client=new WorkspaceStreamClient({enabled:true,fetch:async()=>{calls++;return new Response('{}',{status});},onNotice:()=>assert.fail('No notice'),onExpire:()=>assert.fail('No expiry')});client.start();await flush();assert.equal(calls,1);assert.equal(client.snapshot().status,'polling-fallback');assert.equal(client.snapshot().running,false);client.dispose();}
});
test('session expiry redacts cursor and aborts immediately; late prior-session frames cannot notify',async()=>{
 const clock=new Clock();let resolve!:(response:Response)=>void,expired=0,hints=0;const pending=new Promise<Response>(yes=>{resolve=yes;}),client=new WorkspaceStreamClient({enabled:true,fetch:()=>pending,onNotice:()=>hints++,onExpire:()=>expired++,setTimer:clock.set,clearTimer:clock.clear});
 client.start();await flush();client.setSignedIn(false);resolve(response(frame(notice(99))));await flush();assert.equal(hints,0);assert.equal(client.snapshot().cursor,null);assert.equal(clock.timers.size,0);client.dispose();
 const unauthorized=new WorkspaceStreamClient({enabled:true,fetch:async()=>new Response('{}',{status:401}),onNotice:()=>hints++,onExpire:()=>expired++});unauthorized.start();await flush();assert.equal(expired,1);assert.equal(unauthorized.snapshot().status,'expired');unauthorized.dispose();
});
test('hung fetch respecting no abort still reaches finite fallback and leaves no timer',async()=>{
 const clock=new Clock(),client=new WorkspaceStreamClient({enabled:true,fetch:()=>new Promise(()=>{}),onNotice:()=>assert.fail('No notice'),onExpire:()=>assert.fail('No expiry'),setTimer:clock.set,clearTimer:clock.clear});client.start();await flush();clock.advance(25000);await flush();assert.equal(client.snapshot().status,'polling-fallback');assert.equal(clock.timers.size,0);client.dispose();
});
test('three immediately closing streams stop reconnect storms and retain polling fallback',async()=>{
 const clock=new Clock();let calls=0;const client=new WorkspaceStreamClient({enabled:true,fetch:async()=>{calls++;return response(frame());},onNotice:()=>{},onExpire:()=>assert.fail('No expiry'),setTimer:clock.set,clearTimer:clock.clear,now:()=>clock.now});client.start();await flush();for(let i=0;i<2;i++){clock.advance(1000);await flush();}assert.equal(calls,3);assert.equal(client.snapshot().status,'polling-fallback');assert.equal(clock.timers.size,0);client.dispose();
});
