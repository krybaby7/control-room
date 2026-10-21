import test from 'node:test';
import assert from 'node:assert/strict';
import {createLocalCompanionClient,localCompanionBase,LocalCompanionRequestError,parseCompanionRun} from '../lib/local-companion-client.ts';
test('companion destination cannot escape literal loopback',()=>{
 assert.equal(localCompanionBase('4319'),'http://127.0.0.1:4319');
 for(const value of ['https://evil.test','4319/path','0','65536','4319@evil',' 4319'])assert.throws(()=>localCompanionBase(value));
});
test('client sends memory token only to bounded fixed routes without ambient credentials',async()=>{
 const calls:Array<{url:string;init:RequestInit}>=[];
 const client=createLocalCompanionClient({port:'4319',code:'secret-code',fetch:async(input,init)=>{calls.push({url:String(input),init:init!});return Response.json({version:1,repositories:[]});}});
 await client.status();assert.equal(calls.length,1);assert.equal(calls[0].url,'http://127.0.0.1:4319/api/status');assert.equal(calls[0].init.credentials,'omit');assert.equal(calls[0].init.redirect,'error');assert.equal(calls[0].init.mode,'cors');assert.equal(new Headers(calls[0].init.headers).get('Authorization'),'Bearer secret-code');
 await assert.rejects(client.run('../outside'));assert.equal(calls.length,1);
});
test('start failures are sanitized and never retried',async()=>{
 let calls=0;const client=createLocalCompanionClient({port:'4319',code:'secret-code',fetch:async()=>{calls++;throw new Error('secret-code transport failure');}});
 await assert.rejects(client.analyze('repo','00000000-0000-4000-8000-000000000001'),error=>error instanceof Error&&!error.message.includes('secret-code'));assert.equal(calls,1);
});
test('reject invalid status and oversized responses',async()=>{
 const invalid=createLocalCompanionClient({port:'4319',code:'secret-code',fetch:async()=>Response.json({version:1,repositories:[{key:'../escape',name:'x',head:'a'.repeat(40),dirty:false}]})});await assert.rejects(invalid.status());
 const oversized=createLocalCompanionClient({port:'4319',code:'secret-code',fetch:async()=>new Response('x'.repeat(300000))});await assert.rejects(oversized.status());
});
test('an uncertain start reconciles only the original GET identity, and mismatches reject',async()=>{
 const id='00000000-0000-4000-8000-000000000001',calls:string[]=[];
 const client=createLocalCompanionClient({port:'4319',code:'secret-code',fetch:async(input,init)=>{calls.push(`${init?.method} ${String(input)}`);if(init?.method==='POST')throw new Error('lost response');return Response.json({id,status:'running'});}});
 await assert.rejects(client.analyze('repo',id));assert.equal((await client.run(id)).status,'running');assert.deepEqual(calls,['POST http://127.0.0.1:4319/api/analyze',`GET http://127.0.0.1:4319/api/runs/${id}`]);
 const wrong=createLocalCompanionClient({port:'4319',code:'secret-code',fetch:async()=>Response.json({id:'00000000-0000-4000-8000-000000000002',status:'running'})});await assert.rejects(wrong.analyze('repo',id));await assert.rejects(wrong.run(id));
});
test('status exposes bounded recoverable run identities without launching',async()=>{
 let calls=0;const id='00000000-0000-4000-8000-000000000001';const client=createLocalCompanionClient({port:'4319',code:'secret-code',fetch:async()=>{calls++;return Response.json({version:1,repositories:[],recentRuns:[{id,status:'completed',repositoryKey:'repo'}]});}});assert.deepEqual((await client.status()).recentRuns,[{id,status:'completed',repositoryKey:'repo'}]);assert.equal(calls,1);
});
test('unknown run response is distinguishable without exposing body or credentials',async()=>{
 const client=createLocalCompanionClient({port:'4319',code:'secret-code',fetch:async()=>new Response('secret-code',{status:404})});await assert.rejects(client.run('00000000-0000-4000-8000-000000000001'),error=>error instanceof LocalCompanionRequestError&&error.status===404&&!error.message.includes('secret-code'));
});
test('only known companion diagnostics are displayed',()=>{
 const base={id:'00000000-0000-4000-8000-000000000001',status:'failed'};
 assert.equal(parseCompanionRun({...base,error:'Companion restarted; analysis was not repeated.'}).error,'Companion restarted; analysis was not repeated.');assert.equal(parseCompanionRun({...base,error:'secret-code raw failure'}).error,'The local analysis did not complete. Inspect the helper locally.');
});
