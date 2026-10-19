import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {workspaceFixture,taskFixture} from './helpers/workspace.ts';
import {encodePlanning} from '../lib/workspace-codec.ts';
import {loadWorkspace,type SqlDatabase} from '../lib/workspace-store.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import type {DevicePrincipal} from '../lib/devices/contracts.ts';
import type {AgentCommandContext} from '../lib/agents/command-contracts.ts';
import {agentCapabilitySchema,agentJobResultSchema,type AgentJobResultV1} from '../lib/agents/contracts.ts';
import {buildAgentJobSpec,agentJobSpecSha256,buildAgentExecutionBinding,agentExecutionBindingSha256,buildAgentApprovalEnvelope} from '../lib/agents/policy.ts';
import {claimAgentJob,renewAgentLease,reportAgentEvents,completeAgentAttempt,expireAgentAttempts,reconcileAgentAttempt,reportAgentCapability,agentFrozenAdmissionSchema,type AgentLease,type AgentStoreOptions} from '../lib/agents/store.ts';
const now='2026-10-18T12:00:00.000Z',later=(seconds:number)=>new Date(Date.parse(now)+seconds*1000).toISOString(),sha='a'.repeat(64),nonce='synthetic_journal_nonce_0000000000000001';
async function fixture(timeoutSeconds=120,notes='',evidence=''){
 const f=database(),owner='synthetic-owner',deviceId='synthetic-device',jobId='synthetic-job',intentId='synthetic-intent';
 const workspace=workspaceFixture({tasks:[taskFixture('task-1',{notes,evidence})]});await loadWorkspace(f.db,owner,()=>workspace,now);
 f.sqlite.prepare('INSERT INTO workspace_execution_state(user_id,epoch,restored_at) VALUES(?,0,?)').run(owner,now);
 const display={id:deviceId,label:'Synthetic lease fixture',createdAt:now,archivedAt:null},scopes=['jobs:poll','jobs:report'];
 f.sqlite.prepare('INSERT INTO devices(user_id,id,row_revision,payload_json,content_hash,created_at) VALUES(?,?,1,?,?,?)').run(owner,deviceId,canonical(display),await contentHash(canonical(display)),now);
 f.sqlite.prepare('INSERT INTO device_credentials(user_id,id,device_id,token_hash,scopes_json,execution_epoch,created_at,expires_at) VALUES(?,?,?,?,?,0,?,?)').run(owner,'credential-1',deviceId,sha,canonical(scopes),now,later(3600));
 f.sqlite.prepare('INSERT INTO device_runtime(user_id,device_id,operational_revision,execution_epoch,current_generation) VALUES(?,?,1,0,0)').run(owner,deviceId);
 const principal={ownerId:owner,deviceId,credentialId:'credential-1',scopes} as DevicePrincipal;
 const runtime={version:'synthetic-1',sourceCommit:'b'.repeat(40),packageSha256:sha,toolPolicy:'synthetic-policy',executableSha256:sha,executableVersion:'synthetic 1',toolPolicySha256:sha};
 const capability=agentCapabilitySchema.parse({schemaVersion:1,deviceId,configurationSha256:sha,provider:'codex',runtime,operations:['project.inspect'],models:[{id:'synthetic-exact-model',efforts:['medium']}],repositoryKeys:['synthetic-repo'],observedAt:now,expiresAt:later(300),maxConcurrent:1,availableSlots:1,maxTimeoutSeconds:600,maxOutputBytesLimit:2048,allowedPathsSha256ByRepositoryKey:{'synthetic-repo':sha},modelIdentityPolicy:'require-observed',subscriptionOnly:true,extraUsageOffAttested:true});
 const capabilityHash=await contentHash(canonical(capability));
 f.sqlite.prepare('INSERT INTO agent_capabilities(user_id,device_id,manifest_hash,payload_json,reported_at,operational_revision) VALUES(?,?,?,?,?,1)').run(owner,deviceId,capabilityHash,canonical(capability),now);
 const spec=await buildAgentJobSpec({operation:'project.inspect',projectId:'p1',taskId:'task-1',repositoryKey:'synthetic-repo',baseCommit:'b'.repeat(40),inputArtifactIds:[],requestedModel:'synthetic-exact-model',effort:'medium',timeoutSeconds,outputBytesLimit:2048,dependsOnJobIds:[]},{workspace,workspaceRevision:1,acceptanceInputs:{}});
 const specSha256=await agentJobSpecSha256(spec),record={id:jobId,intentId,spec,specSha256,createdAt:now,retryOfJobId:null,historical:false},binding=await buildAgentExecutionBinding(spec,capability,{artifactRefs:[],budget:{jobs:1,timeoutSeconds,outputBytesLimit:2048,inputBytesLimit:32768,payment:'subscription-only',costDollars:null},now}),bindingHash=await agentExecutionBindingSha256(binding);
 const envelope=await buildAgentApprovalEnvelope(spec,{approval:{id:'approval-1',jobId,deviceId,specSha256,capabilitySha256:capabilityHash,configurationSha256:sha,taskSnapshotSha256:spec.taskSnapshotSha256,approvedAt:now,expiresAt:later(86400),revokedAt:null,attempts:1,budget:{jobs:1,timeoutSeconds},origin:'native-owner'},executionBinding:binding,reservationId:'budget-1',approverId:owner},now);
 f.sqlite.prepare("INSERT INTO workspace_job_intents(user_id,id,kind,dedupe_key,payload_json,not_before,status,execution_epoch,cancel_requested) VALUES(?,?,'agent.execute',?,?,?,'pending',0,0)").run(owner,intentId,jobId,canonical({jobId,specSha256}),now);
 f.sqlite.prepare('INSERT INTO agent_jobs(user_id,id,row_revision,payload_json,content_hash,intent_id,project_id,task_id,spec_hash,created_at) VALUES(?,?,1,?,?,?,?,?,?,?)').run(owner,jobId,canonical(record),await contentHash(canonical(record)),intentId,'p1','task-1',specSha256,now);
 f.sqlite.prepare("INSERT INTO agent_job_state(user_id,job_id,intent_id,status,operational_revision,spec_hash,task_hash,device_id,approval_id,execution_epoch,updated_at) VALUES(?,?,?,'queued',1,?,?,?,?,0,?)").run(owner,jobId,intentId,specSha256,spec.taskSnapshotSha256,deviceId,'approval-1',now);
 f.sqlite.prepare('INSERT INTO job_approvals(user_id,id,job_id,device_id,spec_hash,binding_hash,payload_json,created_at,expires_at,reserved_seconds) VALUES(?,?,?,?,?,?,?,?,?,?)').run(owner,'approval-1',jobId,deviceId,specSha256,bindingHash,canonical(envelope),now,later(86400),timeoutSeconds);
 f.sqlite.prepare('INSERT INTO agent_budgets(user_id,id,operational_revision,payload_json,maximum_jobs,maximum_seconds,reserved_jobs,reserved_seconds,charged_seconds,enabled,updated_at) VALUES(?,?,1,?,1,600,1,?,0,1,?)').run(owner,'budget-1',canonical({maximumJobs:1,maximumSeconds:600,enabled:true}),timeoutSeconds,now);
 const candidate={deviceId,capabilityHash,bindingHash,budgetId:'budget-1',expiresAt:later(300),binding};
 const context:AgentCommandContext={async taskInputs(){return {};},async state(){return null;},async candidate(){return candidate;},async artifacts(){return [];},async dependencies(){return [];}};
 const options:AgentStoreOptions={now,context};
 return {...f,owner,principal,jobId,intentId,record,binding,capability,context,options};
}
async function claim(f:Awaited<ReturnType<typeof fixture>>,db=f.db){const result=await claimAgentJob(db,f.principal,{jobId:f.jobId,journalNonce:nonce},f.options);assert.ok(result);return result;}
function result(lease:AgentLease):AgentJobResultV1{return agentJobResultSchema.parse({attemptId:lease.attemptId,epoch:lease.executionEpoch,disposition:'succeeded',requestedModel:lease.record.spec.requestedModel,observedModel:lease.record.spec.requestedModel,modelVerified:true,terminalProtocolObserved:true,processExitConfirmed:true,terminationUnconfirmed:false,artifactIds:[],usage:{inputTokens:null,outputTokens:null,runtimeSeconds:null,costDollars:null},diagnostic:'ok'});}
async function proofEvents(lease:AgentLease,value=result(lease)){
 const base={schemaVersion:1 as const,attemptId:lease.attemptId,epoch:lease.executionEpoch,observedAt:later(1),diagnostic:'ok' as const};
 return [
  {...base,sequence:1,kind:'accepted',details:{specSha256:lease.record.specSha256,capabilitySha256:lease.executionBinding.capabilitySha256}},
  {...base,sequence:2,kind:'started',details:{runtimePackageSha256:lease.executionBinding.runtime.packageSha256,toolPolicySha256:lease.executionBinding.runtime.toolPolicySha256,requestedModel:lease.record.spec.requestedModel,observedModel:lease.record.spec.requestedModel}},
  {...base,sequence:3,kind:'process_exit',details:{exitCode:0,processExitConfirmed:true,terminationUnconfirmed:false}},
  {...base,sequence:4,kind:'completed',details:{resultSha256:await contentHash(canonical(value))}}
 ];
}
function count(f:ReturnType<typeof database>,table:string){return f.sqlite.prepare('SELECT COUNT(*) n FROM '+table).get()!.n;}

test('overlapping claims allocate one attempt and slot; same journal retry rotates only that attempt and fixed deadline',async()=>{const f=await fixture();try{
 const outcomes=await Promise.allSettled([claim(f),claim(f)]);assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
 const first=(outcomes.find(x=>x.status==='fulfilled') as PromiseFulfilledResult<AgentLease>).value,retry=await claim(f);
 assert.equal(retry.attemptId,first.attemptId);assert.equal(retry.deadlineAt,first.deadlineAt);assert.notEqual(retry.leaseToken,first.leaseToken);assert.equal(retry.resumed,true);assert.deepEqual(retry.frozenAdmission,first.frozenAdmission);assert.deepEqual(retry.taskInput,first.taskInput);assert.deepEqual(retry.approvalEnvelope,first.approvalEnvelope);assert.equal(retry.serverNow,now);assert.equal(await contentHash(canonical(retry.taskInput)),f.record.spec.taskSnapshotSha256);
 assert.equal(count(f,'job_attempts'),1);assert.equal(count(f,'agent_device_slots'),1);
 assert.notEqual(f.sqlite.prepare('SELECT lease_token_hash FROM job_attempts').get()!.lease_token_hash,retry.leaseToken);
 await assert.rejects(claimAgentJob(f.db,f.principal,{jobId:f.jobId,journalNonce:nonce+'different'},f.options));
 assert.equal(f.sqlite.prepare('SELECT reserved_jobs FROM agent_budgets').get()!.reserved_jobs,1);
}finally{f.sqlite.close();}});
test('committed lost claim response recovers same journal without a second attempt or consumed budget',async()=>{const f=await fixture();try{
 const lost:SqlDatabase={prepare:f.db.prepare.bind(f.db),async batch(s){await f.db.batch(s);throw new Error('synthetic lost response');}};
 await assert.rejects(claim(f,lost));const retry=await claim(f);assert.equal(retry.resumed,true);assert.equal(count(f,'job_attempts'),1);assert.equal(f.sqlite.prepare('SELECT reserved_seconds FROM agent_budgets').get()!.reserved_seconds,120);
}finally{f.sqlite.close();}});
test('both scopes and owner/device identity are mandatory before any claim',async()=>{const f=await fixture();try{
 for(const principal of [{...f.principal,scopes:['jobs:poll']},{...f.principal,ownerId:'foreign-owner'},{...f.principal,deviceId:'foreign-device'}]){
  await assert.rejects(claimAgentJob(f.db,principal as DevicePrincipal,{jobId:f.jobId,journalNonce:nonce},f.options));
 }
 assert.equal(count(f,'job_attempts'),0);assert.equal(f.sqlite.prepare('SELECT consumed_at FROM job_approvals').get()!.consumed_at,null);
}finally{f.sqlite.close();}});
test('grant revocation, restore epoch, slot and task races at batch boundary roll back all claim effects',async()=>{for(const mode of ['revoke','epoch','slot','task','dependency']as const){const f=await fixture();try{
 const db:SqlDatabase={prepare:f.db.prepare.bind(f.db),async batch(s){
  if(mode==='revoke')f.sqlite.prepare('UPDATE device_credentials SET revoked_at=?').run(now);
  if(mode==='epoch')f.sqlite.prepare('UPDATE workspace_execution_state SET epoch=1').run();
  if(mode==='slot')f.sqlite.prepare("INSERT INTO agent_device_slots(user_id,device_id,attempt_id,reserved_at) VALUES(?,?,?,?)").run(f.owner,f.principal.deviceId,'other-attempt',now);
  if(mode==='task')f.sqlite.prepare('UPDATE workspaces SET revision=revision+1').run();
  if(mode==='dependency')f.sqlite.prepare('UPDATE agent_job_state SET operational_revision=operational_revision+1').run();
  return f.db.batch(s);
 }};
 await assert.rejects(claim(f,db));assert.equal(count(f,'job_attempts'),0);assert.equal(f.sqlite.prepare('SELECT consumed_at FROM job_approvals').get()!.consumed_at,null);
 assert.equal(f.sqlite.prepare('SELECT status FROM workspace_job_intents').get()!.status,'pending');assert.equal(count(f,'agent_protocol_claims'),0);
}finally{f.sqlite.close();}}});
test('SQL abort after attempt insertion rolls back consumed approval, queue and slot',async()=>{const f=await fixture();try{
 f.sqlite.exec("CREATE TRIGGER synthetic_fail BEFORE UPDATE ON job_approvals BEGIN SELECT RAISE(ABORT,'synthetic fault'); END");
 await assert.rejects(claim(f));assert.equal(count(f,'job_attempts'),0);assert.equal(count(f,'agent_device_slots'),0);assert.equal(f.sqlite.prepare('SELECT status FROM agent_job_state').get()!.status,'queued');
}finally{f.sqlite.close();}});
test('renewal uses frozen binding beyond capability clock refresh, never extends local deadline; cancellation returns stop-only authority without extending expiry',async()=>{const f=await fixture(600);try{
 let lease=await claim(f);
 for(let second=15;second<=315;second+=15){if(second===300)f.sqlite.prepare('UPDATE agent_capabilities SET revoked_at=?,operational_revision=operational_revision+1').run(later(second));lease=await renewAgentLease(f.db,f.principal,{attemptId:lease.attemptId,leaseToken:lease.leaseToken},{...f.options,now:later(second)});}
 assert.equal(lease.deadlineAt,later(600));assert.equal(lease.leaseExpiresAt,later(375));
 f.sqlite.prepare('UPDATE agent_job_state SET cancel_requested_at=?,cancel_request_id=?').run(later(316),'owner-cancel-id');
 const cancelled=await renewAgentLease(f.db,f.principal,{attemptId:lease.attemptId,leaseToken:lease.leaseToken},{...f.options,now:later(316)});
 assert.deepEqual(cancelled.cancelRequest,{requestId:'owner-cancel-id',requestedAt:later(316)});assert.equal(cancelled.leaseExpiresAt,lease.leaseExpiresAt);assert.equal(cancelled.deadlineAt,lease.deadlineAt);assert.equal(cancelled.operationalRevision,lease.operationalRevision+1);
 await assert.rejects(renewAgentLease(f.db,{...f.principal,deviceId:'foreign-device'},{attemptId:lease.attemptId,leaseToken:lease.leaseToken},{...f.options,now:later(317)}));
 await assert.rejects(renewAgentLease(f.db,f.principal,{attemptId:lease.attemptId,leaseToken:'f'.repeat(64)},{...f.options,now:later(317)}));
 await assert.rejects(renewAgentLease(f.db,f.principal,{attemptId:lease.attemptId,leaseToken:lease.leaseToken},{...f.options,now:later(376)}));
 assert.equal(f.sqlite.prepare('SELECT reserved_seconds FROM agent_budgets').get()!.reserved_seconds,600);
}finally{f.sqlite.close();}});
test('out of order events retain gaps, contiguous replay applies once, changed duplicate is409',async()=>{const f=await fixture();try{
 const lease=await claim(f),events=await proofEvents(lease),send=(values:unknown)=>reportAgentEvents(f.db,f.principal,{attemptId:lease.attemptId,leaseToken:lease.leaseToken,events:values},{...f.options,now:later(2)});
 const gap=await send([events[1]]);assert.equal(gap.lastAppliedSequence,0);assert.equal(f.sqlite.prepare('SELECT launched_at FROM job_attempts').get()!.launched_at,null);
 const fill=await send([events[0]]);assert.equal(fill.lastAppliedSequence,2);assert.notEqual(f.sqlite.prepare('SELECT launched_at FROM job_attempts').get()!.launched_at,null);
 const duplicate=await send([events[1]]);assert.deepEqual(duplicate.receipts,gap.receipts);assert.equal(count(f,'job_events'),2);
 await assert.rejects(send([{...events[1],diagnostic:'unknown'}]),error=>(error as {status?:number}).status===409);
}finally{f.sqlite.close();}});
test('honest started model mismatch is retained without allowing success or inventing exit proof',async()=>{const f=await fixture();try{
 const lease=await claim(f),events=await proofEvents(lease),send=(values:unknown)=>reportAgentEvents(f.db,f.principal,{attemptId:lease.attemptId,leaseToken:lease.leaseToken,events:values},{...f.options,now:later(2)});
 await send([events[0],{...events[1],details:{...events[1].details,observedModel:'different-exact-model'}}]);
 assert.equal(count(f,'job_events'),2);assert.equal(f.sqlite.prepare('SELECT status FROM agent_job_state').get()!.status,'reconcile_required');
 await assert.rejects(completeAgentAttempt(f.db,f.principal,{attemptId:lease.attemptId,leaseToken:lease.leaseToken,result:result(lease)},{...f.options,now:later(3),verifyResult:async()=>({adapterChecksPassed:true})}));
 assert.equal(count(f,'agent_results'),0);assert.equal(f.sqlite.prepare('SELECT released_at FROM agent_device_slots').get()!.released_at,null);
}finally{f.sqlite.close();}});
test('full success atomically records portable result+agents watermark, releases slot, charges unknown time and preserves editor revision',async()=>{const f=await fixture();try{
 const lease=await claim(f),value=result(lease),events=await proofEvents(lease,value);
 await reportAgentEvents(f.db,f.principal,{attemptId:lease.attemptId,leaseToken:lease.leaseToken,events},{...f.options,now:later(3)});
 await assert.rejects(completeAgentAttempt(f.db,f.principal,{attemptId:lease.attemptId,leaseToken:lease.leaseToken,result:value},{...f.options,now:later(4)}));
 const completeOptions={...f.options,now:later(4),verifyResult:async()=>({adapterChecksPassed:true})};
 const terminal=await completeAgentAttempt(f.db,f.principal,{attemptId:lease.attemptId,leaseToken:lease.leaseToken,result:value},completeOptions);
 assert.equal(terminal.result.disposition,'succeeded');assert.equal(count(f,'agent_results'),1);assert.equal(f.sqlite.prepare("SELECT last_sequence FROM operational_stream_heads WHERE stream_id='agents'").get()!.last_sequence,1);assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM audit_events WHERE stream_id='agents'").get()!.n,1);
 assert.equal(f.sqlite.prepare('SELECT revision FROM workspaces').get()!.revision,1);assert.equal(f.sqlite.prepare('SELECT reserved_seconds FROM agent_budgets').get()!.reserved_seconds,0);assert.equal(f.sqlite.prepare('SELECT charged_seconds FROM agent_budgets').get()!.charged_seconds,120);assert.equal(f.sqlite.prepare('SELECT reserved_jobs FROM agent_budgets').get()!.reserved_jobs,1);
 const replay=await completeAgentAttempt(f.db,f.principal,{attemptId:lease.attemptId,leaseToken:lease.leaseToken,result:value},completeOptions);assert.deepEqual(replay,terminal);assert.equal(count(f,'agent_results'),1);
 const lateReplay=await completeAgentAttempt(f.db,f.principal,{attemptId:lease.attemptId,leaseToken:lease.leaseToken,result:value},{...completeOptions,now:later(200)});assert.deepEqual(lateReplay,terminal);assert.equal(count(f,'agent_results'),1);
 await assert.rejects(completeAgentAttempt(f.db,f.principal,{attemptId:lease.attemptId,leaseToken:lease.leaseToken,result:{...value,diagnostic:'unknown'}},completeOptions));
}finally{f.sqlite.close();}});
test('expiry preserves unknown slot+budget, never requeues; no-launch reconciliation requires trusted server proof and is idempotent',async()=>{const f=await fixture();try{
 const lease=await claim(f);assert.equal(await expireAgentAttempts(f.db,f.owner,later(61)),1);assert.equal(f.sqlite.prepare('SELECT status FROM agent_job_state').get()!.status,'reconcile_required');assert.equal(f.sqlite.prepare('SELECT released_at FROM agent_device_slots').get()!.released_at,null);
 assert.equal(f.sqlite.prepare('SELECT reserved_seconds FROM agent_budgets').get()!.reserved_seconds,120);assert.equal(f.sqlite.prepare('SELECT status FROM workspace_job_intents').get()!.status,'running');
 await assert.rejects(claimAgentJob(f.db,f.principal,{jobId:f.jobId,journalNonce:nonce}, {...f.options,now:later(61)}));
 const input={attemptId:lease.attemptId,journalNonce:nonce,proof:'no-launch'};
 await assert.rejects(reconcileAgentAttempt(f.db,f.principal,input,{...f.options,now:later(62)}));
 const opts={...f.options,now:later(62),verifyNoLaunch:async()=>({sql:'1',bindings:[]})};
 assert.deepEqual(await reconcileAgentAttempt(f.db,f.principal,input,opts),{result:null,recordId:null});
 assert.deepEqual(await reconcileAgentAttempt(f.db,f.principal,input,opts),{result:null,recordId:null});
 assert.equal(f.sqlite.prepare('SELECT reserved_jobs FROM agent_budgets').get()!.reserved_jobs,0);assert.equal(f.sqlite.prepare('SELECT reserved_seconds FROM agent_budgets').get()!.reserved_seconds,0);
 assert.equal(count(f,'job_attempts'),1);assert.equal(f.sqlite.prepare('SELECT status FROM workspace_job_intents').get()!.status,'cancelled');
}finally{f.sqlite.close();}});
test('capability private CAS rejects foreign body and stale revision without portable writes',async()=>{const f=await fixture();try{
 await assert.rejects(reportAgentCapability(f.db,f.principal,{capability:{...f.capability,deviceId:'foreign-device'},expectedOperationalRevision:1},{now}));
 await assert.rejects(reportAgentCapability(f.db,f.principal,{capability:f.capability,expectedOperationalRevision:null},{now}));
 const value=await reportAgentCapability(f.db,f.principal,{capability:{...f.capability,observedAt:later(1),expiresAt:later(301)},expectedOperationalRevision:1},{now:later(1)});assert.equal(value.operationalRevision,2);
 assert.equal(count(f,'audit_events'),0);assert.equal(f.sqlite.prepare('SELECT revision FROM workspaces').get()!.revision,1);
}finally{f.sqlite.close();}});

test('late journal exit proof reconciles expired lease without a new attempt or executable queue',async()=>{const f=await fixture();try{
 const lease=await claim(f),value=result(lease),events=await proofEvents(lease,value);
 assert.equal(await expireAgentAttempts(f.db,f.owner,later(61)),1);
 await assert.rejects(reportAgentEvents(f.db,f.principal,{attemptId:lease.attemptId,leaseToken:lease.leaseToken,events},{...f.options,now:later(62)}));
 assert.equal(count(f,'job_events'),0);
 const terminal=await reconcileAgentAttempt(f.db,f.principal,{attemptId:lease.attemptId,journalNonce:nonce,proof:'exited',events,result:value},{...f.options,now:later(63),verifyResult:async()=>({adapterChecksPassed:true})});
 assert.ok('result' in terminal);assert.equal(terminal.result?.disposition,'succeeded');assert.equal(count(f,'job_attempts'),1);assert.equal(count(f,'agent_results'),1);
 assert.equal(f.sqlite.prepare('SELECT status FROM workspace_job_intents').get()!.status,'completed');assert.notEqual(f.sqlite.prepare('SELECT released_at FROM agent_device_slots').get()!.released_at,null);
 assert.equal(f.sqlite.prepare('SELECT charged_seconds FROM agent_budgets').get()!.charged_seconds,120);
}finally{f.sqlite.close();}});

test('actual Miniflare D1 atomically claims, renews, commits 50 ordered events and portable terminal result',async()=>{
 const {Miniflare}=await import('miniflare'),f=await fixture(),mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("synthetic agent store fixture");}}',compatibilityDate:'2026-05-15',d1Databases:['DB'],d1Persist:false,cf:false});
 try{
  const d1=await mf.getD1Database('DB');
  for(const row of f.sqlite.prepare("SELECT sql FROM sqlite_master WHERE type IN ('table','index') AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE WHEN type='table' THEN 0 ELSE 1 END,rowid").all())await d1.prepare(row.sql as string).run();
  const inserts=[d1.prepare('PRAGMA defer_foreign_keys=ON')];
  for(const row of f.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all()){
   const table=row.name as string;
   for(const data of f.sqlite.prepare('SELECT * FROM '+table).all()){
    const keys=Object.keys(data);inserts.push(d1.prepare('INSERT INTO '+table+'('+keys.join(',')+') VALUES('+keys.map(()=>'?').join(',')+')').bind(...Object.values(data)));
   }
  }
  await d1.batch(inserts);const db=d1 as unknown as SqlDatabase;
  const lease=await claim(f,db),renewed=await renewAgentLease(db,f.principal,{attemptId:lease.attemptId,leaseToken:lease.leaseToken},{...f.options,now:later(15)});
  assert.equal(renewed.deadlineAt,lease.deadlineAt);
  const value=result(lease),proof=await proofEvents(lease,value),progress=Array.from({length:48},(_,i)=>({schemaVersion:1,attemptId:lease.attemptId,epoch:lease.executionEpoch,sequence:i+3,observedAt:later(16),diagnostic:'ok',kind:'progress',details:{stage:'executing',completedUnits:i,totalUnits:48}}));
  const first=await reportAgentEvents(db,f.principal,{attemptId:lease.attemptId,leaseToken:lease.leaseToken,events:[proof[0],proof[1],...progress]},{...f.options,now:later(16)});
  assert.equal(first.lastAppliedSequence,50);
  await reportAgentEvents(db,f.principal,{attemptId:lease.attemptId,leaseToken:lease.leaseToken,events:[{...proof[2],sequence:51},{...proof[3],sequence:52}]},{...f.options,now:later(17)});
  // Labelled synthetic trusted verifier exercises SQL admission only, not a live
  // provider, actual process execution, physical artifacts or paid inference.
  const done=await completeAgentAttempt(db,f.principal,{attemptId:lease.attemptId,leaseToken:lease.leaseToken,result:value},{...f.options,now:later(18),verifyResult:async()=>({adapterChecksPassed:true})});
  assert.equal(done.result.disposition,'succeeded');
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM agent_results').first<{n:number}>())!.n,1);
  assert.equal((await db.prepare('SELECT revision FROM workspaces WHERE user_id=?').bind(f.owner).first<{revision:number}>())!.revision,1);
 }finally{await mf.dispose();f.sqlite.close();}
});

test('terminal SQL fault rolls portable result, stream, slot, queue and budget back together',async()=>{const f=await fixture();try{
 const lease=await claim(f),value=result(lease),events=await proofEvents(lease,value);
 await reportAgentEvents(f.db,f.principal,{attemptId:lease.attemptId,leaseToken:lease.leaseToken,events},{...f.options,now:later(3)});
 f.sqlite.exec("CREATE TRIGGER synthetic_terminal_fault BEFORE UPDATE OF result_json ON job_attempts BEGIN SELECT RAISE(ABORT,'synthetic terminal fault'); END");
 await assert.rejects(completeAgentAttempt(f.db,f.principal,{attemptId:lease.attemptId,leaseToken:lease.leaseToken,result:value},{...f.options,now:later(4),verifyResult:async()=>({adapterChecksPassed:true})}));
 assert.equal(count(f,'agent_results'),0);assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM audit_events WHERE stream_id='agents'").get()!.n,0);assert.equal(count(f,'operational_stream_heads'),0);
 assert.equal(f.sqlite.prepare('SELECT released_at FROM agent_device_slots').get()!.released_at,null);assert.equal(f.sqlite.prepare('SELECT result_json FROM job_attempts').get()!.result_json,null);
 assert.equal(f.sqlite.prepare('SELECT reserved_seconds FROM agent_budgets').get()!.reserved_seconds,120);assert.equal(f.sqlite.prepare('SELECT charged_seconds FROM agent_budgets').get()!.charged_seconds,0);assert.equal(f.sqlite.prepare('SELECT status FROM workspace_job_intents').get()!.status,'running');
 assert.equal(count(f,'job_events'),4);assert.equal(count(f,'agent_protocol_claims'),0);
}finally{f.sqlite.close();}});
test('device revocation during trusted result preparation blocks terminal writes and retains unknown resources',async()=>{const f=await fixture();try{
 const lease=await claim(f),value=result(lease),events=await proofEvents(lease,value);
 await reportAgentEvents(f.db,f.principal,{attemptId:lease.attemptId,leaseToken:lease.leaseToken,events},{...f.options,now:later(3)});
 await assert.rejects(completeAgentAttempt(f.db,f.principal,{attemptId:lease.attemptId,leaseToken:lease.leaseToken,result:value},{...f.options,now:later(4),verifyResult:async()=>{f.sqlite.prepare('UPDATE device_credentials SET revoked_at=?').run(later(4));return {adapterChecksPassed:true};}}));
 assert.equal(count(f,'agent_results'),0);assert.equal(f.sqlite.prepare('SELECT released_at FROM agent_device_slots').get()!.released_at,null);assert.equal(f.sqlite.prepare('SELECT reserved_seconds FROM agent_budgets').get()!.reserved_seconds,120);
}finally{f.sqlite.close();}});

test('restore omitting original job/task retains unknown attempt then persists standalone historical exit without recreating planning',async()=>{const f=await fixture();try{
 const lease=await claim(f),value={...result(lease),artifactIds:['purged-original-artifact']},proof=await proofEvents(lease,value);
 const events=[proof[0],proof[1],proof[2],{schemaVersion:1,attemptId:lease.attemptId,epoch:lease.executionEpoch,sequence:4,observedAt:later(2),diagnostic:'ok',kind:'artifact_ready',details:{artifactId:'purged-original-artifact',sha256:sha,bytes:12,type:'text/markdown'}},{...proof[3],sequence:5}];
 // Synthetic explicit restore+fresh credential authority: private old process
 // identity/reservation survives, portable job and old task deliberately do not.
 f.sqlite.prepare('DELETE FROM agent_jobs WHERE user_id=?').run(f.owner);
 f.sqlite.prepare('UPDATE workspaces SET content=?,revision=2,updated_at=? WHERE user_id=?').run(encodePlanning(workspaceFixture()),later(30),f.owner);
 f.sqlite.prepare('UPDATE workspace_execution_state SET epoch=1,restored_at=? WHERE user_id=?').run(later(30),f.owner);
 f.sqlite.prepare('UPDATE device_credentials SET execution_epoch=1 WHERE user_id=?').run(f.owner);
 f.sqlite.prepare('UPDATE device_runtime SET execution_epoch=1 WHERE user_id=?').run(f.owner);
 f.sqlite.prepare("UPDATE workspace_job_intents SET status='cancelled',cancel_requested=1 WHERE user_id=?").run(f.owner);
 assert.equal(await expireAgentAttempts(f.db,f.owner,later(31)),1);
 assert.equal(f.sqlite.prepare('SELECT released_at FROM agent_device_slots').get()!.released_at,null);
 const terminal=await reconcileAgentAttempt(f.db,f.principal,{attemptId:lease.attemptId,journalNonce:nonce,proof:'exited',events,result:value},{...f.options,now:later(32)});
 assert.ok('result' in terminal);assert.equal(terminal.result?.disposition,'succeeded');
 const stored=JSON.parse(f.sqlite.prepare('SELECT payload_json FROM agent_results').get()!.payload_json as string);
 assert.equal(stored.historical,true);assert.deepEqual(stored.result,value);assert.equal(stored.result.artifactIds[0],'purged-original-artifact');assert.equal(count(f,'attachments'),0);assert.equal(f.sqlite.prepare('SELECT status FROM agent_job_state').get()!.status,'blocked');assert.equal(f.sqlite.prepare('SELECT accepted_at FROM agent_job_state').get()!.accepted_at,null);assert.equal(stored.frozenJob.historical,true);assert.equal(stored.frozenJob.specSha256,f.record.specSha256);
 assert.equal(count(f,'agent_jobs'),0);assert.equal(f.sqlite.prepare('SELECT revision FROM workspaces').get()!.revision,2);
 assert.equal(JSON.parse(f.sqlite.prepare('SELECT content FROM workspaces').get()!.content as string).tasks.length,0);
 assert.equal(f.sqlite.prepare('SELECT execution_epoch FROM job_attempts').get()!.execution_epoch,0);assert.equal(count(f,'job_attempts'),1);
 assert.notEqual(f.sqlite.prepare('SELECT released_at FROM agent_device_slots').get()!.released_at,null);assert.equal(f.sqlite.prepare('SELECT reserved_seconds FROM agent_budgets').get()!.reserved_seconds,0);
}finally{f.sqlite.close();}});

test('observed runtime/tool/model mismatch is honest failure data, never success authority',async()=>{
 for(const fault of ['runtime','tool','model','requested']as const)for(const dishonestSuccess of [false,true]){
  const f=await fixture();try{
   const lease=await claim(f),value={...result(lease),disposition:dishonestSuccess?'succeeded' as const:'failed' as const,observedModel:fault==='model'?'different-exact-model':lease.record.spec.requestedModel,modelVerified:fault!=='model',diagnostic:fault==='model'?'model_mismatch' as const:'policy_blocked' as const},events=await proofEvents(lease,value);
   const started={...events[1],details:{...events[1].details,...(fault==='runtime'?{runtimePackageSha256:'c'.repeat(64)}:{}),...(fault==='tool'?{toolPolicySha256:'d'.repeat(64)}:{}),...(fault==='model'?{observedModel:'different-exact-model'}:{}),...(fault==='requested'?{requestedModel:'different-request'}:{})}};
   await reportAgentEvents(f.db,f.principal,{attemptId:lease.attemptId,leaseToken:lease.leaseToken,events:[events[0],started,events[2],events[3]]},{...f.options,now:later(3)});
   assert.equal(f.sqlite.prepare('SELECT status FROM agent_job_state').get()!.status,'reconcile_required');assert.equal(count(f,'job_events'),4);
   const complete=()=>completeAgentAttempt(f.db,f.principal,{attemptId:lease.attemptId,leaseToken:lease.leaseToken,result:value},{...f.options,now:later(4),verifyResult:async()=>({adapterChecksPassed:true})});
   if(dishonestSuccess){await assert.rejects(complete());assert.equal(count(f,'agent_results'),0);assert.equal(f.sqlite.prepare('SELECT released_at FROM agent_device_slots').get()!.released_at,null);}
   else{await complete();assert.equal(f.sqlite.prepare('SELECT status FROM agent_job_state').get()!.status,'failed');assert.equal(count(f,'agent_results'),1);assert.notEqual(f.sqlite.prepare('SELECT released_at FROM agent_device_slots').get()!.released_at,null);}
  }finally{f.sqlite.close();}
 }
});
test('frozen task and approval are returned intact on resume/renew, never rebased after owner text changes',async()=>{const f=await fixture();try{
 const first=await claim(f);assert.equal(await contentHash(canonical(first.taskInput)),f.record.spec.taskSnapshotSha256);
 f.sqlite.prepare('UPDATE workspaces SET revision=revision+1').run();
 const resumed=await claim(f),renewed=await renewAgentLease(f.db,f.principal,{attemptId:resumed.attemptId,leaseToken:resumed.leaseToken},{...f.options,now:later(15)});
 assert.deepEqual(resumed.taskInput,first.taskInput);assert.deepEqual(renewed.taskInput,first.taskInput);assert.deepEqual(renewed.approvalEnvelope,first.approvalEnvelope);assert.deepEqual(renewed.frozenAdmission,first.frozenAdmission);assert.deepEqual(resumed.frozenAdmission,first.frozenAdmission);
 assert.equal(renewed.serverNow,later(15));assert.equal(renewed.deadlineAt,first.deadlineAt);
}finally{f.sqlite.close();}});

test('UTF8 frozen prompt preflight rejects valid owner text without allocating intent, grant or attempt',async()=>{const f=database();try{
 const workspace=workspaceFixture({tasks:[taskFixture('task-1',{notes:'測'.repeat(10000),evidence:'測'.repeat(1000)})]}),owner='synthetic-utf8-owner';
 await loadWorkspace(f.db,owner,()=>workspace,now);
 const before=f.sqlite.prepare('SELECT content,revision FROM workspaces WHERE user_id=?').get(owner)!;
 await assert.rejects(buildAgentJobSpec({operation:'project.inspect',projectId:'p1',taskId:'task-1',repositoryKey:'synthetic-repo',baseCommit:'b'.repeat(40),inputArtifactIds:[],requestedModel:'synthetic-exact-model',effort:'medium',timeoutSeconds:120,outputBytesLimit:2048,dependsOnJobIds:[]},{workspace,workspaceRevision:1,acceptanceInputs:{}}),/task_prompt_bytes_exceeded/);
 for(const table of ['workspace_job_intents','agent_jobs','job_approvals','job_attempts','agent_device_slots'])assert.equal(count(f,table),0);
 const after=f.sqlite.prepare('SELECT content,revision FROM workspaces WHERE user_id=?').get(owner)!;assert.deepEqual({...after},{...before});
 assert.equal(JSON.parse(after.content as string).tasks[0].notes,'測'.repeat(10000));assert.equal(JSON.parse(after.content as string).tasks[0].evidence,'測'.repeat(1000));
}finally{f.sqlite.close();}});

test('first claim freezes actual private admission facts with opaque owner scope and persists them unchanged',async()=>{const f=await fixture();try{
 const lease=await claim(f),ownerKey=await contentHash(f.owner);
 assert.deepEqual(lease.frozenAdmission,{ownerContextHash:ownerKey,jobStatusAtClaim:'queued',activeAttemptsBefore:0,approvalConsumedBefore:false,dependencyRows:[{id:f.jobId,ownerKey,dependsOnJobIds:[],status:'queued'}],artifactRefs:f.binding.artifactRefs});
 assert.equal(JSON.stringify(lease.frozenAdmission).includes(f.owner),false);
 const stored=JSON.parse(f.sqlite.prepare('SELECT identity_json FROM job_attempts').get()!.identity_json as string);assert.deepEqual(stored.frozenAdmission,lease.frozenAdmission);
 assert.ok(new TextEncoder().encode(canonical(lease)).length<=524288);
 await reportAgentEvents(f.db,f.principal,{attemptId:lease.attemptId,leaseToken:lease.leaseToken,events:(await proofEvents(lease)).slice(0,2)},{...f.options,now:later(2)});
 const renewed=await renewAgentLease(f.db,f.principal,{attemptId:lease.attemptId,leaseToken:lease.leaseToken},{...f.options,now:later(15)});
 assert.equal(f.sqlite.prepare('SELECT status FROM agent_job_state').get()!.status,'running');assert.deepEqual(renewed.frozenAdmission,lease.frozenAdmission);
 await assert.rejects(claimAgentJob(f.db,f.principal,{jobId:f.jobId,journalNonce:nonce,frozenAdmission:lease.frozenAdmission},f.options));
}finally{f.sqlite.close();}});
async function addDependency(f:Awaited<ReturnType<typeof fixture>>){
 const id='dependency-1',intentId='dependency-intent',spec={...f.record.spec,dependsOnJobIds:[]},specSha256=await agentJobSpecSha256(spec),record={...f.record,id,intentId,spec,specSha256};
 f.sqlite.prepare("INSERT INTO workspace_job_intents(user_id,id,kind,dedupe_key,payload_json,not_before,status,execution_epoch,cancel_requested) VALUES(?,?,'agent.execute',?,?,?,'completed',0,0)").run(f.owner,intentId,id,canonical({jobId:id,specSha256}),now);
 f.sqlite.prepare('INSERT INTO agent_jobs(user_id,id,row_revision,payload_json,content_hash,intent_id,project_id,task_id,spec_hash,created_at) VALUES(?,?,1,?,?,?,?,?,?,?)').run(f.owner,id,canonical(record),await contentHash(canonical(record)),intentId,'p1','task-1',specSha256,now);
 f.sqlite.prepare("INSERT INTO agent_job_state(user_id,job_id,intent_id,status,operational_revision,spec_hash,task_hash,execution_epoch,updated_at) VALUES(?,?,?,'succeeded',1,?,?,0,?)").run(f.owner,id,intentId,specSha256,spec.taskSnapshotSha256,now);
 const root={...f.record,spec:{...f.record.spec,dependsOnJobIds:[id]}};root.specSha256=await agentJobSpecSha256(root.spec);
 f.sqlite.prepare('UPDATE agent_jobs SET payload_json=?,content_hash=?,spec_hash=? WHERE user_id=? AND id=?').run(canonical(root),await contentHash(canonical(root)),root.specSha256,f.owner,f.jobId);
 f.sqlite.prepare('UPDATE agent_job_state SET spec_hash=? WHERE user_id=? AND job_id=?').run(root.specSha256,f.owner,f.jobId);
 const envelope=JSON.parse(f.sqlite.prepare('SELECT payload_json FROM job_approvals').get()!.payload_json as string);envelope.approval.specSha256=root.specSha256;
 f.sqlite.prepare('UPDATE job_approvals SET payload_json=?,spec_hash=? WHERE user_id=?').run(canonical(envelope),root.specSha256,f.owner);
 f.sqlite.prepare('UPDATE workspace_job_intents SET payload_json=? WHERE user_id=? AND id=?').run(canonical({jobId:f.jobId,specSha256:root.specSha256}),f.owner,f.intentId);
 f.context.dependencies=async()=>[{id,ownerId:f.owner,dependsOnJobIds:[],status:'succeeded'}];
 return id;
}
test('dependency admission uses actual private owner rows and late graph mutation rolls claim back',async()=>{for(const fault of ['none','forged-status','foreign-owner','late-state']as const){const f=await fixture();try{
 const id=await addDependency(f);if(fault==='forged-status')f.sqlite.prepare("UPDATE agent_job_state SET status='failed' WHERE job_id=?").run(id);
 if(fault==='foreign-owner')f.context.dependencies=async()=>[{id,ownerId:'foreign-owner',dependsOnJobIds:[],status:'succeeded'}];
 const db:SqlDatabase=fault==='late-state'?{prepare:f.db.prepare.bind(f.db),async batch(statements){f.sqlite.prepare("UPDATE agent_job_state SET status='failed',operational_revision=operational_revision+1 WHERE job_id=?").run(id);return f.db.batch(statements);}}:f.db;
 if(fault==='none'){const lease=await claim(f,db),row=lease.frozenAdmission.dependencyRows.find(r=>r.id===id);assert.ok(row);assert.equal(row.status,'succeeded');assert.equal(row.ownerKey,await contentHash(f.owner));assert.equal(lease.frozenAdmission.dependencyRows.find(r=>r.id===f.jobId)!.status,'queued');}
 else{await assert.rejects(claim(f,db));assert.equal(count(f,'job_attempts'),0);assert.equal(f.sqlite.prepare('SELECT consumed_at FROM job_approvals').get()!.consumed_at,null);}
}finally{f.sqlite.close();}}});
test('missing slot cannot hide an existing unresolved device attempt during admission',async()=>{const f=await fixture();try{
 f.sqlite.prepare('INSERT INTO job_attempts(user_id,id,job_id,device_id,approval_id,execution_epoch,journal_nonce_hash,lease_token_hash,lease_expires_at,deadline_at,created_at,operational_revision,identity_json) VALUES(?,?,?,?,?,0,?,?,?,?,?,1,?)').run(f.owner,'retained-attempt','detached-old-job',f.principal.deviceId,'old-approval','b'.repeat(64),'c'.repeat(64),later(60),later(120),now,'{}');
 await assert.rejects(claim(f),/active_attempt_requires_reconciliation/);assert.equal(count(f,'job_attempts'),1);assert.equal(count(f,'agent_device_slots'),0);assert.equal(f.sqlite.prepare('SELECT consumed_at FROM job_approvals').get()!.consumed_at,null);
}finally{f.sqlite.close();}});
test('frozen admission is a strict bounded data manifest, not a caller-supplied approval',()=>{
 const ownerContextHash='a'.repeat(64),value={ownerContextHash,jobStatusAtClaim:'queued',activeAttemptsBefore:0,approvalConsumedBefore:false,dependencyRows:[{id:'job',ownerKey:ownerContextHash,dependsOnJobIds:[],status:'queued'}],artifactRefs:[]};
 assert.deepEqual(agentFrozenAdmissionSchema.parse(value),value);
 for(const changed of [{...value,activeAttemptsBefore:1},{...value,approvalConsumedBefore:true},{...value,leaseToken:'private'},{...value,dependencyRows:[{...value.dependencyRows[0],ownerKey:'b'.repeat(64)}]},{...value,dependencyRows:Array.from({length:257},(_,i)=>({...value.dependencyRows[0],id:'job-'+i}))}])assert.throws(()=>agentFrozenAdmissionSchema.parse(changed));
});

test('valid 256-node graph with maximum IDs and eight edges fits frozen admission without shrinking the prompt limit',async()=>{const f=await fixture();try{
 const ids=[f.jobId,...Array.from({length:255},(_,i)=>('dependency-'+i+'-').padEnd(128,'x'))];
 const graph=ids.map((id,i)=>({id,ownerId:f.owner,dependsOnJobIds:ids.slice(i+1,i+9),status:i===0?'queued' as const:'succeeded' as const}));
 for(let i=1;i<ids.length;i++){
  const descriptor=graph[i],intentId='dependency-intent-'+i,spec={...f.record.spec,dependsOnJobIds:descriptor.dependsOnJobIds},specSha256=await agentJobSpecSha256(spec),record={...f.record,id:descriptor.id,intentId,spec,specSha256};
  f.sqlite.prepare("INSERT INTO workspace_job_intents(user_id,id,kind,dedupe_key,payload_json,not_before,status,execution_epoch,cancel_requested) VALUES(?,?,'agent.execute',?,?,?,'completed',0,0)").run(f.owner,intentId,record.id,canonical({jobId:record.id,specSha256}),now);
  f.sqlite.prepare('INSERT INTO agent_jobs(user_id,id,row_revision,payload_json,content_hash,intent_id,project_id,task_id,spec_hash,created_at) VALUES(?,?,1,?,?,?,?,?,?,?)').run(f.owner,record.id,canonical(record),await contentHash(canonical(record)),intentId,'p1','task-1',specSha256,now);
  f.sqlite.prepare("INSERT INTO agent_job_state(user_id,job_id,intent_id,status,operational_revision,spec_hash,task_hash,execution_epoch,updated_at) VALUES(?,?,?,'succeeded',1,?,?,0,?)").run(f.owner,record.id,intentId,specSha256,spec.taskSnapshotSha256,now);
 }
 const root={...f.record,spec:{...f.record.spec,dependsOnJobIds:graph[0].dependsOnJobIds}};root.specSha256=await agentJobSpecSha256(root.spec);
 f.sqlite.prepare('UPDATE agent_jobs SET payload_json=?,content_hash=?,spec_hash=? WHERE user_id=? AND id=?').run(canonical(root),await contentHash(canonical(root)),root.specSha256,f.owner,f.jobId);
 f.sqlite.prepare('UPDATE agent_job_state SET spec_hash=? WHERE user_id=? AND job_id=?').run(root.specSha256,f.owner,f.jobId);
 const envelope=JSON.parse(f.sqlite.prepare('SELECT payload_json FROM job_approvals').get()!.payload_json as string);envelope.approval.specSha256=root.specSha256;
 f.sqlite.prepare('UPDATE job_approvals SET payload_json=?,spec_hash=? WHERE user_id=?').run(canonical(envelope),root.specSha256,f.owner);
 f.sqlite.prepare('UPDATE workspace_job_intents SET payload_json=? WHERE user_id=? AND id=?').run(canonical({jobId:f.jobId,specSha256:root.specSha256}),f.owner,f.intentId);
 f.context.dependencies=async()=>graph.slice(1);
 const lease=await claim(f),manifestBytes=new TextEncoder().encode(canonical(lease.frozenAdmission)).length,responseBytes=new TextEncoder().encode(canonical(lease)).length;
 assert.equal(lease.frozenAdmission.dependencyRows.length,256);assert.ok(manifestBytes>32768);assert.ok(manifestBytes<=393216);assert.ok(responseBytes>65536);assert.ok(responseBytes<=524288);
 assert.equal(lease.executionBinding.budget.inputBytesLimit,32768);assert.equal(count(f,'job_attempts'),1);
 const resumed=await claim(f);assert.deepEqual(resumed.frozenAdmission,lease.frozenAdmission);
}finally{f.sqlite.close();}});


test('nonce recovery batches retain exact event receipts after expiry and terminal commit without granting a lease',async()=>{const f=await fixture();try{
 const lease=await claim(f),value=result(lease),events=await proofEvents(lease,value),options={...f.options,now:later(180)},body={attemptId:lease.attemptId,journalNonce:nonce,proof:'exited',events:events.slice(0,2)};
 await assert.rejects(reconcileAgentAttempt(f.db,f.principal,{...body,journalNonce:'foreign_nonce_000000000000000000000000'},options));
 const first=await reconcileAgentAttempt(f.db,f.principal,body,options);assert.ok('receipts' in first);assert.equal(first.lastAppliedSequence,2);assert.equal(first.receipts.length,2);
 assert.equal(f.sqlite.prepare('SELECT lease_expires_at FROM job_attempts').get()!.lease_expires_at,lease.leaseExpiresAt);assert.equal(count(f,'agent_results'),0);assert.equal(f.sqlite.prepare('SELECT reserved_seconds FROM agent_budgets').get()!.reserved_seconds,120);
 const second=await reconcileAgentAttempt(f.db,f.principal,{...body,events:events.slice(2)},options);assert.ok('receipts' in second);assert.equal(second.lastAppliedSequence,4);
 const done=await reconcileAgentAttempt(f.db,f.principal,{attemptId:lease.attemptId,journalNonce:nonce,proof:'exited',result:value},{...options,verifyResult:async()=>({adapterChecksPassed:true})});assert.ok('result' in done);assert.equal(done.result?.disposition,'succeeded');
 const replay=await reconcileAgentAttempt(f.db,f.principal,body,{...options,now:later(181)});assert.deepEqual(replay,{...first,lastAppliedSequence:4});assert.equal(count(f,'agent_results'),1);
 await assert.rejects(reconcileAgentAttempt(f.db,f.principal,{...body,events:[{...events[0],diagnostic:'unknown'}]},options));
 assert.equal(f.sqlite.prepare('SELECT lease_expires_at FROM job_attempts').get()!.lease_expires_at,lease.leaseExpiresAt);
}finally{f.sqlite.close();}});
