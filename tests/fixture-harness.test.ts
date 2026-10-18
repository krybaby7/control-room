import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {parseFixtureArgs,fixtureConfig,fixtureEnvironment,SYNTHETIC_DB_ID,FIXTURE_ORIGIN} from '../scripts/test-fixtures.mjs';
import {fixtureProxy,requireFreePort,assertFixtureStatus} from '../scripts/test-worker.mjs';
const source={main:'index.js',assets:{directory:'../client'},compatibility_date:'2026-05-15',d1_databases:[{binding:'DB',database_id:SYNTHETIC_DB_ID}],r2_buckets:[]};
test('harness accepts only explicit local fixture flags and rejects deployment bindings',()=>{
 assert.deepEqual(parseFixtureArgs(['--target','local-fixture']),{serve:false,withR2:false});assert.equal(parseFixtureArgs(['--target','local-fixture','--serve']).serve,true);
 for(const args of [[],['--target','production'],['--target','local-fixture','--remote'],['--target','local-fixture','--port','80']])assert.throws(()=>parseFixtureArgs(args));
 for(const unsafe of [{...source,d1_databases:[{database_id:'real-owner-id'}]},{...source,d1_databases:[{database_id:SYNTHETIC_DB_ID,remote:true}]},{...source,r2_buckets:[{binding:'BUCKET'}]},{...source,services:[{}]},{...source,main:'https://foreign.invalid/worker.js'}])assert.throws(()=>fixtureConfig(unsafe));
 const config=fixtureConfig(source);assert.equal(config.d1_databases[0].database_id,SYNTHETIC_DB_ID);assert.equal(config.dev.ip,'127.0.0.1');assert.ok(config.main.startsWith('/'));assert.ok(config.assets.directory.startsWith('/'));assert.equal('r2_buckets' in config,false);const env=fixtureEnvironment('/tmp/synthetic-fixture');assert.equal('CLOUDFLARE_API_TOKEN' in env,false);assert.equal('HOME' in env,false);assert.equal(env.XDG_CONFIG_HOME,'/tmp/synthetic-fixture/config');
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
