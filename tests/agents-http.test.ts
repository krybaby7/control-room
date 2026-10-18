import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {createSeedWorkspace} from '../lib/seed.ts';
import {loadWorkspace,readCurrent,type SqlDatabase,type SqlStatement} from '../lib/workspace-store.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {handleAgentHttp,type AgentHttpAction,type AgentHttpDependencies} from '../lib/agents/http.ts';
import {commitEvaluationSummary,type EvaluationUpload} from '../lib/agents/evaluations-store.ts';
import {RecoverabilityCapacityError} from '../lib/recoverability-admission.ts';
import type {DeviceScope,DevicePrincipal} from '../lib/devices/contracts.ts';
const now='2026-10-18T12:00:00.000Z',owner='synthetic-agent-owner',device='synthetic-agent-device',token='a'.repeat(64);
const ingress={async verify(){return {serviceIdentity:'synthetic-private-ingress'};}};
async function fixture(scopes:DeviceScope[]=['jobs:poll','jobs:report','evaluations:write']){
 const f=database();await loadWorkspace(f.db,owner,()=>createSeedWorkspace(now),now);
 const display={id:device,label:'Synthetic agent fixture',createdAt:now,archivedAt:null},payload=canonical(display);
 await f.db.prepare('INSERT INTO devices(user_id,id,row_revision,payload_json,content_hash,created_at,archived_at) VALUES(?,?,1,?,?,?,NULL)').bind(owner,device,payload,await contentHash(payload),now).run();
 await f.db.prepare('INSERT INTO device_runtime(user_id,device_id,operational_revision,execution_epoch,current_generation,current_boot_id,last_live_received_at,revoked_at,last_request_at) VALUES(?,?,1,0,1,NULL,NULL,NULL,NULL)').bind(owner,device).run();
 await f.db.prepare('INSERT INTO device_credentials(user_id,id,device_id,token_hash,scopes_json,execution_epoch,created_at,expires_at,revoked_at,rotation_retire_at) VALUES(?,?,?,?,?,0,?,?,NULL,NULL)').bind(owner,'synthetic-credential',device,await contentHash(token),canonical(scopes),now,'2099-01-01T00:00:00.000Z').run();
 const principal:DevicePrincipal={ownerId:owner,deviceId:device,credentialId:'synthetic-credential',scopes};return {...f,principal};
}
function request(value:unknown,headers:Record<string,string>={},path='/api/bridge/jobs/claim'){return new Request('https://synthetic-private.invalid'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Control-Room-Device':token,...headers},body:JSON.stringify(value)});}
const claim={jobId:'synthetic-job',journalNonce:'n'.repeat(32)},lease={attemptId:'synthetic-attempt',leaseToken:'b'.repeat(64)};
function capability(){return {schemaVersion:1,deviceId:device,configurationSha256:'a'.repeat(64),provider:'codex',runtime:{version:'fixture-1.0',sourceCommit:'b'.repeat(40),packageSha256:'c'.repeat(64),toolPolicy:'fixture-policy',executableSha256:'d'.repeat(64),executableVersion:'fixture-cli 1.0',toolPolicySha256:'e'.repeat(64)},operations:['project.inspect'],models:[{id:'fixture-exact-model',efforts:['medium']}],repositoryKeys:['fixture-repo'],observedAt:now,expiresAt:'2026-10-18T12:05:00.000Z',maxConcurrent:1,availableSlots:1,maxTimeoutSeconds:30,maxOutputBytesLimit:2048,allowedPathsSha256ByRepositoryKey:{'fixture-repo':'f'.repeat(64)},modelIdentityPolicy:'require-observed',subscriptionOnly:true,extraUsageOffAttested:true};}
function result(){return {attemptId:lease.attemptId,epoch:0,disposition:'blocked',requestedModel:'fixture-exact-model',observedModel:null,modelVerified:false,terminalProtocolObserved:false,processExitConfirmed:true,terminationUnconfirmed:false,artifactIds:[],usage:null,diagnostic:'not_installed'};}
function upload(id='fixture-run-1'):EvaluationUpload{return {schemaVersion:1,sourceFormatVersion:1,sourceInstance:'fixture-lab',version:'0.1.0',runs:[{id,taskId:'incident-evidence-v1',taskVersion:1,fixtureHash:'a'.repeat(64),provider:'codex',requestedModel:'fixture-exact-model',observedModel:null,modelVerified:false,runtimeVersion:'fixture-runtime',runtimeToolPolicy:'native-sandbox',promptMode:'structured',effort:'medium',status:'blocked',grade:null,review:{verdict:'pending',minutes:null,corrections:null},usage:null,createdAt:'2026-10-18T11:59:00.000Z',finishedAt:'2026-10-18T11:59:01.000Z'}]};}
test('default unsupported private ingress rejects before DB lookup or request body read and settles cancellation',async()=>{
 let queries=0,pulls=0;const db:SqlDatabase={prepare(){queries++;throw new Error('No unauthenticated database lookup');},async batch(){queries++;throw new Error('No unauthenticated database write');}};
 const body=new ReadableStream<Uint8Array>({pull(controller){pulls++;controller.enqueue(new TextEncoder().encode(JSON.stringify(claim)));controller.close();}},{highWaterMark:0}),req=new Request('https://synthetic-private.invalid/api/bridge/jobs/claim',{method:'POST',headers:{'Content-Type':'application/json','X-Control-Room-Device':token},body,duplex:'half'} as RequestInit);
 const response=await handleAgentHttp('claim',req,{db,now:()=>now});assert.equal(response.status,401);assert.equal(pulls,0);assert.equal(queries,0);assert.equal(response.headers.get('cache-control'),'no-store, private');assert.equal(response.headers.get('x-content-type-options'),'nosniff');assert.equal(req.bodyUsed,true);
});
test('telemetry never authorizes jobs or evaluation; execution requires both exact job scopes',async()=>{
 for(const scopes of [['telemetry:write'],['jobs:poll'],['jobs:report']] as DeviceScope[][]){
  const f=await fixture(scopes);try{let invoked=0;const deps:AgentHttpDependencies={db:f.db,ingress,now:()=>now,operations:{claim:async()=>{invoked++;return null;}}};assert.ok([401,403].includes((await handleAgentHttp('claim',request(claim),deps)).status));assert.equal((await handleAgentHttp('evaluations',request({...upload(),runs:[]}),deps)).status,401);assert.equal(invoked,0);}finally{f.sqlite.close();}
 }
 const evaluations=await fixture(['evaluations:write']);try{const response=await handleAgentHttp('evaluations',request({...upload(),runs:[]}),{db:evaluations.db,ingress,now:()=>now});assert.equal(response.status,200);assert.equal((await response.json() as {status:string}).status,'unchanged');assert.equal((await handleAgentHttp('claim',request(claim),{db:evaluations.db,ingress,now:()=>now})).status,401);}finally{evaluations.sqlite.close();}
});
test('authenticated dispatch receives mapped owner, fresh clock and strict closed action payloads only',async()=>{
 const f=await fixture();try{
  const cases:Array<[Exclude<AgentHttpAction,'evaluations'>,unknown]>=[['capabilities',{capability:capability(),expectedOperationalRevision:null}],['claim',claim],['renew',lease],['events',{...lease,events:[{schemaVersion:1,attemptId:lease.attemptId,epoch:0,sequence:1,kind:'progress',observedAt:now,diagnostic:'ok',details:{stage:'executing',completedUnits:1,totalUnits:2}}]}],['complete',{...lease,result:result()}],['reconcile',{attemptId:lease.attemptId,journalNonce:claim.journalNonce,proof:'no-launch'}]];
  for(const [action,value] of cases){let calls=0;const response=await handleAgentHttp(action,request(value),{db:f.db,ingress,now:()=>now,operations:{[action]:async(principal,received,fresh)=>{calls++;assert.equal(principal.ownerId,owner);assert.equal(principal.deviceId,device);assert.deepEqual(received,value);assert.equal(fresh,now);return {observed:true};}}});assert.equal(response.status,200);assert.deepEqual(await response.json(),{observed:true});assert.equal(calls,1);
   assert.equal((await handleAgentHttp(action,request({...value as Record<string,unknown>,ownerId:'synthetic-foreign-owner'}),{db:f.db,ingress,now:()=>now})).status,400);
  }
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM job_attempts').get()!.n,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_job_intents').get()!.n,0);
 }finally{f.sqlite.close();}
});
test('cookie, owner query, malformed UTF8, content type, stream and declared byte limits cannot reach dispatch',async()=>{
 const f=await fixture();try{
  let calls=0;const deps:AgentHttpDependencies={db:f.db,ingress,now:()=>now,operations:{claim:async()=>{calls++;return null;}}};
  assert.equal((await handleAgentHttp('claim',request(claim,{Cookie:'ambient=not_authority'}),deps)).status,403);
  assert.equal((await handleAgentHttp('claim',request(claim,{},'/api/bridge/jobs/claim?owner=foreign'),deps)).status,400);
  assert.equal((await handleAgentHttp('claim',new Request('https://synthetic-private.invalid'),deps)).status,405);
  assert.equal((await handleAgentHttp('claim',request(claim,{'Content-Type':'text/plain'}),deps)).status,415);
  assert.equal((await handleAgentHttp('claim',request(claim,{'content-length':'65537'}),deps)).status,413);
  assert.equal((await handleAgentHttp('claim',request({...claim,extra:'x'.repeat(65536)}),deps)).status,413);
  const invalid=new Request('https://synthetic-private.invalid',{method:'POST',headers:request(claim).headers,body:new Uint8Array([255])});assert.equal((await handleAgentHttp('claim',invalid,deps)).status,400);
  assert.equal(calls,0);
 }finally{f.sqlite.close();}
});
test('body deadline and post-transfer credential expiry/revocation prevent every job dispatch',async()=>{
 const f=await fixture();try{let calls=0;const operations={claim:async()=>{calls++;return null;}},body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new TextEncoder().encode('{"jobId":'));},cancel(){return new Promise<void>(()=>{});}}),hung=new Request('https://synthetic-private.invalid',{method:'POST',headers:request(claim).headers,body,duplex:'half'} as RequestInit),start=performance.now();
  assert.equal((await handleAgentHttp('claim',hung,{db:f.db,ingress,now:()=>now,bodyTimeoutMs:5,operations})).status,408);assert.ok(performance.now()-start<2000);assert.equal(calls,0);
  f.sqlite.prepare('UPDATE device_credentials SET expires_at=?').run('2026-10-18T12:00:01.000Z');let clocks=0;
  assert.equal((await handleAgentHttp('claim',request(claim),{db:f.db,ingress,now:()=>++clocks===1?now:'2026-10-18T12:00:02.000Z',operations})).status,401);assert.equal(calls,0);
 }finally{f.sqlite.close();}
});
test('capability device spoof and forged request verification callbacks are rejected without leaking error details',async()=>{
 const f=await fixture();try{let calls=0;const deps:AgentHttpDependencies={db:f.db,ingress,now:()=>now,operations:{capabilities:async()=>{calls++;return null;},reconcile:async()=>{calls++;return null;}}};
  assert.equal((await handleAgentHttp('capabilities',request({capability:{...capability(),deviceId:'foreign-device'},expectedOperationalRevision:null}),deps)).status,403);
  const response=await handleAgentHttp('reconcile',request({attemptId:lease.attemptId,journalNonce:claim.journalNonce,proof:'no-launch',verifyNoLaunch:true,rawTranscript:'private-secret'}),deps);assert.equal(response.status,400);assert.equal(JSON.stringify(await response.json()).includes('private-secret'),false);assert.equal(calls,0);
 }finally{f.sqlite.close();}
});
test('actual evaluation append is scoped, idempotent and historical; corrected outcome appends without editor revision or queue changes',async()=>{
 const f=await fixture(['evaluations:write']);try{
  const before=await readCurrent(f.db,owner,now),first=upload();(first.runs[0] as Record<string,unknown>).csrfToken='private-csrf';(first.runs[0] as Record<string,unknown>).providerExecutable='C:/private/provider.exe';
  const response=await handleAgentHttp('evaluations',request(first),{db:f.db,ingress,now:()=>now});assert.equal(response.status,200);const result=await response.json() as {status:string;inserted:number};assert.equal(result.status,'committed');assert.equal(result.inserted,1);
  const row=f.sqlite.prepare('SELECT * FROM evaluation_runs WHERE user_id=?').get(owner)!;assert.equal(row.row_revision,1);assert.equal(row.stream_sequence,1);assert.equal((JSON.parse(row.payload_json as string) as {status:string}).status,'blocked');assert.equal((row.payload_json as string).includes('private-'),false);assert.equal((row.payload_json as string).includes('C:/'),false);
  const replay=await handleAgentHttp('evaluations',request(first),{db:f.db,ingress,now:()=> '2026-10-18T12:00:02.000Z'});assert.equal(replay.status,200);assert.equal((await replay.json() as {status:string}).status,'replayed');assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM evaluation_runs').get()!.n,1);
  const changed=upload();(changed.runs[0] as Record<string,unknown>).status='failed';assert.equal((await handleAgentHttp('evaluations',request(changed),{db:f.db,ingress,now:()=> '2026-10-18T12:00:03.000Z'})).status,200);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM evaluation_runs').get()!.n,2);assert.equal(f.sqlite.prepare("SELECT last_sequence FROM operational_stream_heads WHERE user_id=? AND stream_id='agents'").get(owner)!.last_sequence,2);
  assert.deepEqual(await readCurrent(f.db,owner,now),before);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM job_attempts').get()!.n,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_job_intents').get()!.n,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM evaluation_runs WHERE user_id=?').get('synthetic-foreign-owner')!.n,0);
  assert.equal((await handleAgentHttp('evaluations',request({...first,csrfToken:'private-top-level'}),{db:f.db,ingress,now:()=>now})).status,400);
 }finally{f.sqlite.close();}
});
test('evaluation growth rejects a changed operational vector or normalized rowset with no partial history',async()=>{
 for(const race of ['stream','normalized']){
  const f=await fixture(['evaluations:write']);try{
   const sqlByStatement=new WeakMap<SqlStatement,string>();let changed=false;
   const db:SqlDatabase={prepare(sql){const statement=f.db.prepare(sql);sqlByStatement.set(statement,sql);return statement;},async batch(statements){
    if(!changed&&statements.some(statement=>sqlByStatement.get(statement)?.startsWith('WITH evaluation_authority'))){changed=true;if(race==='stream')f.sqlite.prepare("INSERT INTO operational_stream_heads(user_id,stream_id,revision,last_sequence) VALUES(?,'sources',1,1)").run(owner);else{const display={id:'synthetic-racing-device',label:'Synthetic racing display',createdAt:now,archivedAt:null},payload=canonical(display);f.sqlite.prepare('INSERT INTO devices(user_id,id,row_revision,payload_json,content_hash,created_at,archived_at) VALUES(?,?,1,?,?,?,NULL)').run(owner,display.id,payload,await contentHash(payload),now);}}
    return f.db.batch(statements);
   }};
   await assert.rejects(commitEvaluationSummary(db,f.principal,upload(),now));assert.equal(changed,true);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM evaluation_runs').get()!.n,0);assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM audit_events WHERE kind='agent.evaluations.imported'").get()!.n,0);
  }finally{f.sqlite.close();}
 }
});
test('a full recovery boundary rejects evaluation growth before any history or stream write',async()=>{
 const f=await fixture(['evaluations:write']);try{
  const event={id:'synthetic-large-legacy-audit',kind:'workspace.restore',entityType:'workspace',entityId:null,changes:[{path:['workspace'],before:{exists:false,value:null},after:{exists:true,value:'x'.repeat(1900000)}}],origin:'owner',actorId:owner,occurredAt:now,sourceRef:null,undoOf:null};
  f.sqlite.prepare('INSERT INTO audit_events(user_id,event_id,workspace_revision,ordinal,kind,entity_type,entity_id,occurred_at,payload_json,origin,actor_id,source_ref,undo_of) VALUES(?,?,1,0,?,?,NULL,?,?,?, ?,NULL,NULL)').run(owner,event.id,event.kind,event.entityType,now,canonical(event),event.origin,owner);
  await assert.rejects(commitEvaluationSummary(f.db,f.principal,upload(),now),RecoverabilityCapacityError);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM evaluation_runs').get()!.n,0);assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM operational_stream_heads WHERE user_id=? AND stream_id='agents'").get(owner)!.n,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM audit_events').get()!.n,1);
 }finally{f.sqlite.close();}
});

test('lost evaluation batch response reconciles the same immutable receipt without duplicate rows or audit',async()=>{
 const f=await fixture(['evaluations:write']);try{
  const sqlByStatement=new WeakMap<SqlStatement,string>();let lost=false;
  const db:SqlDatabase={prepare(sql){const statement=f.db.prepare(sql);sqlByStatement.set(statement,sql);return statement;},async batch(statements){const result=await f.db.batch(statements);if(!lost&&statements.some(statement=>sqlByStatement.get(statement)?.startsWith('WITH evaluation_authority'))){lost=true;throw new Error('Synthetic committed response loss');}return result;}};
  const result=await commitEvaluationSummary(db,f.principal,upload(),now);assert.equal(result.status,'replayed');assert.equal(lost,true);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM evaluation_runs').get()!.n,1);assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM audit_events WHERE kind='agent.evaluations.imported'").get()!.n,1);assert.equal((await readCurrent(f.db,owner,now)).revision,1);
 }finally{f.sqlite.close();}
});

test('late reconciliation journal events retain their exact old attempt epoch and cannot inject authority',async()=>{
 const f=await fixture();try{
  const event={schemaVersion:1,attemptId:lease.attemptId,epoch:0,sequence:3,observedAt:now,diagnostic:'ok',kind:'process_exit',details:{exitCode:0,processExitConfirmed:true,terminationUnconfirmed:false}},body={attemptId:lease.attemptId,journalNonce:claim.journalNonce,proof:'exited',events:[event],result:result()};let calls=0;
  const response=await handleAgentHttp('reconcile',request(body),{db:f.db,ingress,now:()=>now,operations:{reconcile:async(principal,value)=>{calls++;assert.equal(principal.ownerId,owner);assert.deepEqual(value,body);return {recordId:null,result:null};}}});assert.equal(response.status,200);assert.equal(calls,1);
  assert.equal((await handleAgentHttp('reconcile',request({...body,events:[{...event,details:{...event.details,leaseToken:'private-invalid'}}]}),{db:f.db,ingress,now:()=>now})).status,400);
 }finally{f.sqlite.close();}
});
