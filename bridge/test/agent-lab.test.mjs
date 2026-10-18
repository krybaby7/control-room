import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {createAgentLabReader,sanitizeAgentLabRun,sanitizeAgentLabState,AGENT_LAB_READS,AGENT_LAB_LIMITS} from '../src/agent-lab.mjs';
const raw=JSON.parse(await readFile(new URL('../../tests/fixtures/agents/lab-summary.json',import.meta.url),'utf8'));
const NOW='2026-10-18T12:00:02.000Z',options={instanceId:'synthetic-lab',observedAt:NOW};
test('allowlisted synthetic evaluation keeps blocked/null provenance and never includes tokens, paths, settings or transcripts',()=>{
 const projected=sanitizeAgentLabState(raw,options),text=JSON.stringify(projected),run=projected.runs[0];
 assert.equal(projected.source,'agent-lab');assert.equal(projected.observedAt,NOW);assert.equal(projected.availability,'available');assert.equal(projected.sourceVersion,'0.1.0');assert.deepEqual(projected.queue,{paused:true,active:false});
 assert.equal(run.status,'blocked');assert.equal(run.grade,null);assert.equal(run.usage,null);assert.equal(run.observedModel,null);assert.equal(run.modelVerified,false);assert.equal(run.reportedModelVerified,false);assert.equal(run.identityProvenance,'upstream-claim');assert.equal(run.createdAt,raw.runs[0].createdAt);assert.equal(run.fixtureHash,raw.runs[0].fixtureHash);assert.equal(run.cohortSha256,null);
 for(const value of ['SYNTHETIC_CSRF','SYNTHETIC_DO_NOT','SYNTHETIC_TRANSCRIPT','SYNTHETIC_ERROR','SYNTHETIC_FINAL','not-a-real-provider','csrfToken','settings','providers','executable','stdout','stderr','finalText'])assert.equal(text.includes(value),false,value);
 assert.equal(Object.hasOwn(projected,'ready'),false);assert.equal(Object.hasOwn(run,'dollarsSaved'),false);
});
test('unknown identities/status/usage/grade/dates remain explicit unknowns and never fabricate a verified model or objective pass',()=>{
 const projected=sanitizeAgentLabRun({...raw.runs[0],provider:'unknown-provider',requestedModel:'C:\\synthetic\\private.exe',observedModel:'https://invalid.example/model',modelVerified:true,runtimeVersion:'../private',runtimeToolPolicy:'/private',status:'passed',grade:{passed:true},usage:{tokens:100},createdAt:'2026-02-30T12:00:00Z',finishedAt:null});
 for(const key of ['provider','requestedModel','observedModel','runtimeVersion','runtimeToolPolicy','status','grade','usage','createdAt','finishedAt','cohortSha256'])assert.equal(projected[key],null,key);
 assert.equal(projected.modelVerified,false);assert.equal(projected.reportedModelVerified,true);for(const limitation of ['objective_grade_schema_unverified','usage_schema_unverified','model_identity_unverified','source_status_unknown','cohort_identity_incomplete'])assert.ok(projected.limitations.includes(limitation));
 const mismatch=sanitizeAgentLabRun({...raw.runs[0],requestedModel:'exact-one',observedModel:'exact-two',modelVerified:true});assert.equal(mismatch.modelVerified,false);
 const badOrder=sanitizeAgentLabRun({...raw.runs[0],createdAt:'2026-10-19T12:00:00Z'});assert.equal(badOrder.finishedAt,null);assert.ok(badOrder.limitations.includes('source_clock_order_unverified'));
});
test('cohort identity uses exact task/version/fixture/provider/runtime/tool/model conditions, excluding observation time and hostile extras',()=>{
 const known={...raw.runs[0],observedModel:'gpt-6-luna',modelVerified:true},first=sanitizeAgentLabRun(known);
 assert.match(first.cohortSha256,/^[a-f0-9]{64}$/u);assert.equal(first.modelVerified,true);assert.equal(sanitizeAgentLabRun({...known,csrfToken:'not-forwarded',createdAt:null}).cohortSha256,first.cohortSha256);
 for(const [field,value]of Object.entries({taskId:'other',taskVersion:2,fixtureHash:'b'.repeat(64),provider:'claude',requestedModel:'another-model',observedModel:'another-model',runtimeVersion:'other-runtime',runtimeToolPolicy:'other-policy',promptMode:'response',effort:'high'}))assert.notEqual(sanitizeAgentLabRun({...known,[field]:value}).cohortSha256,first.cohortSha256,field);
 assert.equal(sanitizeAgentLabState({...raw,runs:[]},options).availability,'no-runs');assert.throws(()=>sanitizeAgentLabState({...raw,runs:[raw.runs[0],raw.runs[0]]},options));assert.throws(()=>sanitizeAgentLabState({...raw,runs:Array(1001).fill(raw.runs[0])},options));assert.throws(()=>sanitizeAgentLabState({...raw,runs:[{...raw.runs[0],id:'../bad'}]},options));
});
test('fixed actual fake loopback HTTP is bounded, read-only, disabled by default, nonredirecting and reconnects without writes',async t=>{
 let handler=(request,response)=>{response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify(raw));};
 const seen=[],sockets=new Set(),server=http.createServer((request,response)=>{seen.push({method:request.method,path:request.url,headers:request.headers});handler(request,response);});
 server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(4317,'127.0.0.1',resolve);});
 const reader=createAgentLabReader({enabled:true,instanceId:'synthetic-lab',now:()=>NOW});
 try{
  await t.test('disabled means zero requests and invalid endpoints/options cannot be selected',async()=>{
   const before=seen.length,disabled=createAgentLabReader({now:()=>NOW});assert.equal((await disabled.readState()).availability,'disabled');assert.equal((await disabled.readReport()).reason,'not_configured');assert.equal(seen.length,before);
   for(const options of [{baseUrl:'http://remote.invalid'},{port:9999},{headers:{Authorization:'synthetic'}},{method:'POST'},{deadlineMs:AGENT_LAB_LIMITS.deadlineMs+1}])assert.throws(()=>createAgentLabReader(options));
   for(const id of ['../escape','/api/session','with%2fslash','query?token=value','bad\\path'])await assert.rejects(reader.readRun(id));
   assert.equal(seen.length,before);assert.deepEqual(AGENT_LAB_READS,{state:'http://127.0.0.1:4317/api/state',report:'http://127.0.0.1:4317/api/report'});
  });
  await t.test('state and selected run use only fixed GET with no credentials or private token acquisition',async()=>{
   assert.equal((await reader.readState()).runs[0].status,'blocked');
   handler=(_request,response)=>{response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify(raw.runs[0]));};const selected=await reader.readRun('fixture-run-1');assert.equal(selected.available,true);assert.equal(selected.run.id,'fixture-run-1');
   handler=(_request,response)=>{response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({...raw.runs[0],id:'foreign-run'}));};assert.equal((await reader.readRun('fixture-run-1')).available,false);
   for(const row of seen){assert.equal(row.method,'GET');assert.equal(row.headers.host,'127.0.0.1:4317');for(const key of ['authorization','cookie','x-lab-token','x-control-room-device'])assert.equal(row.headers[key],undefined);}
   assert.ok(seen.every(row=>row.path==='/api/state'||row.path==='/api/runs/fixture-run-1'));
  });
  await t.test('redirect, malformed UTF8/JSON, media type and bounded bodies fail without forwarding raw content',async()=>{
   const cases=[
    response=>{response.writeHead(302,{Location:'/api/session'});response.end();},
    response=>{response.writeHead(200,{'Content-Type':'application/json'});response.end('{');},
    response=>{response.writeHead(200,{'Content-Type':'application/json'});response.end(Buffer.from([255]));},
    response=>{response.writeHead(200,{'Content-Type':'text/html'});response.end('<script>SYNTHETIC_PRIVATE</script>');},
    response=>{response.writeHead(200,{'Content-Type':'application/json','Content-Length':AGENT_LAB_LIMITS.responseBytes+1});response.end();},
    response=>{response.writeHead(200,{'Content-Type':'application/json'});response.end(' '.repeat(AGENT_LAB_LIMITS.responseBytes+1));},
   ];
   for(const send of cases){handler=(_request,response)=>send(response);const result=await reader.readState();assert.equal(result.availability,'unavailable');assert.equal(result.diagnostic,'source_invalid');assert.equal(JSON.stringify(result).includes('SYNTHETIC_PRIVATE'),false);}
   assert.equal(seen.some(row=>row.path==='/api/session'),false);
  });
  await t.test('hung body deadline and service failure are unavailable; next explicit read can reconnect',async()=>{
   handler=(_request,response)=>{response.writeHead(200,{'Content-Type':'application/json'});response.write('{"runs":');};const hung=await createAgentLabReader({enabled:true,instanceId:'synthetic-lab',now:()=>NOW,deadlineMs:50}).readState();assert.equal(hung.availability,'unavailable');assert.equal(hung.diagnostic,'source_unreachable');
   handler=(_request,response)=>{response.writeHead(503,{'Content-Type':'application/json'});response.end('{"secret":"SYNTHETIC_PRIVATE"}');};assert.equal((await reader.readState()).diagnostic,'source_unreachable');
   handler=(_request,response)=>{response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({...raw,runs:[]}));};assert.equal((await reader.readState()).availability,'no-runs');
  });
  await t.test('report schema stays unsupported and Markdown/private prose never becomes a grade or readiness',async()=>{
   for(const [type,body]of [['text/markdown','# SYNTHETIC_PRIVATE_REPORT'],['application/json',JSON.stringify({markdown:'SYNTHETIC_PRIVATE_REPORT',cohorts:[{ready:true,savings:999}],csrfToken:'SYNTHETIC_PRIVATE'})]]){
    handler=(_request,response)=>{response.writeHead(200,{'Content-Type':type});response.end(body);};const result=await reader.readReport();assert.equal(result.available,false);assert.equal(result.reason,'unsupported-report-schema');assert.equal(result.observedAt,NOW);assert.equal(JSON.stringify(result).includes('SYNTHETIC_PRIVATE'),false);assert.equal(Object.hasOwn(result,'cohorts'),false);
   }
  });
 }finally{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}
 const missing=await reader.readState();assert.equal(missing.availability,'unavailable');assert.equal(missing.diagnostic,'source_unreachable');
 assert.ok(seen.every(row=>row.method==='GET'&&['/api/state','/api/report','/api/runs/fixture-run-1'].includes(row.path)));
});
