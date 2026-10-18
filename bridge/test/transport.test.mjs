import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createBridgeTransport} from '../src/transport.mjs';
const ingressAdapter={async getHeaders(){return {headers:{'x-synthetic-private-service':'synthetic-only'},expiresAt:'2099-01-01T00:00:00Z'};}};
const session={bootId:'synthetic-boot',bridgeVersion:'0.1.0'};
test('unavailable private ingress stops before network; browser credentials and private identity headers are forbidden',async()=>{
  let calls=0;
  const t=createBridgeTransport({baseUrl:'https://private.example',fetchImpl:async()=>{calls++;}});
  await assert.rejects(t.enroll({secret:'synthetic',bridgeVersion:'0.1.0'}),/private_ingress_unavailable/);assert.equal(calls,0);
  for(const url of ['http://private.example','https://user:pass@private.example','https://private.example/path','https://private.example/?secret=x','https://private.example/#fragment'])assert.throws(()=>createBridgeTransport({baseUrl:url}));
  for(const headers of [{cookie:'synthetic'},{'oai-authenticated-user-id':'owner'},{'x-control-room-device':'override'},{host:'other.example'}]){
    await assert.rejects(createBridgeTransport({baseUrl:'https://private.example',ingressAdapter:{async getHeaders(){return {headers,expiresAt:'2099-01-01T00:00:00Z'};}}}).enroll({secret:'synthetic',bridgeVersion:'0.1.0'}),/unsafe_ingress_headers/);
  }
});
test('closed endpoints and bounded retries preserve the exact request body',async()=>{
  const seen=[],sleeps=[];
  const t=createBridgeTransport({baseUrl:'https://private.example',deviceCredential:'synthetic-device',ingressAdapter,random:()=>0,sleep:async ms=>sleeps.push(ms),fetchImpl:async(url,options)=>{
    seen.push({url,...options});
    return seen.length===1?new Response('',{status:500}):seen.length===2?new Response('',{status:429,headers:{'retry-after':'999999'}}):Response.json({ok:true});
  }});
  assert.deepEqual(await t.session(session),{ok:true});assert.equal(seen.length,3);assert.equal(new Set(seen.map(x=>x.body)).size,1);
  assert.ok(seen.every(x=>x.url==='https://private.example/api/bridge/session'&&x.credentials==='omit'&&x.redirect==='error'&&x.cache==='no-store'&&x.headers.get('x-control-room-device')==='synthetic-device'));
  assert.deepEqual(sleeps,[250,60000]);assert.deepEqual(Object.keys(t).sort(),['enroll','heartbeat','liveWindow','session']);
});
test('401 and 403 stop immediately; one-use enrollment is never retried after uncertainty',async()=>{
  for(const status of [401,403]){
    let calls=0;const t=createBridgeTransport({baseUrl:'https://private.example',deviceCredential:'synthetic',ingressAdapter,fetchImpl:async()=>{calls++;return new Response('',{status});}});
    await assert.rejects(t.session(session),error=>error.code==='authentication_stopped'&&error.status===status);assert.equal(calls,1);
  }
  let calls=0;
  await assert.rejects(createBridgeTransport({baseUrl:'https://private.example',ingressAdapter,fetchImpl:async()=>{calls++;throw new Error('private provider detail');}}).enroll({secret:'one-use-synthetic',bridgeVersion:'0.1.0'}),/network_uncertain/);
  assert.equal(calls,1);
});
test('network retries are bounded and do not disclose underlying errors',async()=>{
  let calls=0;const sleeps=[];
  const t=createBridgeTransport({baseUrl:'https://private.example',deviceCredential:'synthetic',ingressAdapter,sleep:async value=>sleeps.push(value),random:()=>0,fetchImpl:async()=>{calls++;throw new Error('sensitive adapter detail');}});
  await assert.rejects(t.session(session),error=>error.code==='network_uncertain'&&!error.message.includes('sensitive'));assert.equal(calls,3);assert.deepEqual(sleeps,[250,500]);
});
test('expired ingress and oversized or non-UTF8 cloud responses fail closed',async()=>{
  let calls=0;
  const expired=createBridgeTransport({baseUrl:'https://private.example',ingressAdapter:{async getHeaders(){return {headers:{'x-synthetic':'x'},expiresAt:'2000-01-01T00:00:00Z'};}},fetchImpl:async()=>{calls++;}});
  await assert.rejects(expired.enroll({secret:'synthetic',bridgeVersion:'0.1.0'}),/private_ingress_unavailable/);assert.equal(calls,0);
  for(const response of [new Response('x'.repeat(65537)),new Response(new Uint8Array([0xff]))]){
    const t=createBridgeTransport({baseUrl:'https://private.example',deviceCredential:'synthetic',ingressAdapter,fetchImpl:async()=>response});
    await assert.rejects(t.session(session),/response_too_large|invalid_response/);
  }
});
test('unknown body fields and invalid retry policy never reach cloud transport',async()=>{
  let calls=0;const t=createBridgeTransport({baseUrl:'https://private.example',deviceCredential:'synthetic',ingressAdapter,fetchImpl:async()=>{calls++;}});
  await assert.rejects(t.session({...session,ownerId:'injected'}),/invalid_request/);
  await assert.rejects(t.liveWindow({bootId:'boot',generation:1,sequence:1,command:'shell'}),/invalid_request/);assert.equal(calls,0);
  assert.throws(()=>createBridgeTransport({baseUrl:'https://private.example',maxAttempts:100}),/invalid_retry_limit/);
});

test('stalled private credential acquisition is bounded and its late completion cannot send a request',async context=>{
  context.mock.timers.enable({apis:['setTimeout']});
  let resolveHeaders,calls=0;
  const gate=new Promise(resolve=>{resolveHeaders=resolve;});
  const t=createBridgeTransport({baseUrl:'https://private.example',deviceCredential:'synthetic',ingressAdapter:{getHeaders:()=>gate},fetchImpl:async()=>{calls++;return Response.json({});}});
  try{
    const work=t.session(session);
    await Promise.resolve();
    context.mock.timers.tick(10000);
    await assert.rejects(work,/private_ingress_unavailable/);
    resolveHeaders({headers:{'x-synthetic':'late'},expiresAt:'2099-01-01T00:00:00Z'});
    await Promise.resolve();await Promise.resolve();
    assert.equal(calls,0);
  }finally{context.mock.timers.reset();}
});
