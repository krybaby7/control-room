import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {createSeedWorkspace} from '../lib/seed.ts';
import {loadWorkspace,readCurrent,type SqlDatabase} from '../lib/workspace-store.ts';
import {workspaceHandlers} from '../lib/workspace-handlers.ts';
import {executeWorkspaceCommand,type MutationPlan} from '../lib/workspace-transaction.ts';
import type {WorkspaceCommand} from '../lib/workspace-protocol.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {ownerAgentContext,readAgentState} from '../lib/agents/context.ts';
import {agentControlStatements} from '../lib/agents/transaction-controls.ts';
import {agentCapabilitySchema,type AgentJobRecordV1} from '../lib/agents/contracts.ts';
import {measureProspectiveRecoverability} from '../lib/recoverability-snapshot.ts';
import {recoverabilityAssertions,RecoverabilityCapacityError} from '../lib/recoverability-admission.ts';
import {claimAgentJob,reportAgentEvents,completeAgentAttempt,expireAgentAttempts,type AgentLease} from '../lib/agents/store.ts';
import {agentJobResultSchema,type AgentJobResultV1} from '../lib/agents/contracts.ts';
import type {DevicePrincipal} from '../lib/devices/contracts.ts';
const now='2026-10-18T12:00:00.000Z',owner='agent-owner',foreign='agent-foreign',sha='a'.repeat(64),deviceId='synthetic-executor',budgetId='synthetic-budget';
async function fixture(){
 const f=database();await loadWorkspace(f.db,owner,()=>createSeedWorkspace(now),now);await loadWorkspace(f.db,foreign,()=>createSeedWorkspace(now),now);
 const task=(await readCurrent(f.db,owner,now)).workspace.tasks.find(row=>row.status!=='archived')!;
 async function send(command:WorkspaceCommand,db:SqlDatabase=f.db,mutationId=crypto.randomUUID(),revision?:number){return executeWorkspaceCommand(owner,{protocolVersion:1,mutationId,expectedRevision:revision??(await readCurrent(db,owner,now)).revision,command},{db,handlers:workspaceHandlers,now:()=>now});}
 async function budget(){await send({type:'jobs.budget.configure',id:budgetId,expectedOperationalRevision:null,value:{maximumJobs:2,maximumSeconds:240,enabled:true}});}
 async function create(){
  const result=await send({type:'jobs.create',value:{operation:'project.inspect',projectId:task.projectId,taskId:task.id,repositoryKey:'control-room',baseCommit:'b'.repeat(40),inputArtifactIds:[],requestedModel:'gpt-6.1-sol',effort:'high',timeoutSeconds:60,outputBytesLimit:4096,dependsOnJobIds:[]}});
  assert.equal(result.status,'committed');
  const row=f.sqlite.prepare('SELECT payload_json FROM agent_jobs WHERE user_id=? ORDER BY rowid DESC LIMIT 1').get(owner)!;return JSON.parse(String(row.payload_json)) as AgentJobRecordV1;
 }
 async function capability(scopes=['jobs:poll','jobs:report']){
  const display={id:deviceId,label:'Synthetic disabled executor fixture',createdAt:now,archivedAt:null};
  f.sqlite.prepare('INSERT INTO devices(user_id,id,row_revision,payload_json,content_hash,created_at,archived_at) VALUES(?,?,1,?,?,?,NULL)').run(owner,deviceId,canonical(display),await contentHash(canonical(display)),now);
  f.sqlite.prepare('INSERT INTO device_runtime(user_id,device_id,operational_revision,execution_epoch,current_generation,current_boot_id,revoked_at) VALUES(?,?,1,0,1,NULL,NULL)').run(owner,deviceId);
  f.sqlite.prepare('INSERT INTO device_credentials(user_id,id,device_id,token_hash,scopes_json,execution_epoch,created_at,expires_at) VALUES(?,?,?,?,?,0,?,?)').run(owner,'synthetic-exec-credential',deviceId,sha,canonical(scopes),now,'2026-10-19T12:00:00.000Z');
  const cap=agentCapabilitySchema.parse({schemaVersion:1,deviceId,configurationSha256:sha,provider:'codex',runtime:{version:'synthetic-1',sourceCommit:'b'.repeat(40),packageSha256:sha,toolPolicy:'fixed-v1',executableSha256:sha,executableVersion:'synthetic-1',toolPolicySha256:sha},operations:['project.inspect'],models:[{id:'gpt-6.1-sol',efforts:['high']}],repositoryKeys:['control-room'],observedAt:now,expiresAt:'2026-10-18T12:05:00.000Z',maxConcurrent:1,availableSlots:1,maxTimeoutSeconds:600,maxOutputBytesLimit:4096,allowedPathsSha256ByRepositoryKey:{'control-room':sha},modelIdentityPolicy:'require-observed',subscriptionOnly:true,extraUsageOffAttested:true});
  f.sqlite.prepare('INSERT INTO agent_capabilities(user_id,device_id,manifest_hash,payload_json,reported_at,operational_revision,revoked_at) VALUES(?,?,?,?,?,1,NULL)').run(owner,deviceId,await contentHash(canonical(cap)),canonical(cap),now);
 }
 async function approve(job:AgentJobRecordV1,db=f.db){
  const candidate=await ownerAgentContext(db,owner,now).candidate(job,deviceId,budgetId);assert.ok(candidate);
  const state=await readAgentState(db,owner,job.id);assert.ok(state);
  return send({type:'jobs.approve',id:job.id,expectedOperationalRevision:state.operationalRevision,deviceId,expectedCapabilityHash:candidate.capabilityHash,expectedBindingHash:candidate.bindingHash,budgetId},db);
 }
 return {...f,task,send,budget,create,capability,approve};
}

const at=(second:number)=>new Date(Date.parse(now)+second*1000).toISOString();
const principal:DevicePrincipal={ownerId:owner,deviceId,credentialId:'synthetic-exec-credential',scopes:['jobs:poll','jobs:report']};
async function fillLegacy(f:Awaited<ReturnType<typeof fixture>>,length:number){
 const value={text:'x'.repeat(length)};f.sqlite.prepare('INSERT INTO evidence_records(user_id,id,row_revision,payload_json,content_hash,current_version,archived_at) VALUES(?,?,1,?,?,NULL,NULL)').run(owner,'synthetic-near-capacity-legacy',canonical(value),await contentHash(canonical(value)));
}
async function completeProof(f:Awaited<ReturnType<typeof fixture>>,lease:AgentLease){
 const result:AgentJobResultV1=agentJobResultSchema.parse({attemptId:lease.attemptId,epoch:lease.executionEpoch,disposition:'succeeded',requestedModel:lease.record.spec.requestedModel,observedModel:lease.record.spec.requestedModel,modelVerified:true,terminalProtocolObserved:true,processExitConfirmed:true,terminationUnconfirmed:false,artifactIds:[],usage:null,diagnostic:'ok'});
 const base={schemaVersion:1,attemptId:lease.attemptId,epoch:lease.executionEpoch,observedAt:at(1),diagnostic:'ok'};
 await reportAgentEvents(f.db,principal,{attemptId:lease.attemptId,leaseToken:lease.leaseToken,events:[
 {...base,sequence:1,kind:'accepted',details:{specSha256:lease.record.specSha256,capabilitySha256:lease.executionBinding.capabilitySha256}},
 {...base,sequence:2,kind:'started',details:{runtimePackageSha256:lease.executionBinding.runtime.packageSha256,toolPolicySha256:lease.executionBinding.runtime.toolPolicySha256,requestedModel:lease.record.spec.requestedModel,observedModel:lease.record.spec.requestedModel}},
 {...base,sequence:3,kind:'process_exit',details:{exitCode:0,processExitConfirmed:true,terminationUnconfirmed:false}},
 {...base,sequence:4,kind:'completed',details:{resultSha256:await contentHash(canonical(result))}}
 ]},{now:at(2),context:ownerAgentContext(f.db,owner,at(2))});
 return result;
}
test('finite terminal headroom blocks a second owner approval while an existing admitted attempt can persist its exact terminal result',async()=>{
 const f=await fixture();try{
  await f.budget();await f.capability();const first=await f.create();await f.approve(first);const second=await f.create();
  // Synthetic retained legacy metadata models a near-full owner workspace; it is
  // not a provider result and grants no execution or acceptance authority.
  await fillLegacy(f,1_680_000);
  const current=await measureProspectiveRecoverability(f.db,owner,{now}),next=await measureProspectiveRecoverability(f.db,owner,{now,agentTerminalReserveDelta:1});
  assert.equal(current.measurement.allowed,true,JSON.stringify(current.measurement.reasons));
  assert.equal(current.agentTerminalReserveRows!.length,1);
  assert.equal(next.measurement.allowed,false);assert.ok(next.measurement.reasons.some(reason=>reason.scope==='agent-terminal-headroom'));
  const revision=(await readCurrent(f.db,owner,now)).revision,receipts=f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_mutations WHERE user_id=?').get(owner)!.n;
  await assert.rejects(f.approve(second),error=>error instanceof RecoverabilityCapacityError);
  assert.equal((await readCurrent(f.db,owner,now)).revision,revision);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_mutations WHERE user_id=?').get(owner)!.n,receipts);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM job_approvals WHERE user_id=?').get(owner)!.n,1);
  const lease=await claimAgentJob(f.db,principal,{jobId:first.id,journalNonce:'synthetic_recovery_journal_000000000001'},{now,context:ownerAgentContext(f.db,owner,now)});assert.ok(lease);
  const result=await completeProof(f,lease);
  await assert.rejects(completeAgentAttempt(f.db,principal,{attemptId:lease.attemptId,leaseToken:lease.leaseToken,result},{now:at(3),context:ownerAgentContext(f.db,owner,at(3))}),'no server verifier means no successful result authority');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM agent_results').get()!.n,0);
  const finished=await completeAgentAttempt(f.db,principal,{attemptId:lease.attemptId,leaseToken:lease.leaseToken,result},{now:at(3),context:ownerAgentContext(f.db,owner,at(3)),verifyResult:async()=>({adapterChecksPassed:true})});
  assert.equal(finished.result.disposition,'succeeded');assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM agent_results').get()!.n,1);
  assert.equal((await readCurrent(f.db,owner,now)).revision,revision);
  assert.equal((await measureProspectiveRecoverability(f.db,owner,{now})).agentTerminalReserveRows!.length,0);
  assert.equal(f.sqlite.prepare('SELECT reserved_seconds FROM agent_budgets').get()!.reserved_seconds,0);
 }finally{f.sqlite.close();}
});
test('complete active reservation row-set CAS detects late approval growth without any portable or receipt partial effect',async()=>{
 const f=await fixture();try{
  await f.budget();await f.capability();const first=await f.create(),second=await f.create();await f.approve(first);
  const quote=await measureProspectiveRecoverability(f.db,owner,{now}),id=crypto.randomUUID(),before=(await readCurrent(f.db,owner,now)).revision;
  assert.equal(quote.agentTerminalReserveRows!.length,1);
  const state=await readAgentState(f.db,owner,second.id);assert.ok(state);
  // A separately committed private approval growth is deliberately injected
  // without editor revision change to exercise the quote's private boundary.
  f.sqlite.prepare("UPDATE agent_job_state SET status='queued',approval_id='synthetic-concurrent-approval',operational_revision=operational_revision+1 WHERE user_id=? AND job_id=?").run(owner,second.id);
  const assertions=recoverabilityAssertions(f.db,owner,id,quote,'1',[]);
  await assert.rejects(f.db.batch([...assertions,f.db.prepare('UPDATE workspaces SET revision=revision+1 WHERE user_id=?').bind(owner)]));
  assert.equal((await readCurrent(f.db,owner,now)).revision,before);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_assertions').get()!.n,0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM agent_results').get()!.n,0);
  assert.equal((await measureProspectiveRecoverability(f.db,foreign,{now})).agentTerminalReserveRows!.length,0);
 }finally{f.sqlite.close();}
});
test('expired unknown attempts retain terminal reserve across guarded portable recovery and release no slot or budget',async()=>{
 const f=await fixture();try{
  await f.budget();await f.capability();const job=await f.create();await f.approve(job);
  const lease=await claimAgentJob(f.db,principal,{jobId:job.id,journalNonce:'synthetic_unknown_journal_0000000000001'},{now,context:ownerAgentContext(f.db,owner,now)});assert.ok(lease);
  assert.equal(await expireAgentAttempts(f.db,owner,at(61)),1);
  assert.equal((await measureProspectiveRecoverability(f.db,owner,{now:at(61)})).agentTerminalReserveRows!.length,1);
  const before=await readCurrent(f.db,owner,now),plan:MutationPlan={planningAfter:structuredClone(before.workspace),writes:[],events:[],jobs:[],restoreEpoch:true},mutationId=crypto.randomUUID(),token=crypto.randomUUID(),guard=[owner,mutationId,token],gate='EXISTS(SELECT 1 FROM workspace_command_guards WHERE user_id=? AND mutation_id=? AND claim_token=? AND valid=1)';
  const statements=await agentControlStatements(f.db,owner,plan,'workspace.import.commit',gate,guard,at(61),before.workspace);
  await f.db.batch([f.db.prepare('INSERT INTO workspace_command_guards(user_id,mutation_id,claim_token,valid) VALUES(?,?,?,1)').bind(...guard),...statements,f.db.prepare('DELETE FROM workspace_command_guards WHERE user_id=? AND mutation_id=?').bind(owner,mutationId)]);
  const quote=await measureProspectiveRecoverability(f.db,owner,{now:at(61)});assert.equal(quote.agentTerminalReserveRows!.length,1);assert.equal(quote.agentTerminalReserveRows![0].status,'reconcile_required');
  assert.equal(f.sqlite.prepare('SELECT released_at FROM agent_device_slots').get()!.released_at,null);
  assert.equal(f.sqlite.prepare('SELECT reserved_seconds FROM agent_budgets').get()!.reserved_seconds,60);
 }finally{f.sqlite.close();}
});
test('a caller-supplied favorable measurement delta grants no owner command authority',async()=>{
 const f=await fixture();try{
  await f.budget();await f.capability();const job=await f.create();await f.approve(job);
  const quote=await measureProspectiveRecoverability(f.db,owner,{now,agentTerminalReserveDelta:-1});assert.equal(quote.measurement.allowed,true);
  const before=await readCurrent(f.db,owner,now),plan:MutationPlan={planningAfter:before.workspace,writes:[],events:[],jobs:[],agentControls:{action:'cancel',jobId:job.id,expectedOperationalRevision:2,requestId:crypto.randomUUID()}};
  await assert.rejects(agentControlStatements(f.db,owner,plan,'fixture.favorable-quote','1',[],now,before.workspace),/explicit owner command/);
  assert.equal((await readAgentState(f.db,owner,job.id))!.status,'queued');
  assert.equal(f.sqlite.prepare('SELECT reserved_seconds FROM agent_budgets').get()!.reserved_seconds,60);
 }finally{f.sqlite.close();}
});

test('terminal history row ceiling reserves the last slot before admission and permits the matching final result',async()=>{
 const f=await fixture();try{
  await f.budget();await f.capability();const job=await f.create();await f.approve(job);
  const result=agentJobResultSchema.parse({attemptId:'history-attempt',epoch:0,disposition:'blocked',requestedModel:job.spec.requestedModel,observedModel:null,modelVerified:false,terminalProtocolObserved:false,processExitConfirmed:true,terminationUnconfirmed:false,artifactIds:[],usage:null,diagnostic:'policy_blocked'});
  // Historical rows have no current queue, lease, result acceptance or grant.
  for(let index=0;index<499;index++){
   const id='historical-result-'+index,attemptId='historical-attempt-'+index,current={...result,attemptId},value={id,jobId:job.id,attemptId,recordedAt:now,frozenJob:{...job,historical:true},result:current,resultSha256:await contentHash(canonical(current)),historical:true};
   f.sqlite.prepare('INSERT INTO agent_results(user_id,id,row_revision,payload_json,content_hash,job_id,attempt_id,recorded_at,stream_sequence) VALUES(?,?,1,?,?,?,?,?,0)').run(owner,id,canonical(value),await contentHash(canonical(value)),job.id,attemptId,now);
  }
  const quote=await measureProspectiveRecoverability(f.db,owner,{now});assert.equal(quote.measurement.allowed,true,JSON.stringify(quote.measurement.reasons));
  const extra=await measureProspectiveRecoverability(f.db,owner,{now,agentTerminalReserveDelta:1});assert.ok(extra.measurement.reasons.some(reason=>reason.scope==='agent-terminal-history-headroom'&&reason.actual===501));
  const finalResult={...result,attemptId:'last-historical-attempt'},value={id:'last-historical-result',jobId:job.id,attemptId:finalResult.attemptId,recordedAt:now,frozenJob:{...job,historical:true},result:finalResult,resultSha256:await contentHash(canonical(finalResult)),historical:false};
  const finalQuote=await measureProspectiveRecoverability(f.db,owner,{now,agentTerminalReserveDelta:-1,operationalWrites:[{table:'agent_results',value,streamSequence:1}],operationalWatermarksAfter:{...quote.boundaryWatermarks,agents:1}});
  assert.equal(finalQuote.measurement.allowed,true,JSON.stringify(finalQuote.measurement.reasons));
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM agent_results').get()!.n,499,'measurement is read-only and does not insert a claimed terminal result');
 }finally{f.sqlite.close();}
});
