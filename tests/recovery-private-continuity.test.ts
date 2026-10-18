import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {loadWorkspace,type SqlDatabase,type SqlStatement} from '../lib/workspace-store.ts';
import {createSeedWorkspace} from '../lib/seed.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {readOperationalWatermarks} from '../lib/operational-watermarks.ts';
import {agentCapabilitySchema} from '../lib/agents/contracts.ts';
import {buildAgentJobSpec,agentJobSpecSha256,buildAgentExecutionBinding,agentExecutionBindingSha256,buildAgentApprovalEnvelope} from '../lib/agents/policy.ts';
import {parseAuditEvent} from '../lib/audit-events.ts';
import {captureRecoveryPrivateContinuity,validateRecoveryPrivateContinuity,assessPrivateRecoveryContinuity,PRIVATE_CONTINUITY_TABLES,type RecoveryPrivateContinuity} from '../lib/recovery-private-continuity.ts';

const OWNER='synthetic-private-continuity-owner',NOW='2026-10-18T12:00:00.000Z',SHA='a'.repeat(64);
async function fixture(){
 const f=database();await loadWorkspace(f.db,OWNER,()=>createSeedWorkspace(NOW),NOW);
 const sourceContext={workspaceRevision:1,executionEpoch:0,operationalWatermarks:await readOperationalWatermarks(f.db,OWNER)},input={manifestSha256:SHA,ownerContextHash:await contentHash(OWNER),sourceContext};
 return {...f,input,expected:(value:RecoveryPrivateContinuity)=>({...input,sha256:value.sha256,ownerId:OWNER})};
}
async function rehash(value:RecoveryPrivateContinuity){const {sha256,...body}=value;void sha256;return {...body,sha256:await contentHash(canonical(body))};}
test('captures a strict source-bound private candidate without credentials, cursor secret or installation authority',async()=>{
 const f=await fixture();try{
  const before=f.sqlite.prepare('SELECT * FROM workspace_source_namespaces WHERE user_id=?').get(OWNER)!;
  const value=await captureRecoveryPrivateContinuity(f.db,OWNER,f.input,NOW);
  assert.deepEqual(await validateRecoveryPrivateContinuity(value,f.expected(value)),value);
  assert.deepEqual(Object.keys(value.tables),PRIVATE_CONTINUITY_TABLES);
  assert.equal(value.authority,'inspection-only');assert.equal(canonical(value).includes(String(before.cursor_secret)),false);
  assert.equal(Object.hasOwn(value.tables,'device_credentials'),false);assert.equal(Object.hasOwn(value.tables,'agent_capabilities'),false);
  assert.equal(assessPrivateRecoveryContinuity(value).installable,false);
  assert.ok(assessPrivateRecoveryContinuity(value).blockers.includes('source_freeze_unverified'));
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM workspace_source_namespaces WHERE user_id=?').get(OWNER),before);
 }finally{f.sqlite.close();}
});
test('retains retired and legacy mutation fences, purged physical identities and original owner deletion lineage',async()=>{
 const f=await fixture();try{
  const namespace=crypto.randomUUID(),attachmentId=crypto.randomUUID(),key='attachments/'+namespace+'/'+attachmentId;
  f.sqlite.prepare('INSERT INTO attachment_blob_fences(user_id,storage_key,attachment_id,namespace,token,created_at,purged_at) VALUES(?,?,?,?,?,?,?)').run(OWNER,key,attachmentId,namespace,'synthetic-purge-token',NOW,NOW);
  f.sqlite.prepare('INSERT INTO attachment_blob_objects(user_id,storage_key,attachment_id,namespace,bytes,sha256,created_at,verified_at,purged_at) VALUES(?,?,?,?,?,?,?,?,?)').run(OWNER,key,attachmentId,namespace,12,SHA,NOW,NOW,NOW);
  f.sqlite.prepare("INSERT INTO workspace_mutation_epochs(user_id,epoch,status,created_at,retired_at) VALUES(?,?,'retired',?,?)").run(OWNER,'b'.repeat(32),NOW,NOW);
  f.sqlite.prepare('INSERT INTO workspace_mutations(user_id,mutation_id,command_hash,revision,committed_at) VALUES(?,?,?,?,?)').run(OWNER,'legacy-UUID-receipt-retained',SHA,1,NOW);
  const event=parseAuditEvent({id:'synthetic-delete-fence',kind:'entity.delete',entityType:'task',entityId:'removed-original-task',changes:[{path:['tasks'],before:{exists:true,value:{id:'removed-original-task'}},after:{exists:false,value:null}}],origin:'owner',actorId:OWNER,occurredAt:NOW,sourceRef:null,undoOf:null});
  f.sqlite.prepare('INSERT INTO audit_events(user_id,event_id,workspace_revision,ordinal,kind,entity_type,entity_id,occurred_at,payload_json) VALUES(?,?,1,0,?,?,?,?,?)').run(OWNER,event.id,event.kind,event.entityType,event.entityId,NOW,canonical(event));
  const value=await captureRecoveryPrivateContinuity(f.db,OWNER,f.input,NOW);
  assert.equal(value.tables.attachment_blob_fences[0].storage_key,key);assert.equal(value.tables.attachment_blob_objects[0].purged_at,NOW);
  assert.equal(value.tables.workspace_mutation_epochs[0].status,'retired');assert.equal(value.tables.workspace_mutations[0].mutation_id,'legacy-UUID-receipt-retained');
  assert.equal(value.baselineRemovalFences[0].entity_id,'removed-original-task');
  assert.equal(assessPrivateRecoveryContinuity(value).blockers.includes('purged_identity_unverified'),false);
  const damaged=structuredClone(value);damaged.tables.attachment_blob_objects[0].sha256=null;damaged.tables.attachment_blob_objects[0].verified_at=null;
  assert.ok(assessPrivateRecoveryContinuity(await rehash(damaged)).blockers.includes('purged_identity_unverified'));
 }finally{f.sqlite.close();}
});
test('unsettled PUT and unverified purged identity remain explicit blockers, never silently omitted',async()=>{
 const f=await fixture();try{
  const namespace=crypto.randomUUID(),attachmentId=crypto.randomUUID(),key='attachments/'+namespace+'/'+attachmentId;
  f.sqlite.prepare('INSERT INTO attachment_upload_attempts(user_id,token,attachment_id,storage_key,created_at,settled_at) VALUES(?,?,?,?,?,NULL)').run(OWNER,'synthetic-pending-put',attachmentId,key,NOW);
  f.sqlite.prepare('INSERT INTO attachment_blob_objects(user_id,storage_key,attachment_id,namespace,bytes,sha256,created_at,verified_at,purged_at) VALUES(?,?,?,?,?,?,?,NULL,NULL)').run(OWNER,key,attachmentId,namespace,12,null,NOW);
  const value=await captureRecoveryPrivateContinuity(f.db,OWNER,f.input,NOW),assessment=assessPrivateRecoveryContinuity(value);
  assert.equal(value.tables.attachment_upload_attempts.length,1);assert.equal(value.tables.attachment_upload_attempts[0].settled_at,null);
  assert.ok(assessment.blockers.includes('unsettled_upload_attempts'));assert.ok(assessment.blockers.includes('physical_namespace_handoff_unsupported'));assert.equal(assessment.installable,false);
 }finally{f.sqlite.close();}
});
test('trusted manifest/root/source context and unknown private tables cannot be substituted',async()=>{
 const f=await fixture();try{
  const value=await captureRecoveryPrivateContinuity(f.db,OWNER,f.input,NOW);
  for(const expected of [{...f.expected(value),sha256:'f'.repeat(64)},{...f.expected(value),manifestSha256:'f'.repeat(64)},{...f.expected(value),ownerContextHash:'f'.repeat(64)},{...f.expected(value),sourceContext:{...f.input.sourceContext,executionEpoch:1}}])await assert.rejects(validateRecoveryPrivateContinuity(value,expected));
  const changed=structuredClone(value);changed.capturedAt='2026-10-18T13:00:00.000Z';await assert.rejects(validateRecoveryPrivateContinuity(changed,f.expected(value)));
  await assert.rejects(validateRecoveryPrivateContinuity({...value,tables:{...value.tables,device_credentials:[]}},f.expected(value)));
  await assert.rejects(validateRecoveryPrivateContinuity({...value,authority:'install-authority'},f.expected(value)));
 }finally{f.sqlite.close();}
});
test('owner isolation, unsupported private schema and row changes between scans fail closed',async()=>{
 const f=await fixture();try{
  f.sqlite.prepare('INSERT INTO workspace_mutations(user_id,mutation_id,command_hash,revision,committed_at) VALUES(?,?,?,?,?)').run('synthetic-foreign-owner','foreign-mutation',SHA,1,NOW);
  const value=await captureRecoveryPrivateContinuity(f.db,OWNER,f.input,NOW);assert.equal(value.tables.workspace_mutations.length,0);
  let reads=0;
  const raced:SqlDatabase={prepare(sql:string):SqlStatement{
   const statement=f.db.prepare(sql);
   if(!sql.startsWith('SELECT mutation_id,command_hash,revision,committed_at FROM workspace_mutations'))return statement;
   const wrap=(bound:SqlStatement):SqlStatement=>({bind(...values){return wrap(bound.bind(...values));},first:bound.first.bind(bound),run:bound.run.bind(bound),async all<T>(){reads++;if(reads===2)f.sqlite.prepare('INSERT INTO workspace_mutations(user_id,mutation_id,command_hash,revision,committed_at) VALUES(?,?,?,?,?)').run(OWNER,'late-private-mutation',SHA,1,NOW);return bound.all<T>();}});
   return wrap(statement);
  },batch:f.db.batch.bind(f.db)};
  await assert.rejects(captureRecoveryPrivateContinuity(raced,OWNER,f.input,NOW),/rows changed/);
  f.sqlite.exec('ALTER TABLE attachment_upload_attempts ADD COLUMN unsupported_future_authority TEXT');
  await assert.rejects(captureRecoveryPrivateContinuity(f.db,OWNER,f.input,NOW),/Unsupported private continuity table schema/);
 }finally{f.sqlite.close();}
});
test('imported or forged deletion claims cannot become private owner removal fences',async()=>{
 const f=await fixture();try{
  const event=parseAuditEvent({id:'synthetic-forged-delete',kind:'entity.delete',entityType:'task',entityId:'removed-task',changes:[],origin:'migration',actorId:'foreign-owner',occurredAt:NOW,sourceRef:null,undoOf:null});
  f.sqlite.prepare('INSERT INTO audit_events(user_id,event_id,workspace_revision,ordinal,kind,entity_type,entity_id,occurred_at,payload_json) VALUES(?,?,1,0,?,?,?,?,?)').run(OWNER,event.id,event.kind,event.entityType,event.entityId,NOW,canonical(event));
  await assert.rejects(captureRecoveryPrivateContinuity(f.db,OWNER,f.input,NOW),/original owner deletion/);
 }finally{f.sqlite.close();}
});

test('unknown agent journals, ordered event receipts, occupied slots and finite reservations are retained as inert private data',async()=>{
 const f=await fixture();try{
  const task=createSeedWorkspace(NOW).tasks.find(row=>row.status!=='archived')!,deviceId='synthetic-private-device',jobId='synthetic-private-job',attemptId='synthetic-private-attempt',budgetId='synthetic-private-budget',intentId='synthetic-private-intent';
  const cap=agentCapabilitySchema.parse({schemaVersion:1,deviceId,configurationSha256:SHA,provider:'codex',runtime:{version:'synthetic-1',sourceCommit:'b'.repeat(40),packageSha256:SHA,toolPolicy:'synthetic-policy',executableSha256:SHA,executableVersion:'synthetic 1',toolPolicySha256:SHA},operations:['project.inspect'],models:[{id:'synthetic-model',efforts:['medium']}],repositoryKeys:['synthetic-repo'],observedAt:NOW,expiresAt:'2026-10-18T12:05:00.000Z',maxConcurrent:1,availableSlots:1,maxTimeoutSeconds:600,maxOutputBytesLimit:2048,allowedPathsSha256ByRepositoryKey:{'synthetic-repo':SHA},modelIdentityPolicy:'require-observed',subscriptionOnly:true,extraUsageOffAttested:true});
  const spec=await buildAgentJobSpec({operation:'project.inspect',projectId:task.projectId,taskId:task.id,repositoryKey:'synthetic-repo',baseCommit:'b'.repeat(40),inputArtifactIds:[],requestedModel:'synthetic-model',effort:'medium',timeoutSeconds:120,outputBytesLimit:2048,dependsOnJobIds:[]},{workspace:createSeedWorkspace(NOW),workspaceRevision:1,acceptanceInputs:{}});
  const specHash=await agentJobSpecSha256(spec),binding=await buildAgentExecutionBinding(spec,cap,{artifactRefs:[],budget:{jobs:1,timeoutSeconds:120,outputBytesLimit:2048,inputBytesLimit:32768,payment:'subscription-only',costDollars:null},now:NOW}),bindingHash=await agentExecutionBindingSha256(binding);
  const record={id:jobId,intentId,spec,specSha256:specHash,createdAt:NOW,retryOfJobId:null,historical:false},envelope=await buildAgentApprovalEnvelope(spec,{approval:{id:'synthetic-private-approval',jobId,deviceId,specSha256:specHash,capabilitySha256:await contentHash(canonical(cap)),configurationSha256:SHA,taskSnapshotSha256:spec.taskSnapshotSha256,approvedAt:NOW,expiresAt:'2026-10-19T12:00:00.000Z',revokedAt:null,attempts:1,budget:{jobs:1,timeoutSeconds:120},origin:'native-owner'},executionBinding:binding,reservationId:budgetId,approverId:OWNER},NOW);
  f.sqlite.prepare("INSERT INTO workspace_job_intents(user_id,id,kind,dedupe_key,payload_json,not_before,status,execution_epoch,cancel_requested) VALUES(?,?,'agent.execute',?,?,?,'running',0,0)").run(OWNER,intentId,jobId,canonical({jobId,specSha256:specHash}),NOW);
  f.sqlite.prepare('INSERT INTO agent_job_state(user_id,job_id,intent_id,status,operational_revision,spec_hash,task_hash,device_id,approval_id,attempt_id,execution_epoch,updated_at) VALUES(?,?,?,?,2,?,?,?,?,?,0,?)').run(OWNER,jobId,intentId,'running',specHash,spec.taskSnapshotSha256,deviceId,envelope.approval.id,attemptId,NOW);
  f.sqlite.prepare('INSERT INTO job_approvals(user_id,id,job_id,device_id,spec_hash,binding_hash,payload_json,created_at,expires_at,consumed_at,reserved_seconds) VALUES(?,?,?,?,?,?,?,?,?,?,120)').run(OWNER,envelope.approval.id,jobId,deviceId,specHash,bindingHash,canonical(envelope),NOW,envelope.approval.expiresAt,NOW);
  const identity=canonical({record,executionBinding:binding,budgetId});
  f.sqlite.prepare('INSERT INTO job_attempts(user_id,id,job_id,device_id,approval_id,execution_epoch,journal_nonce_hash,lease_token_hash,lease_expires_at,deadline_at,created_at,launched_at,last_applied_sequence,operational_revision,identity_json) VALUES(?,?,?,?,?,0,?,?,?,?,?,?,1,2,?)').run(OWNER,attemptId,jobId,deviceId,envelope.approval.id,SHA,SHA,'2026-10-18T12:01:00.000Z','2026-10-18T12:02:00.000Z',NOW,NOW,identity);
  f.sqlite.prepare('INSERT INTO agent_device_slots(user_id,device_id,attempt_id,reserved_at) VALUES(?,?,?,?)').run(OWNER,deviceId,attemptId,NOW);
  f.sqlite.prepare('INSERT INTO agent_budgets(user_id,id,operational_revision,payload_json,maximum_jobs,maximum_seconds,reserved_jobs,reserved_seconds,charged_seconds,enabled,updated_at) VALUES(?,?,1,?,1,600,1,120,0,1,?)').run(OWNER,budgetId,canonical({maximumJobs:1,maximumSeconds:600,enabled:true}),NOW);
  const event={schemaVersion:1,attemptId,epoch:0,sequence:1,observedAt:NOW,diagnostic:'ok',kind:'accepted',details:{specSha256:specHash,capabilitySha256:await contentHash(canonical(cap))}},eventHash=await contentHash(canonical(event)),receipt={attemptId,epoch:0,sequence:1,payloadSha256:eventHash,receivedAt:NOW};
  f.sqlite.prepare('INSERT INTO job_events(user_id,attempt_id,epoch,sequence,payload_hash,payload_json,receipt_json,received_at,applied_at) VALUES(?,?,0,1,?,?,?,?,?)').run(OWNER,attemptId,eventHash,canonical(event),canonical(receipt),NOW,NOW);
  const value=await captureRecoveryPrivateContinuity(f.db,OWNER,f.input,NOW);
  assert.equal(value.tables.job_attempts[0].identity_json,identity);assert.equal(value.tables.job_attempts[0].journal_nonce_hash,SHA);
  assert.equal(value.tables.job_events[0].receipt_json,canonical(receipt));assert.equal(value.tables.agent_device_slots[0].released_at,null);
  assert.equal(value.tables.agent_budgets[0].reserved_seconds,120);assert.equal(value.tables.agent_budgets[0].charged_seconds,0);
  assert.equal(assessPrivateRecoveryContinuity(value).retainedUnknownAttempts,1);assert.equal(assessPrivateRecoveryContinuity(value).installable,false);
  const damaged=structuredClone(value);damaged.tables.agent_device_slots=[];
  const changed=await rehash(damaged);await assert.rejects(validateRecoveryPrivateContinuity(changed,f.expected(changed)),/retain its occupied slot/);
 }finally{f.sqlite.close();}
});
