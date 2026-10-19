import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {Writable,PassThrough} from 'node:stream';
import {fixtureProxy,FIXTURE_REQUEST_TIMEOUT_MS} from '../scripts/test-worker.mjs';

// These ports are the fixed synthetic harness boundary, so lifecycle cases run serially.
test('proxy distinguishes pre-header deadline and aborts truncated bodies without replay',async()=>{
 const counts=new Map();
 const closed=new Set();
 const upstream=http.createServer((request,response)=>{
  const path=request.url;counts.set(path,(counts.get(path)??0)+1);
  response.on('close',()=>closed.add(path));
  if(path==='/partial'){response.writeHead(200,{'Content-Type':'text/plain'});response.write('synthetic partial');}
  if(path==='/transport-error')response.destroy();
  if(path==='/complete')response.end('synthetic complete');
 });
 const proxy=fixtureProxy({requestTimeoutMs:100});
 await new Promise(resolve=>upstream.listen(4174,'127.0.0.1',resolve));
 await new Promise(resolve=>proxy.listen(4173,'127.0.0.1',resolve));
 try{
  const noHeaders=await fetch('http://127.0.0.1:4173/no-headers');
  assert.equal(noHeaders.status,502);
  assert.deepEqual(await noHeaders.json(),{error:'Synthetic fixture upstream failed.',stage:'headers',cause:'deadline'});
  const partial=await fetch('http://127.0.0.1:4173/partial');
  assert.equal(partial.status,200);
  // Before the fix this resolves to "synthetic partial": a timeout certified as success.
  await assert.rejects(partial.text());
  const transport=await fetch('http://127.0.0.1:4173/transport-error');
  assert.equal(transport.status,502);
  assert.deepEqual(await transport.json(),{error:'Synthetic fixture upstream failed.',stage:'headers',cause:'transport'});
  const complete=await fetch('http://127.0.0.1:4173/complete');
  assert.equal(await complete.text(),'synthetic complete');
  assert.deepEqual([...counts],[['/no-headers',1],['/partial',1],['/transport-error',1],['/complete',1]]);
  assert.ok(closed.has('/no-headers'));assert.ok(closed.has('/partial'));
  assert.equal(FIXTURE_REQUEST_TIMEOUT_MS,15_000);
 }finally{
  proxy.closeAllConnections();upstream.closeAllConnections();
  await Promise.all([new Promise(resolve=>proxy.close(()=>resolve())),new Promise(resolve=>upstream.close(()=>resolve()))]);
 }
});

function proxyRequest(path,{agent=false,headers={}}={}){
 return new Promise((resolve,reject)=>{
  const request=http.request('http://127.0.0.1:4173'+path,{agent,headers},response=>{
   const port=response.socket.localPort,chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('error',reject);response.on('end',()=>resolve({status:response.statusCode,headers:response.headers,body:Buffer.concat(chunks).toString(),port}));
  });request.on('error',reject);request.setTimeout(2000,()=>request.destroy(new Error('Synthetic downstream client timed out.')));request.end();
 });
}
// This reproduces shared-pool starvation as a class. It does not establish the
// cause of the historical canonical browser request's pre-header timeout.
test('proxy upstream sockets are independent of an occupied shared global pool and downstream keepalive',async()=>{
 const originalAgent=http.globalAgent,shared=new http.Agent({keepAlive:true,maxSockets:1}),downstream=new http.Agent({keepAlive:true,maxSockets:1});
 let unblock;const occupied=new Promise(resolve=>{unblock=resolve;});const seen=[],overlap=[];
 const upstream=http.createServer((request,response)=>{
  if(request.url==='/pool-blocker'){unblock();return;}
  seen.push({url:request.url,port:request.socket.remotePort,connection:request.headers.connection});
  const reply=()=>response.writeHead(200,{'Content-Type':'application/json'}).end('{"synthetic":true}');
  if(request.url.startsWith('/api/jobs?')){overlap.push(reply);if(overlap.length===2)for(const done of overlap)done();}else reply();
 });
 const proxy=fixtureProxy({requestTimeoutMs:500});let blocker;
 await new Promise(resolve=>upstream.listen(4174,'127.0.0.1',resolve));await new Promise(resolve=>proxy.listen(4173,'127.0.0.1',resolve));
 try{
  http.globalAgent=shared;blocker=http.request('http://127.0.0.1:4174/pool-blocker',{agent:shared});blocker.on('error',()=>{});blocker.end();await occupied;
  const ports=[];for(const path of ['/serial/one','/serial/two','/serial/three']){const response=await proxyRequest(path,{agent:downstream});assert.equal(response.status,200);assert.equal(response.body,'{"synthetic":true}');assert.notEqual(response.headers.connection,'close');ports.push(response.port);}
  assert.equal(new Set(ports).size,1,'upstream Connection:close must not close the independent browser-side connection');
  const responses=await Promise.all([proxyRequest('/api/jobs?client=ui'),proxyRequest('/api/jobs?client=api')]);assert.deepEqual(responses.map(response=>response.status),[200,200]);
  assert.equal(overlap.length,2);assert.equal(seen.length,5,'there is exactly one upstream request for each client request');assert.equal(new Set(seen.map(row=>row.port)).size,5,'each upstream hop uses its own TCP connection');assert.ok(seen.every(row=>row.connection==='close'));
  assert.equal(Object.values(shared.sockets).flat().length,1,'the unrelated global-pool socket remains occupied');assert.equal(FIXTURE_REQUEST_TIMEOUT_MS,15000);
 }finally{
  http.globalAgent=originalAgent;blocker?.destroy();shared.destroy();downstream.destroy();proxy.closeAllConnections();upstream.closeAllConnections();
  await Promise.all([new Promise(resolve=>proxy.close(()=>resolve())),new Promise(resolve=>upstream.close(()=>resolve()))]);
 }
});

test('proxy strips nominated hop headers both ways while preserving synthetic identity and rejecting foreign origins',async()=>{
 const seen=[];
 const upstream=http.createServer((request,response)=>{
  seen.push(request.headers);
  if(request.url==='/mutation'&&request.headers.origin!=='http://127.0.0.1:4174'){response.writeHead(403).end('synthetic origin rejected');return;}
  response.writeHead(200,{Connection:'close, X-Upstream-Hop','X-Upstream-Hop':'must-not-cross','Keep-Alive':'timeout=999','Proxy-Authenticate':'synthetic','X-End-To-End':'preserved',Location:'http://127.0.0.1:4174/synthetic-location','Content-Type':'text/plain','Content-Length':Buffer.byteLength('synthetic body'),'Content-Encoding':'identity'}).end('synthetic body');
 });const proxy=fixtureProxy();
 await new Promise(resolve=>upstream.listen(4174,'127.0.0.1',resolve));await new Promise(resolve=>proxy.listen(4173,'127.0.0.1',resolve));
 try{
  const response=await proxyRequest('/headers',{headers:{Connection:'keep-alive, X-Client-Hop, OAI-Authenticated-User-ID','X-Client-Hop':'must-not-cross','Proxy-Authorization':'synthetic','Keep-Alive':'timeout=999',TE:'trailers',Trailer:'X-Trailer','Transfer-Encoding':'chunked',Upgrade:'synthetic',cookie:'fixture_session=a',Origin:'http://127.0.0.1:4173','oai-authenticated-user-id':'spoofed','oai-authenticated-user-email':'spoofed@example.invalid','X-End-To-End':'preserved'}});
  assert.equal(response.status,200);assert.equal(response.body,'synthetic body');assert.equal(response.headers['x-upstream-hop'],undefined);assert.equal(response.headers['proxy-authenticate'],undefined);assert.notEqual(response.headers['keep-alive'],'timeout=999');assert.equal(response.headers['x-end-to-end'],'preserved');assert.equal(response.headers.location,'http://127.0.0.1:4173/synthetic-location');assert.equal(response.headers['content-type'],'text/plain');assert.equal(response.headers['content-length'],String(Buffer.byteLength('synthetic body')));assert.equal(response.headers['content-encoding'],'identity');
  assert.equal(seen[0]['x-client-hop'],undefined);assert.equal(seen[0]['proxy-authorization'],undefined);assert.equal(seen[0]['keep-alive'],undefined);assert.equal(seen[0].te,undefined);assert.equal(seen[0].trailer,undefined);assert.equal(seen[0].upgrade,undefined);assert.equal(seen[0].connection,'close');assert.equal(seen[0].host,'127.0.0.1:4174');assert.equal(seen[0].cookie,'fixture_session=a');assert.equal(seen[0].origin,'http://127.0.0.1:4174');assert.equal(seen[0]['x-end-to-end'],'preserved');assert.equal(seen[0]['oai-authenticated-user-id'],'synthetic-a');assert.equal(seen[0]['oai-authenticated-user-email'],'synthetic-a@example.invalid');
  for(const headers of [{Origin:'https://foreign.invalid'},{},{Origin:'https://foreign.invalid',Connection:'keep-alive, Origin'}])assert.equal((await proxyRequest('/mutation',{headers})).status,403);
 }finally{proxy.closeAllConnections();upstream.closeAllConnections();await Promise.all([new Promise(resolve=>proxy.close(()=>resolve())),new Promise(resolve=>upstream.close(()=>resolve()))]);}
});

test('proxy deadline responds for a queued request without socket or immediate error and ignores late headers and duplicate errors',async()=>{
 const originalRequest=http.request;let pending,onIncoming,calls=0,writes=0,finishes=0;
 class QueuedRequest extends Writable{
  constructor(){super({autoDestroy:false});this.destroyCalls=0;}
  _write(_chunk,_encoding,done){done();}
  setTimeout(){return this;}
  // Match ClientRequest's queued/no-socket behavior: destruction cannot yet
  // report its error through an assigned socket.
  destroy(){this.destroyCalls++;return this;}
 }
 const proxy=fixtureProxy({requestTimeoutMs:80});
 proxy.on('request',(_request,response)=>{const original=response.writeHead;response.writeHead=function(...args){writes++;return original.apply(this,args);};response.on('finish',()=>finishes++);});
 await new Promise(resolve=>proxy.listen(4173,'127.0.0.1',resolve));
 try{
  http.request=function(url,...args){if(url instanceof URL&&url.origin==='http://127.0.0.1:4174'){calls++;onIncoming=args.at(-1);pending=new QueuedRequest();return pending;}return originalRequest.call(this,url,...args);};
  const response=await fetch('http://127.0.0.1:4173/queued',{signal:AbortSignal.timeout(1000)});
  assert.equal(response.status,502);assert.deepEqual(await response.json(),{error:'Synthetic fixture upstream failed.',stage:'headers',cause:'deadline'});assert.ok(pending.destroyCalls>=1);assert.equal(calls,1);assert.equal(writes,1);assert.equal(finishes,1);
  const lateIncoming=new PassThrough();lateIncoming.headers={'content-type':'text/plain'};lateIncoming.statusCode=200;onIncoming(lateIncoming);assert.equal(lateIncoming.destroyed,true,'late success headers must be discarded after the deadline response');
  pending.emit('error',new Error('synthetic late queued error'));pending.emit('error',new Error('synthetic duplicate error'));assert.equal(writes,1);assert.equal(finishes,1);
 }finally{http.request=originalRequest;proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));}
});
