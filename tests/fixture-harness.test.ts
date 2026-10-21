import {isAbsolute,join} from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {parseFixtureArgs,fixtureConfig,fixtureEnvironment,SYNTHETIC_DB_ID,FIXTURE_ORIGIN} from '../scripts/test-fixtures.mjs';
import {fixtureProxy,requireFreePort,assertFixtureStatus,fixtureFailure,fixtureFetch,FIXTURE_REQUEST_TIMEOUT_MS} from '../scripts/test-worker.mjs';
const source={main:'index.js',assets:{directory:'../client'},compatibility_date:'2026-05-15',d1_databases:[{binding:'DB',database_id:SYNTHETIC_DB_ID}],r2_buckets:[]};
test('harness accepts only explicit local fixture flags and rejects deployment bindings',()=>{
 assert.deepEqual(parseFixtureArgs(['--target','local-fixture']),{serve:false,withR2:false});assert.equal(parseFixtureArgs(['--target','local-fixture','--serve']).serve,true);
 for(const args of [[],['--target','production'],['--target','local-fixture','--remote'],['--target','local-fixture','--port','80']])assert.throws(()=>parseFixtureArgs(args));
 for(const unsafe of [{...source,d1_databases:[{database_id:'real-owner-id'}]},{...source,d1_databases:[{database_id:SYNTHETIC_DB_ID,remote:true}]},{...source,r2_buckets:[{binding:'BUCKET'}]},{...source,services:[{}]},{...source,main:'https://foreign.invalid/worker.js'}])assert.throws(()=>fixtureConfig(unsafe));
 const config=fixtureConfig(source);assert.equal(config.d1_databases[0].database_id,SYNTHETIC_DB_ID);assert.equal(config.dev.ip,'127.0.0.1');assert.ok(isAbsolute(config.main));assert.ok(isAbsolute(config.assets.directory));assert.equal('r2_buckets' in config,false);const env=fixtureEnvironment('/tmp/synthetic-fixture');assert.equal('CLOUDFLARE_API_TOKEN' in env,false);assert.equal('HOME' in env,false);assert.equal(env.XDG_CONFIG_HOME,join('/tmp/synthetic-fixture','config'));
});
test('occupied ports fail closed',async()=>{const server=http.createServer();await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));try{const address=server.address();assert.ok(address&&typeof address==='object');await assert.rejects(requireFreePort(address.port),/occupied/);}finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}});
test('proxy supplies only synthetic session headers and preserves foreign origin rejection',async()=>{
 const seen:Array<{headers:http.IncomingHttpHeaders;url:string|undefined}>=[];const upstream=http.createServer((request,response)=>{seen.push({headers:request.headers,url:request.url});response.writeHead(200,{'Content-Type':'application/json'}).end('{}');});const proxy=fixtureProxy();
 await new Promise<void>(resolve=>upstream.listen(4174,'127.0.0.1',resolve));await new Promise<void>(resolve=>proxy.listen(4173,'127.0.0.1',resolve));
 try{
  assert.equal((await fetch(`${FIXTURE_ORIGIN}/__test/session?owner=real-owner`,{method:'POST',headers:{origin:FIXTURE_ORIGIN}})).status,403);
  const session=await fetch(`${FIXTURE_ORIGIN}/__test/session?owner=a`,{method:'POST',headers:{origin:FIXTURE_ORIGIN}});assert.equal(session.status,204);assert.match(session.headers.get('set-cookie')??'',/HttpOnly; SameSite=Strict/);
  await fetch(`${FIXTURE_ORIGIN}/api/workspace`,{headers:{cookie:'fixture_session=a',origin:FIXTURE_ORIGIN,'oai-authenticated-user-id':'real-owner','oai-authenticated-user-email':'real@example.com'}});assert.equal(seen[0].headers['oai-authenticated-user-id'],'synthetic-a');assert.equal(seen[0].headers.origin,'http://127.0.0.1:4174');
  await fetch(`${FIXTURE_ORIGIN}/api/workspace`,{headers:{cookie:'fixture_session=expired',origin:'https://foreign.invalid','oai-authenticated-user-id':'spoofed'}});assert.equal(seen[1].headers['oai-authenticated-user-id'],undefined);assert.equal(seen[1].headers.origin,'https://foreign.invalid');
 }finally{proxy.closeAllConnections();upstream.closeAllConnections();await Promise.all([new Promise<void>(resolve=>proxy.close(()=>resolve())),new Promise<void>(resolve=>upstream.close(()=>resolve()))]);}
});

test('R2 option is explicit and only adds an isolated synthetic local binding',()=>{
 assert.deepEqual(parseFixtureArgs(['--target','local-fixture','--with-r2']),{serve:false,withR2:true});
 assert.deepEqual(parseFixtureArgs(['--target','local-fixture','--serve','--with-r2']),{serve:true,withR2:true});
 for(const args of [['--with-r2'],['--target','production','--with-r2'],['--target','local-fixture','--with-r2','--with-r2'],['--target','local-fixture','--with-r2','--remote']])assert.throws(()=>parseFixtureArgs(args));
 const plain=fixtureConfig(source),enabled=fixtureConfig(source,{withR2:true});
 assert.deepEqual(enabled.r2_buckets,[{binding:'BUCKET',bucket_name:'control-room-synthetic-local-attachments',remote:false}]);
 const {r2_buckets,...rest}=enabled;void r2_buckets;assert.deepEqual(rest,plain);assert.equal(source.r2_buckets.length,0);
 assert.throws(()=>fixtureConfig({...source,r2_buckets:[{binding:'BUCKET',bucket_name:'production'}]},{withR2:true}));
 // @ts-expect-error runtime rejects untyped CLI/config callers too
 assert.throws(()=>fixtureConfig(source,{withR2:'yes'}));
});

test('HTTP fixture status failures identify exact step and body without consuming response',async()=>{
 const response=new Response('{"error":"This attachment is unavailable."}',{status:503});
 await assert.rejects(assertFixtureStatus(response,404,'GET staged attachment before finalization (owner A)'),error=>{
  assert.ok(error instanceof Error);assert.match(error.message,/GET staged attachment before finalization \(owner A\)/);assert.match(error.message,/expected HTTP 404, received 503/);assert.match(error.message,/This attachment is unavailable/);return true;
 });
 assert.equal(await response.text(),'{"error":"This attachment is unavailable."}');
 await assertFixtureStatus(new Response(null,{status:404}),404,'expected not found');
 const large=new Response('x'.repeat(5000),{status:503});await assert.rejects(assertFixtureStatus(large,404,'bounded'),error=>{assert.ok(error instanceof Error);assert.ok(error.message.length<4400);return true;});
});

test('fixture smoke failure retains exact step and bounded Worker restart diagnostics',()=>{
 const original=new Error('PUT owner A reserved attachment as owner B: expected HTTP 404, received 503; response body: Your worker restarted mid-request.');
 const failure=fixtureFailure(original,'discarded prefix '+'.'.repeat(13000)+'[wrangler:debug] bundle update/restart');
 assert.equal(failure.cause,original);assert.ok(failure.message.startsWith(original.message));assert.match(failure.message,/Synthetic local Worker logs/);assert.match(failure.message,/bundle update\/restart/);assert.ok(!failure.message.includes('discarded prefix'));assert.ok(failure.message.length<original.message.length+12100);
 assert.match(fixtureFailure(original,'').message,/no Worker output captured/);
});

test('fixture deadline covers a hung POST response body without retrying the request',async()=>{
 let requests=0;const server=http.createServer((request,response)=>{requests++;request.resume();response.writeHead(200,{'Content-Type':'application/json'});response.write('{"partial":');});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));try{const address=server.address();assert.ok(address&&typeof address==='object');const response=await fixtureFetch(`http://127.0.0.1:${address.port}/synthetic-hung`,{method:'POST',body:'synthetic'},80);assert.equal(response.status,200);await assert.rejects(response.json(),error=>error instanceof Error&&['AbortError','TimeoutError'].includes(error.name));assert.equal(requests,1);assert.equal(FIXTURE_REQUEST_TIMEOUT_MS,15000);assert.throws(()=>fixtureFetch('http://127.0.0.1/',{},15001));}finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
test('proxy bounds an unresponsive upstream and destroys orphan upstream responses on client abort',async()=>{
 const closed=new Map<string,Promise<void>>(),resolvers=new Map<string,()=>void>();for(const path of ['/no-headers','/hung-body'])closed.set(path,new Promise<void>(resolve=>resolvers.set(path,resolve)));
 const upstream=http.createServer((request,response)=>{response.on('close',()=>resolvers.get(request.url??'')?.());if(request.url==='/hung-body'){response.writeHead(200);response.write('partial synthetic body');}});
 const proxy=fixtureProxy({requestTimeoutMs:1200});await new Promise<void>(resolve=>upstream.listen(4174,'127.0.0.1',resolve));await new Promise<void>(resolve=>proxy.listen(4173,'127.0.0.1',resolve));
 const waitClosed=async(path:string,deadline=1500)=>{let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([closed.get(path),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error(`Synthetic upstream ${path} did not close`)),deadline);})]);}finally{clearTimeout(timer);}};
 try{const response=await fixtureFetch(`${FIXTURE_ORIGIN}/no-headers`,{},3000);assert.equal(response.status,502);await response.text();await waitClosed('/no-headers');
 const controller=new AbortController();const body=await fixtureFetch(`${FIXTURE_ORIGIN}/hung-body`,{signal:controller.signal},1500);const reading=body.text();controller.abort();await assert.rejects(reading);await waitClosed('/hung-body',400);
 }finally{proxy.closeAllConnections();upstream.closeAllConnections();await Promise.all([new Promise<void>(resolve=>proxy.close(()=>resolve())),new Promise<void>(resolve=>upstream.close(()=>resolve()))]);}
});

test('declared build BUCKET is stripped or replaced by an independent explicitly local R2 fixture',()=>{
 const declared={...source,r2_buckets:[{binding:'BUCKET',bucket_name:'site-creator-r2'}]};
 const before=JSON.stringify(declared),plain=fixtureConfig(declared),enabled=fixtureConfig(declared,{withR2:true});
 assert.equal('r2_buckets' in plain,false);
 assert.deepEqual(enabled.r2_buckets,[{binding:'BUCKET',bucket_name:'control-room-synthetic-local-attachments',remote:false}]);
 const {r2_buckets,...rest}=enabled;void r2_buckets;assert.deepEqual(rest,plain);
 assert.equal(JSON.stringify(declared),before,'source build bindings remain unchanged');
 assert.equal(JSON.stringify(plain).includes('site-creator-r2'),false);assert.equal(JSON.stringify(enabled).includes('site-creator-r2'),false);
});
test('R2 fixture rejects every source declaration beyond the exact one-BUCKET public build placeholder',()=>{
 const declaration={binding:'BUCKET',bucket_name:'site-creator-r2'};
 for(const buckets of [null,{},'BUCKET',[null],[{}],[{binding:'BUCKET'}],[{bucket_name:'site-creator-r2'}],[{...declaration,binding:'OTHER'}],[{...declaration,bucket_name:'another-bucket'}],[{...declaration,remote:true}],[{...declaration,remote:false}],[{...declaration,preview_bucket_name:'preview-bucket'}],[{...declaration,jurisdiction:'eu'}],[{...declaration,bucket_id:'synthetic-id'}],[{...declaration,executable:'synthetic.js'}],[declaration,declaration],[declaration,{binding:'OTHER',bucket_name:'other-bucket'}],[Object.assign(Object.create({}),{binding:'BUCKET',bucket_name:'site-creator-r2'})]]){
  for(const withR2 of [false,true])assert.throws(()=>fixtureConfig({...source,r2_buckets:buckets},{withR2}),/R2 declaration/);
 }
 for(const patch of [{services:[{binding:'SERVICE',service:'synthetic-service'}]},{unsafe:{bindings:[{name:'EXECUTABLE',type:'service'}]}},{durable_objects:{bindings:[{name:'EXECUTABLE',class_name:'Synthetic'}]}},{queues:{producers:[{binding:'QUEUE',queue:'synthetic-queue'}]}}])for(const withR2 of [false,true])assert.throws(()=>fixtureConfig({...source,r2_buckets:[declaration],...patch},{withR2}));
});

