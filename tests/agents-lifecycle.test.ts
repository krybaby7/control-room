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
import {agentTaskSemanticProjection} from '../lib/agents/policy.ts';
const now='2026-10-18T12:00:00.000Z',owner='agent-owner',foreign='agent-foreign',sha='a'.repeat(64),deviceId='synthetic-executor',budgetId='synthetic-budget';
async function fixture(){
 const f=database();await loadWorkspace(f.db,owner,()=>createSeedWorkspace(now),now);await loadWorkspace(f.db,foreign,()=>createSeedWorkspace(now),now);
 const task=(await readCurrent(f.db,owner,now)).workspace.tasks.find(row=>row.status!=='archived')!;
 async function send(command:WorkspaceCommand,db:SqlDatabase=f.db,mutationId=crypto.randomUUID(),revision?:number){return executeWorkspaceCommand(owner,{protocolVersion:1,mutationId,expectedRevision:revision??(await readCurrent(db,owner,now)).revision,command},{db,handlers:workspaceHandlers,now:()=>now});}
 async function budget(){await send({type:'jobs.budget.configure',id:budgetId,expectedOperationalRevision:null,value:{maximumJobs:1,maximumSeconds:120,enabled:true}});}
 async function create(){
  const result=await send({type:'jobs.create',value:{operation:'project.inspect',projectId:task.projectId,taskId:task.id,repositoryKey:'control-room',baseCommit:'b'.repeat(40),inputArtifactIds:[],requestedModel:'gpt-6.1-sol',effort:'high',timeoutSeconds:60,outputBytesLimit:4096,dependsOnJobIds:[]}});
  assert.equal(result.status,'committed');
  const row=f.sqlite.prepare('SELECT payload_json FROM agent_jobs WHERE user_id=? ORDER BY created_at,id DESC LIMIT 1').get(owner)!;return JSON.parse(String(row.payload_json)) as AgentJobRecordV1;
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
test('owner create and approval share one durable queue, one immutable grant and finite reservation; receipt replay reserves once',async()=>{
 const f=await fixture();try{
  await f.budget();await f.capability();const job=await f.create(),planning=canonical((await readCurrent(f.db,owner,now)).workspace);
  assert.equal(f.sqlite.prepare('SELECT status FROM workspace_job_intents WHERE user_id=? AND id=?').get(owner,job.intentId)!.status,'awaiting_approval');
  const candidate=await ownerAgentContext(f.db,owner,now).candidate(job,deviceId,budgetId);assert.ok(candidate);
  const command={type:'jobs.approve' as const,id:job.id,expectedOperationalRevision:1,deviceId,expectedCapabilityHash:candidate.capabilityHash,expectedBindingHash:candidate.bindingHash,budgetId},mutationId=crypto.randomUUID(),revision=(await readCurrent(f.db,owner,now)).revision;
  const first=await f.send(command,f.db,mutationId,revision),replay=await f.send(command,f.db,mutationId,revision);
  assert.equal(first.status,'committed');assert.equal(replay.status,'replayed');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_job_intents WHERE user_id=?').get(owner)!.n,1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM job_approvals WHERE user_id=?').get(owner)!.n,1);
  assert.deepEqual({...f.sqlite.prepare('SELECT reserved_jobs,reserved_seconds,charged_seconds FROM agent_budgets WHERE user_id=?').get(owner)},{reserved_jobs:1,reserved_seconds:60,charged_seconds:0});
  assert.ok(await ownerAgentContext(f.db,owner,now).candidate(job,deviceId,budgetId),'existing reservation remains a valid exact claim quote at the job limit');
  assert.equal(canonical((await readCurrent(f.db,owner,now)).workspace),planning);
  assert.equal(await readAgentState(f.db,foreign,job.id),null);
  await assert.rejects(f.send({...command,expectedOperationalRevision:2}));
 }finally{f.sqlite.close();}
});
test('telemetry capability reports cannot create execution approval authority',async()=>{
 const f=await fixture();try{await f.budget();await f.capability(['telemetry:write']);const job=await f.create();assert.equal(await ownerAgentContext(f.db,owner,now).candidate(job,deviceId,budgetId),null);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM job_approvals').get()!.n,0);}finally{f.sqlite.close();}
});
test('private capability race rolls back approval, receipt and budget reservation together',async()=>{
 const f=await fixture();try{
  await f.budget();await f.capability();const job=await f.create(),before=(await readCurrent(f.db,owner,now)).revision,receipts=f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_mutations WHERE user_id=?').get(owner)!.n;
  let fired=false;const raced:SqlDatabase={...f.db,batch:async statements=>{if(!fired){fired=true;f.sqlite.prepare('UPDATE agent_capabilities SET revoked_at=? WHERE user_id=?').run(now,owner);}return f.db.batch(statements);}};
  await assert.rejects(f.approve(job,raced));
  assert.equal((await readCurrent(f.db,owner,now)).revision,before);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_mutations WHERE user_id=?').get(owner)!.n,receipts);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM job_approvals').get()!.n,0);
  assert.equal(f.sqlite.prepare('SELECT reserved_jobs FROM agent_budgets').get()!.reserved_jobs,0);
 }finally{f.sqlite.close();}
});
test('unlaunched cancellation releases its reservation once, retains immutable grant and cannot be approved again',async()=>{
 const f=await fixture();try{
  await f.budget();await f.capability();const job=await f.create();await f.approve(job);
  const result=await f.send({type:'jobs.cancel',id:job.id,expectedOperationalRevision:2});assert.equal(result.status,'committed');
  const state=await readAgentState(f.db,owner,job.id);assert.equal(state!.status,'cancelled');assert.ok(state!.cancelRequestId);
  assert.deepEqual({...f.sqlite.prepare('SELECT reserved_jobs,reserved_seconds FROM agent_budgets').get()},{reserved_jobs:0,reserved_seconds:0});
  assert.ok(f.sqlite.prepare('SELECT revoked_at FROM job_approvals').get()!.revoked_at);
  await assert.rejects(f.approve(job));
 }finally{f.sqlite.close();}
});
test('active uncertainty cancellation and recovery retain attempt, slot, events and budget',async()=>{
 const f=await fixture();try{
  await f.budget();await f.capability();const job=await f.create();await f.approve(job);
  const approval=String(f.sqlite.prepare('SELECT id FROM job_approvals').get()!.id),attemptId='synthetic-attempt';
  f.sqlite.prepare('INSERT INTO job_attempts(user_id,id,job_id,device_id,approval_id,execution_epoch,journal_nonce_hash,lease_token_hash,lease_expires_at,deadline_at,created_at,launched_at,last_applied_sequence,operational_revision,identity_json) VALUES(?,?,?,?,?,0,?,?,?,?,?,?,0,1,?)').run(owner,attemptId,job.id,deviceId,approval,sha,sha,'2026-10-18T12:01:00.000Z','2026-10-18T12:02:00.000Z',now,now,'{}');
  f.sqlite.prepare('UPDATE agent_job_state SET status=?,attempt_id=? WHERE user_id=? AND job_id=?').run('reconcile_required',attemptId,owner,job.id);
  f.sqlite.prepare('UPDATE job_approvals SET consumed_at=?').run(now);
  f.sqlite.prepare('INSERT INTO agent_device_slots(user_id,device_id,attempt_id,reserved_at) VALUES(?,?,?,?)').run(owner,deviceId,attemptId,now);
  await f.send({type:'jobs.cancel',id:job.id,expectedOperationalRevision:2});
  assert.equal((await readAgentState(f.db,owner,job.id))!.status,'reconcile_required');
  const before=await readCurrent(f.db,owner,now),plan:MutationPlan={planningAfter:structuredClone(before.workspace),writes:[],events:[],jobs:[],restoreEpoch:true},mutationId=crypto.randomUUID(),token=crypto.randomUUID(),guard=[owner,mutationId,token],claim='EXISTS(SELECT 1 FROM workspace_command_guards WHERE user_id=? AND mutation_id=? AND claim_token=? AND valid=1)';
  const statements=await agentControlStatements(f.db,owner,plan,'workspace.import.commit',claim,guard,now,before.workspace);
  await f.db.batch([f.db.prepare('INSERT INTO workspace_command_guards(user_id,mutation_id,claim_token,valid) VALUES(?,?,?,1)').bind(...guard),...statements,f.db.prepare('DELETE FROM workspace_command_guards WHERE user_id=? AND mutation_id=?').bind(owner,mutationId)]);
  assert.equal((await readAgentState(f.db,owner,job.id))!.status,'reconcile_required');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM job_attempts').get()!.n,1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM agent_device_slots WHERE released_at IS NULL').get()!.n,1);
  assert.equal(f.sqlite.prepare('SELECT reserved_seconds FROM agent_budgets').get()!.reserved_seconds,60);
 }finally{f.sqlite.close();}
});
test('accepting a verified result records owner acceptance while leaving task status unchanged',async()=>{
 const f=await fixture();try{
  const job=await f.create(),result={attemptId:'synthetic-verified-result',epoch:0,disposition:'succeeded',requestedModel:'gpt-6.1-sol',observedModel:'gpt-6.1-sol',modelVerified:true,terminalProtocolObserved:true,processExitConfirmed:true,terminationUnconfirmed:false,artifactIds:[],usage:null,diagnostic:'ok'};
  // Synthetic already-verified terminal state: this test exercises owner acceptance,
  // not provider execution, process proof or result admission.
  f.sqlite.prepare("UPDATE agent_job_state SET status='succeeded',result_json=? WHERE user_id=? AND job_id=?").run(canonical(result),owner,job.id);
  const planning=canonical((await readCurrent(f.db,owner,now)).workspace);
  await f.send({type:'jobs.accept-result',id:job.id,expectedOperationalRevision:1,expectedResultHash:await contentHash(canonical(result)),expectedTaskSnapshotSha256:job.spec.taskSnapshotSha256});
  assert.ok((await readAgentState(f.db,owner,job.id))!.acceptedAt);
  assert.equal(canonical((await readCurrent(f.db,owner,now)).workspace),planning);
 }finally{f.sqlite.close();}
});

test('owner approval candidate includes actual task instructions in its input budget and rejects changed task SHA',async()=>{
 const f=await fixture();try{
  await f.budget();await f.capability();const job=await f.create(),context=ownerAgentContext(f.db,owner,now),candidate=await context.candidate(job,deviceId,budgetId);assert.ok(candidate);
  const task=(await readCurrent(f.db,owner,now)).workspace.tasks.find(row=>row.id===job.spec.taskId)!;
  const projection=agentTaskSemanticProjection(task,await context.taskInputs(task.id)),bytes=new TextEncoder().encode(canonical(projection)).byteLength;
  assert.equal(await contentHash(canonical(projection)),job.spec.taskSnapshotSha256);
  assert.equal(candidate.binding.budget.inputBytesLimit,bytes);
  assert.ok(bytes>0);assert.equal(candidate.binding.artifactRefs.length,0);
  await f.send({type:'task.update',id:task.id,patch:{notes:task.notes+' Changed exact owner instructions.'}});
  assert.equal(await ownerAgentContext(f.db,owner,now).candidate(job,deviceId,budgetId),null);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM job_approvals').get()!.n,0);
 }finally{f.sqlite.close();}
});
