import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {workspaceFixture,taskFixture} from './helpers/workspace.ts';
import {loadWorkspace,type SqlDatabase} from '../lib/workspace-store.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import type {DevicePrincipal} from '../lib/devices/contracts.ts';
import type {AgentCommandContext} from '../lib/agents/command-contracts.ts';
import {agentCapabilitySchema,agentJobResultSchema,type AgentJobResultV1} from '../lib/agents/contracts.ts';
import {buildAgentJobSpec,agentJobSpecSha256,buildAgentExecutionBinding,agentExecutionBindingSha256,buildAgentApprovalEnvelope} from '../lib/agents/policy.ts';
import {claimAgentJob,renewAgentLease,reportAgentEvents,completeAgentAttempt,expireAgentAttempts,reconcileAgentAttempt,reportAgentCapability,type AgentLease,type AgentStoreOptions} from '../lib/agents/store.ts';
const now='2026-10-18T12:00:00.000Z',later=(seconds:number)=>new Date(Date.parse(now)+seconds*1000).toISOString(),sha='a'.repeat(64),nonce='synthetic_journal_nonce_0000000000000001';
async function fixture(timeoutSeconds=120){
 const f=database(),owner='synthetic-owner',deviceId='synthetic-device',jobId='synthetic-job',intentId='synthetic-intent';
 const workspace=workspaceFixture({tasks:[taskFixture('task-1')]});await loadWorkspace(f.db,owner,()=>workspace,now);
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
 assert.equal(retry.attemptId,first.attemptId);assert.equal(retry.deadlineAt,first.deadlineAt);assert.notEqual(retry.leaseToken,first.leaseToken);assert.equal(retry.resumed,true);
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
test('renewal uses frozen binding beyond capability clock refresh, never extends local deadline; cancellation and old token deny',async()=>{const f=await fixture(600);try{
 let lease=await claim(f);
 for(let second=15;second<=315;second+=15){if(second===300)f.sqlite.prepare('UPDATE agent_capabilities SET revoked_at=?,operational_revision=operational_revision+1').run(later(second));lease=await renewAgentLease(f.db,f.principal,{attemptId:lease.attemptId,leaseToken:lease.leaseToken},{...f.options,now:later(second)});}
 assert.equal(lease.deadlineAt,later(600));assert.equal(lease.leaseExpiresAt,later(375));
 f.sqlite.prepare('UPDATE agent_job_state SET cancel_requested_at=?,cancel_request_id=?').run(later(316),'owner-cancel-id');
 await assert.rejects(renewAgentLease(f.db,f.principal,{attemptId:lease.attemptId,leaseToken:lease.leaseToken},{...f.options,now:later(316)}));
 assert.equal(f.sqlite.prepare('SELECT reserved_seconds FROM agent_budgets').get()!.reserved_seconds,600);
}finally{f.sqlite.close();}});
test('out of order events retain gaps, contiguous replay applies once, changed duplicate is409',async()=>{const f=await fixture();try{
 const lease=await claim(f),events=await proofEvents(lease),send=(values:unknown)=>reportAgentEvents(f.db,f.principal,{attemptId:lease.attemptId,leaseToken:lease.leaseToken,events:values},{...f.options,now:later(2)});
 const gap=await send([events[1]]);assert.equal(gap.lastAppliedSequence,0);assert.equal(f.sqlite.prepare('SELECT launched_at FROM job_attempts').get()!.launched_at,null);
 const fill=await send([events[0]]);assert.equal(fill.lastAppliedSequence,2);assert.notEqual(f.sqlite.prepare('SELECT launched_at FROM job_attempts').get()!.launched_at,null);
 const duplicate=await send([events[1]]);assert.deepEqual(duplicate.receipts,gap.receipts);assert.equal(count(f,'job_events'),2);
 await assert.rejects(send([{...events[1],diagnostic:'unknown'}]),error=>(error as {status?:number}).status===409);
}finally{f.sqlite.close();}});
test('started runtime/model mismatch and terminal result without actual ordered exit proof never succeed',async()=>{const f=await fixture();try{
 const lease=await claim(f),events=await proofEvents(lease),send=(values:unknown)=>reportAgentEvents(f.db,f.principal,{attemptId:lease.attemptId,leaseToken:lease.leaseToken,events:values},{...f.options,now:later(2)});
 await assert.rejects(send([events[0],{...events[1],details:{...events[1].details,observedModel:'different-exact-model'}}]));
 assert.equal(count(f,'job_events'),0);
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
 assert.equal(terminal.result?.disposition,'succeeded');assert.equal(count(f,'job_attempts'),1);assert.equal(count(f,'agent_results'),1);
 assert.equal(f.sqlite.prepare('SELECT status FROM workspace_job_intents').get()!.status,'completed');assert.notEqual(f.sqlite.prepare('SELECT released_at FROM agent_device_slots').get()!.released_at,null);
 assert.equal(f.sqlite.prepare('SELECT charged_seconds FROM agent_budgets').get()!.charged_seconds,120);
}finally{f.sqlite.close();}});
