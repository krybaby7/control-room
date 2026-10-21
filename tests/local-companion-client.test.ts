import test from 'node:test';
import assert from 'node:assert/strict';
import {createLocalCompanionClient,localCompanionBase,LocalCompanionRequestError,parseCompanionRun,parseImportedLocalReport,sameLocalAnalysisReport,loadSavedLocalAnalyses,SavedLocalAnalysisReadError} from '../lib/local-companion-client.ts';
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
test('import rejects malformed UTF-8, oversized files and arbitrary JSON before any save',()=>{
 for(const bytes of [new Uint8Array([0xff]),new Uint8Array(55001),new TextEncoder().encode('{"project":"untrusted"}')])assert.throws(()=>parseImportedLocalReport(bytes));
});
test('import preserves a valid UTF-8 report and original run identity without requesting inference',async()=>{
 const report={format:'control-room-project-analysis',version:1,repository:{key:'example',name:'Example',head:'a'.repeat(40),dirty:true,snapshotSha256:'b'.repeat(64),files:1,bytes:10,includedChanges:true,excludedFiles:2},run:{id:'00000000-0000-4000-8000-000000000001',provider:'codex',requestedModel:'gpt-6.1-sol',observedModel:null,startedAt:'2026-10-21T12:00:00Z',completedAt:'2026-10-21T12:01:00Z',mode:'read-only',source:'paired-local-companion'},summary:'Example · مثال',architecture:[],findings:[],suggestedTasks:[],limitations:['Partial source only.']};
 assert.deepEqual(parseImportedLocalReport(new TextEncoder().encode(JSON.stringify(report))),report);
 const valid=parseImportedLocalReport(new TextEncoder().encode(JSON.stringify(report)));
 assert.equal(sameLocalAnalysisReport(valid,{...valid,summary:'Changed under the same run ID'}),false);
 assert.equal(sameLocalAnalysisReport(valid,Object.fromEntries(Object.entries(valid).reverse())),true);
 const loaded=await loadSavedLocalAnalyses({projectId:'project',fetch:async()=>Response.json({revision:6,asOf:'2026-10-21T12:01:00Z',reports:[{evidenceId:'example',version:1,projectId:'project',report:valid,recordedAt:'2026-10-21T12:01:00Z'}]})});assert.equal(loaded.reports.length,1);assert.deepEqual(loaded.reports[0].report,valid);
});
test('saved report loading separates a timed-out request from a successful empty response',async()=>{
 const empty=await loadSavedLocalAnalyses({fetch:async()=>Response.json({revision:3,asOf:'2026-10-21T12:00:00Z',reports:[]})});assert.deepEqual(empty.reports,[]);
 const hanging:typeof fetch=async(_input,init)=>await new Promise((_resolve,reject)=>{init?.signal?.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});});
 await assert.rejects(loadSavedLocalAnalyses({fetch:hanging,timeoutMs:5}),error=>error instanceof SavedLocalAnalysisReadError&&error.reason==='timeout');
});
test('saved report reads preserve same-origin session and distinguish expiration without inference',async()=>{
 let calls=0;await assert.rejects(loadSavedLocalAnalyses({projectId:'example',fetch:async(input,init)=>{calls++;assert.equal(String(input),'/api/local-analysis?projectId=example');assert.equal(init?.credentials,'same-origin');return new Response(null,{status:401});}}),error=>error instanceof SavedLocalAnalysisReadError&&error.reason==='session');assert.equal(calls,1);
});
