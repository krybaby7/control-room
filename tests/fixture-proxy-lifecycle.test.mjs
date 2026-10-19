import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
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
