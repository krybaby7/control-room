// Actual isolated Miniflare D1 agent coordinator rehearsal.
// All devices, credential hashes, capability reports, adapter checks and model labels
// are explicitly synthetic fixture dependencies. No subprocess/provider is invoked.
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {createSeedWorkspace} from '../lib/seed.ts';
import {loadWorkspace,readCurrent} from '../lib/workspace-store.ts';
import {executeWorkspaceCommand} from '../lib/workspace-transaction.ts';
import {workspaceHandlers} from '../lib/workspace-handlers.ts';
import {ownerReader} from '../lib/workspace-modules.ts';
import {issueMutationId} from '../lib/idempotency-retention.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {agentCapabilitySchema,agentJobResultSchema,AGENT_LIMITS} from '../lib/agents/contracts.ts';
import {ownerAgentContext,readAgentState} from '../lib/agents/context.ts';
import {claimAgentJob,renewAgentLease,reportAgentEvents,completeAgentAttempt,expireAgentAttempts,reportAgentCapability} from '../lib/agents/store.ts';
import {exportWorkspaceBundle,parseWorkspaceBundle} from '../lib/workspace-export.ts';
import {stageImport} from '../lib/import-staging.ts';
import {readOperationalWatermarks} from '../lib/operational-watermarks.ts';

assert.ok(Number(process.versions.node.split('.')[0])>=24,'Node 24 or newer is required.');
const BASE='2026-10-18T12:00:00.000Z',at=seconds=>new Date(Date.parse(BASE)+seconds*1000).toISOString();
const SHA='a'.repeat(64),MODEL='synthetic-exact-model',NONCE='synthetic_agent_d1_journal_nonce_0000000001';
const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("isolated agents D1 fixture");}}',compatibilityDate:'2026-05-15',d1Databases:['DB'],d1Persist:false,cf:false});
try{
 const native=await mf.getD1Database('DB'),db={prepare:native.prepare.bind(native),async batch(statements){try{return await native.batch(statements);}catch(error){console.error('Actual D1 batch rejected: '+JSON.stringify({statements:statements.length,diagnostic:error instanceof Error?error.message:'unknown'}));throw error;}}},migrations=(await readdir(new URL('../drizzle/',import.meta.url))).filter(name=>/^\d+.*\.sql$/.test(name)).sort();
 for(const name of migrations){const sql=await readFile(new URL('../drizzle/'+name,import.meta.url),'utf8');for(const statement of sql.split('--> statement-breakpoint'))if(statement.trim())await db.prepare(statement.trim()).run();}
 assert.equal((await db.prepare('PRAGMA foreign_keys').first()).foreign_keys,1);
 const count=async(table,owner)=>{assert.match(table,/^[a-z_]+$/);return (await db.prepare('SELECT COUNT(*) n FROM '+table+' WHERE user_id=?').bind(owner).first()).n;};
 function faultBatch(owner){
  return {prepare:db.prepare.bind(db),async batch(statements){
   assert.ok(statements.length>2);
   const fault=db.prepare('INSERT INTO workspace_assertions(user_id,mutation_id,valid) VALUES(?,?,0)').bind(owner,crypto.randomUUID());
   return db.batch([...statements.slice(0,-1),fault,statements.at(-1)]);
  }};
 }
 async function fixture(name,{budgetJobs=4,timeoutSeconds=120,capability=true}={}){
  const owner='synthetic-agents-d1-'+name,deviceId='synthetic-device-'+name,credentialId='synthetic-credential-'+name,budgetId='synthetic-budget-'+name;
  let clock=BASE;await loadWorkspace(db,owner,()=>createSeedWorkspace(BASE),BASE);
  const planning=(await readCurrent(db,owner,clock)).workspace,task=planning.tasks.find(task=>task.status!=='archived'&&planning.projects.some(project=>project.id===task.projectId&&project.archivedAt===null));assert.ok(task);
  // No current owner enrollment command grants execution scopes. Seed only these
  // labelled private fixture credentials; do not describe this as a live installation.
  const display={id:deviceId,label:'Synthetic disabled D1 executor '+name,createdAt:BASE,archivedAt:null},scopes=['jobs:poll','jobs:report'];
  await db.batch([
   db.prepare('INSERT INTO devices(user_id,id,row_revision,payload_json,content_hash,created_at,archived_at) VALUES(?,?,1,?,?,?,NULL)').bind(owner,deviceId,canonical(display),await contentHash(canonical(display)),BASE),
   db.prepare('INSERT INTO device_runtime(user_id,device_id,operational_revision,execution_epoch,current_generation) VALUES(?,?,1,0,0)').bind(owner,deviceId),
   db.prepare('INSERT INTO device_credentials(user_id,id,device_id,token_hash,scopes_json,execution_epoch,created_at,expires_at) VALUES(?,?,?,?,?,0,?,?)').bind(owner,credentialId,deviceId,await contentHash('synthetic-not-a-live-device-token-'+name),canonical(scopes),BASE,at(3600))
  ]);
  const principal={ownerId:owner,deviceId,credentialId,scopes};
  const cap=agentCapabilitySchema.parse({schemaVersion:1,deviceId,configurationSha256:SHA,provider:'codex',runtime:{version:'synthetic-1',sourceCommit:'b'.repeat(40),packageSha256:SHA,toolPolicy:'synthetic-read-only',executableSha256:SHA,executableVersion:'synthetic 1',toolPolicySha256:SHA},operations:['project.inspect'],models:[{id:MODEL,efforts:['medium']}],repositoryKeys:['synthetic-repository'],observedAt:BASE,expiresAt:at(300),maxConcurrent:1,availableSlots:1,maxTimeoutSeconds:600,maxOutputBytesLimit:2048,allowedPathsSha256ByRepositoryKey:{'synthetic-repository':SHA},modelIdentityPolicy:'require-observed',subscriptionOnly:true,extraUsageOffAttested:true});
  if(capability)assert.equal((await reportAgentCapability(db,principal,{capability:cap,expectedOperationalRevision:null},{now:clock})).operationalRevision,1);
  async function execute(command,{retained=null,database=db}={}){
   const before=await readCurrent(db,owner,clock),request=retained??{protocolVersion:1,expectedRevision:before.revision,mutationId:await issueMutationId(db,owner,clock),command};
   const result=await executeWorkspaceCommand(owner,request,{db:database,handlers:workspaceHandlers,now:()=>clock});
   assert.deepEqual((await readCurrent(db,owner,clock)).workspace,before.workspace,'Agent commands must preserve all planning IDs/status/history.');
   return {result,request};
  }
  const budget=await execute({type:'jobs.budget.configure',id:budgetId,expectedOperationalRevision:null,value:{maximumJobs:budgetJobs,maximumSeconds:1200,enabled:true}});assert.equal(budget.result.status,'committed');
  async function create(){
   const before=new Set((await ownerReader(db,owner).list('agent_jobs')).map(row=>row.id));
   const command={type:'jobs.create',value:{operation:'project.inspect',projectId:task.projectId,taskId:task.id,repositoryKey:'synthetic-repository',baseCommit:'b'.repeat(40),inputArtifactIds:[],requestedModel:MODEL,effort:'medium',timeoutSeconds,outputBytesLimit:2048,dependsOnJobIds:[]}};
   const created=await execute(command);assert.equal(created.result.status,'committed');
   const row=(await ownerReader(db,owner).list('agent_jobs')).find(row=>!before.has(row.id));assert.ok(row);
   return {record:JSON.parse(row.payload_json),...created};
  }
  async function approval(record){
   const candidate=await ownerAgentContext(db,owner,clock).candidate(record,deviceId,budgetId);assert.ok(candidate,'Exact synthetic installed capability and explicit finite budget are required.');
   const state=await readAgentState(db,owner,record.id);assert.ok(state);
   return {type:'jobs.approve',id:record.id,expectedOperationalRevision:state.operationalRevision,deviceId,expectedCapabilityHash:candidate.capabilityHash,expectedBindingHash:candidate.bindingHash,budgetId};
  }
  const options=()=>({now:clock,context:ownerAgentContext(db,owner,clock)});
  return {owner,deviceId,credentialId,budgetId,principal,planning,task,cap,execute,create,approval,options,setClock(value){clock=at(value);},get now(){return clock;}};
 }
 async function privateRow(f,table,field,id){assert.match(table,/^[a-z_]+$/);assert.match(field,/^[a-z_]+$/);return db.prepare('SELECT * FROM '+table+' WHERE user_id=? AND '+field+'=?').bind(f.owner,id).first();}
 async function budget(f){return privateRow(f,'agent_budgets','id',f.budgetId);}
 function result(lease){return agentJobResultSchema.parse({attemptId:lease.attemptId,epoch:lease.executionEpoch,disposition:'succeeded',requestedModel:MODEL,observedModel:MODEL,modelVerified:true,terminalProtocolObserved:true,processExitConfirmed:true,terminationUnconfirmed:false,artifactIds:[],usage:{inputTokens:null,outputTokens:null,runtimeSeconds:null,costDollars:null},diagnostic:'ok'});}
 async function events(lease,value=result(lease),observedAt=at(1)){
  const common={schemaVersion:1,attemptId:lease.attemptId,epoch:lease.executionEpoch,observedAt,diagnostic:'ok'};
  return [
   {...common,sequence:1,kind:'accepted',details:{specSha256:lease.record.specSha256,capabilitySha256:lease.executionBinding.capabilitySha256}},
   {...common,sequence:2,kind:'started',details:{runtimePackageSha256:lease.executionBinding.runtime.packageSha256,toolPolicySha256:lease.executionBinding.runtime.toolPolicySha256,requestedModel:MODEL,observedModel:MODEL}},
   {...common,sequence:3,kind:'process_exit',details:{exitCode:0,processExitConfirmed:true,terminationUnconfirmed:false}},
   {...common,sequence:4,kind:'completed',details:{resultSha256:await contentHash(canonical(value))}}
  ];
 }

 const success=await fixture('success'),created=await success.create(),job=created.record;
 assert.equal((await success.execute(created.request.command,{retained:created.request})).result.status,'replayed');
 assert.equal(await count('agent_jobs',success.owner),1);assert.equal(await count('workspace_job_intents',success.owner),1);
 assert.equal((await privateRow(success,'workspace_job_intents','id',job.intentId)).status,'awaiting_approval');
 assert.equal(await ownerAgentContext(db,'synthetic-foreign-owner',BASE).state(job.id),null);
 for(const principal of [{...success.principal,scopes:['jobs:poll']},{...success.principal,ownerId:'synthetic-foreign-owner'},{...success.principal,deviceId:'synthetic-foreign-device'}]){
  await assert.rejects(claimAgentJob(db,principal,{jobId:job.id,journalNonce:NONCE},success.options()));
 }
 assert.equal(await count('job_attempts',success.owner),0);
 const approval=await success.approval(job),beforeApprove=await readCurrent(db,success.owner,BASE),receiptsBefore=await count('workspace_mutations',success.owner),auditBefore=await count('audit_events',success.owner);
 const approvalRequest={protocolVersion:1,expectedRevision:beforeApprove.revision,mutationId:await issueMutationId(db,success.owner,BASE),command:approval};
 await assert.rejects(success.execute(approval,{retained:approvalRequest,database:faultBatch(success.owner)}));
 assert.deepEqual(await readCurrent(db,success.owner,BASE),beforeApprove);assert.equal(await count('workspace_mutations',success.owner),receiptsBefore);assert.equal(await count('audit_events',success.owner),auditBefore);assert.equal(await count('job_approvals',success.owner),0);assert.equal((await budget(success)).reserved_jobs,0);
 assert.equal((await success.execute(approval,{retained:approvalRequest})).result.status,'committed');
 assert.equal((await success.execute(approval,{retained:approvalRequest})).result.status,'replayed');
 assert.equal(await count('job_approvals',success.owner),1);assert.equal((await budget(success)).reserved_jobs,1);assert.equal((await budget(success)).reserved_seconds,120);

 await assert.rejects(claimAgentJob(faultBatch(success.owner),success.principal,{jobId:job.id,journalNonce:NONCE},success.options()));
 assert.equal(await count('job_attempts',success.owner),0);assert.equal(await count('agent_device_slots',success.owner),0);
 assert.equal((await privateRow(success,'job_approvals','job_id',job.id)).consumed_at,null);
 // Hold both *real* SQL batches after their independent reads, then race them.
 // This is a timing dependency, not a fake database result.
 let arrivals=0,release;const ready=new Promise(resolve=>{release=resolve;});
 const racing={prepare:db.prepare.bind(db),async batch(statements){arrivals++;if(arrivals===2)release();await ready;return db.batch(statements);}};
 const claims=await Promise.allSettled([claimAgentJob(racing,success.principal,{jobId:job.id,journalNonce:NONCE},success.options()),claimAgentJob(racing,success.principal,{jobId:job.id,journalNonce:NONCE},success.options())]);
 assert.equal(claims.filter(claim=>claim.status==='fulfilled'&&claim.value).length,1);
 const first=claims.find(claim=>claim.status==='fulfilled'&&claim.value).value;assert.ok(first);
 assert.equal(await count('job_attempts',success.owner),1);assert.equal(await count('agent_device_slots',success.owner),1);
 const lostResponse={prepare:db.prepare.bind(db),async batch(statements){await db.batch(statements);throw new Error('Synthetic committed claim response loss.');}};
 await assert.rejects(claimAgentJob(lostResponse,success.principal,{jobId:job.id,journalNonce:NONCE},success.options()));
 assert.equal(await count('job_attempts',success.owner),1);assert.equal((await budget(success)).reserved_seconds,120);
 let lease=await claimAgentJob(db,success.principal,{jobId:job.id,journalNonce:NONCE},success.options());assert.ok(lease);
 assert.equal(lease.attemptId,first.attemptId);assert.equal(lease.deadlineAt,first.deadlineAt);assert.equal(lease.resumed,true);assert.notEqual(lease.leaseToken,first.leaseToken);
 const storedAttempt=await privateRow(success,'job_attempts','id',lease.attemptId);assert.notEqual(storedAttempt.lease_token_hash,lease.leaseToken);assert.equal(storedAttempt.journal_nonce_hash,await contentHash(NONCE));
 await assert.rejects(claimAgentJob(db,success.principal,{jobId:job.id,journalNonce:NONCE+'different'},success.options()));
 success.setClock(15);
 await assert.rejects(renewAgentLease(db,success.principal,{attemptId:first.attemptId,leaseToken:first.leaseToken},success.options()));
 lease=await renewAgentLease(db,success.principal,{attemptId:lease.attemptId,leaseToken:lease.leaseToken},success.options());
 assert.equal(lease.deadlineAt,at(120));assert.equal(lease.leaseExpiresAt,at(75));
 const eventValues=await events(lease),value=result(lease),sendEvents=values=>reportAgentEvents(db,success.principal,{attemptId:lease.attemptId,leaseToken:lease.leaseToken,events:values},success.options());
 const gap=await sendEvents([eventValues[1]]);assert.equal(gap.lastAppliedSequence,0);
 assert.equal((await privateRow(success,'job_attempts','id',lease.attemptId)).launched_at,null);
 const fill=await sendEvents([eventValues[0]]);assert.equal(fill.lastAppliedSequence,2);
 assert.deepEqual((await sendEvents([eventValues[1]])).receipts,gap.receipts);assert.equal(await count('job_events',success.owner),2);
 await assert.rejects(sendEvents([{...eventValues[1],diagnostic:'unknown'}]),error=>error.status===409);
 const tooMany=Array.from({length:AGENT_LIMITS.eventBatch+1},(_,index)=>({schemaVersion:1,attemptId:lease.attemptId,epoch:lease.executionEpoch,sequence:5+index,observedAt:at(1),diagnostic:'ok',kind:'progress',details:{stage:'executing',completedUnits:index,totalUnits:null}}));
 await assert.rejects(sendEvents(tooMany));assert.equal(await count('job_events',success.owner),2);assert.equal((await privateRow(success,'job_attempts','id',lease.attemptId)).last_applied_sequence,2);
 const terminalInput={attemptId:lease.attemptId,leaseToken:lease.leaseToken,result:value};
 await assert.rejects(completeAgentAttempt(db,success.principal,terminalInput,{...success.options(),verifyResult:async()=>({adapterChecksPassed:true})}));
 assert.equal(await count('agent_results',success.owner),0);
 await sendEvents(eventValues.slice(2));
 const beforeComplete=await readCurrent(db,success.owner,success.now),beforeVector=await readOperationalWatermarks(db,success.owner);
 // This verifier is explicitly a synthetic trusted test dependency. It does
 // not attest to a subprocess, CLI login, paid subscription or actual model.
 const syntheticResultOptions={...success.options(),verifyResult:async()=>({adapterChecksPassed:true})};
 await assert.rejects(completeAgentAttempt(faultBatch(success.owner),success.principal,terminalInput,syntheticResultOptions));
 assert.equal(await count('agent_results',success.owner),0);assert.deepEqual(await readOperationalWatermarks(db,success.owner),beforeVector);assert.deepEqual(await readCurrent(db,success.owner,success.now),beforeComplete);
 assert.equal((await budget(success)).reserved_seconds,120);assert.equal((await privateRow(success,'agent_device_slots','device_id',success.deviceId)).released_at,null);
 const terminal=await completeAgentAttempt(db,success.principal,terminalInput,syntheticResultOptions);
 assert.equal(terminal.result.disposition,'succeeded');assert.equal(await count('agent_results',success.owner),1);
 assert.deepEqual(await completeAgentAttempt(db,success.principal,terminalInput,syntheticResultOptions),terminal);
 await assert.rejects(completeAgentAttempt(db,success.principal,{...terminalInput,result:{...value,diagnostic:'unknown'}},syntheticResultOptions));
 assert.equal((await readCurrent(db,success.owner,success.now)).revision,beforeComplete.revision);assert.deepEqual((await readCurrent(db,success.owner,success.now)).workspace,success.planning);
 assert.equal((await budget(success)).reserved_seconds,0);assert.equal((await budget(success)).charged_seconds,120);assert.equal((await budget(success)).reserved_jobs,1);
 assert.ok((await privateRow(success,'agent_device_slots','device_id',success.deviceId)).released_at);
 assert.equal((await readOperationalWatermarks(db,success.owner)).agents,1);
 const successfulState=await readAgentState(db,success.owner,job.id);
 assert.equal((await success.execute({type:'jobs.accept-result',id:job.id,expectedOperationalRevision:successfulState.operationalRevision,expectedResultHash:await contentHash(canonical(value)),expectedTaskSnapshotSha256:job.spec.taskSnapshotSha256})).result.status,'committed');
 assert.ok((await readAgentState(db,success.owner,job.id)).acceptedAt);assert.deepEqual((await readCurrent(db,success.owner,success.now)).workspace,success.planning);
 const portable=await exportWorkspaceBundle(db,success.owner,{now:()=>success.now});assert.doesNotThrow(()=>parseWorkspaceBundle(portable));assert.equal(portable.modules.agent_jobs.records.length,1);assert.equal(portable.modules.agent_results.records.length,1);
 for(const table of ['job_approvals','job_attempts','agent_capabilities','agent_budgets','agent_device_slots','agent_job_state','agent_protocol_claims','device_credentials','workspace_job_intents'])assert.equal(portable.modules[table],undefined);
 assert.equal(canonical(portable).includes(lease.leaseToken),false);assert.equal(canonical(portable).includes(NONCE),false);

 const revoked=await fixture('revoked'),revokedJob=(await revoked.create()).record;assert.equal((await revoked.execute(await revoked.approval(revokedJob))).result.status,'committed');
 let raced=false;const revokeAtBatch={prepare:db.prepare.bind(db),async batch(statements){if(!raced){raced=true;await db.prepare('UPDATE device_credentials SET revoked_at=? WHERE user_id=? AND id=?').bind(BASE,revoked.owner,revoked.credentialId).run();}return db.batch(statements);}};
 assert.equal(await claimAgentJob(revokeAtBatch,revoked.principal,{jobId:revokedJob.id,journalNonce:NONCE},revoked.options()),null);
 assert.equal(await count('job_attempts',revoked.owner),0);assert.equal((await privateRow(revoked,'job_approvals','job_id',revokedJob.id)).consumed_at,null);assert.equal((await budget(revoked)).reserved_seconds,120);
 await db.prepare('UPDATE device_credentials SET revoked_at=NULL WHERE user_id=? AND id=?').bind(revoked.owner,revoked.credentialId).run(); // Synthetic fixture reset only.
 const revokedLease=await claimAgentJob(db,revoked.principal,{jobId:revokedJob.id,journalNonce:NONCE},revoked.options());assert.ok(revokedLease);
 const device=await ownerReader(db,revoked.owner).get('devices',revoked.deviceId);assert.equal((await revoked.execute({type:'devices.revoke',id:revoked.deviceId,expectedRowRevision:device.row_revision})).result.status,'committed');
 await assert.rejects(renewAgentLease(db,revoked.principal,{attemptId:revokedLease.attemptId,leaseToken:revokedLease.leaseToken},revoked.options()));
 await assert.rejects(reportAgentEvents(db,revoked.principal,{attemptId:revokedLease.attemptId,leaseToken:revokedLease.leaseToken,events:(await events(revokedLease)).slice(0,1)},revoked.options()));
 assert.equal((await privateRow(revoked,'agent_device_slots','device_id',revoked.deviceId)).released_at,null);assert.equal((await budget(revoked)).reserved_seconds,120);

 const unknown=await fixture('unknown'),unknownJob=(await unknown.create()).record;assert.equal((await unknown.execute(await unknown.approval(unknownJob))).result.status,'committed');
 const unknownLease=await claimAgentJob(db,unknown.principal,{jobId:unknownJob.id,journalNonce:NONCE},unknown.options());assert.ok(unknownLease);
 unknown.setClock(2);await reportAgentEvents(db,unknown.principal,{attemptId:unknownLease.attemptId,leaseToken:unknownLease.leaseToken,events:(await events(unknownLease)).slice(0,2)},unknown.options());
 unknown.setClock(61);assert.equal(await expireAgentAttempts(db,unknown.owner,unknown.now),1);assert.equal(await expireAgentAttempts(db,unknown.owner,unknown.now),0);
 assert.equal((await readAgentState(db,unknown.owner,unknownJob.id)).status,'reconcile_required');assert.equal((await privateRow(unknown,'workspace_job_intents','id',unknownJob.intentId)).status,'running');
 assert.equal((await budget(unknown)).reserved_seconds,120);assert.equal((await privateRow(unknown,'agent_device_slots','device_id',unknown.deviceId)).released_at,null);
 await assert.rejects(claimAgentJob(db,unknown.principal,{jobId:unknownJob.id,journalNonce:NONCE},unknown.options()));
 const beforeRestoreAttempt=await privateRow(unknown,'job_attempts','id',unknownLease.attemptId),beforeRestoreEvents=await count('job_events',unknown.owner),beforeRestoreBudget=await budget(unknown);
 const restoreBundle=await exportWorkspaceBundle(db,unknown.owner,{now:()=>unknown.now});const staged=await stageImport(db,unknown.owner,new TextEncoder().encode(JSON.stringify(restoreBundle)),unknown.now);
 const targetRevision=(await readCurrent(db,unknown.owner,unknown.now)).revision,restored=await unknown.execute({type:'workspace.import.commit',importId:staged.id,hash:staged.hash,targetRevision,mode:'replace'});assert.equal(restored.result.status,'committed');
 assert.equal((await readAgentState(db,unknown.owner,unknownJob.id)).status,'reconcile_required');assert.equal(await count('job_attempts',unknown.owner),1);assert.equal(await count('job_events',unknown.owner),beforeRestoreEvents);
 const afterRestoreAttempt=await privateRow(unknown,'job_attempts','id',unknownLease.attemptId);assert.deepEqual(afterRestoreAttempt,beforeRestoreAttempt);
 const afterRestoreBudget=await budget(unknown);assert.equal(afterRestoreBudget.reserved_jobs,beforeRestoreBudget.reserved_jobs);assert.equal(afterRestoreBudget.reserved_seconds,beforeRestoreBudget.reserved_seconds);assert.equal(afterRestoreBudget.charged_seconds,beforeRestoreBudget.charged_seconds);
 assert.equal((await privateRow(unknown,'agent_device_slots','device_id',unknown.deviceId)).released_at,null);
 assert.equal(JSON.parse((await ownerReader(db,unknown.owner).get('agent_jobs',unknownJob.id)).payload_json).historical,true);
 assert.ok((await db.prepare('SELECT epoch FROM workspace_execution_state WHERE user_id=?').bind(unknown.owner).first()).epoch>unknownLease.executionEpoch);
 await assert.rejects(claimAgentJob(db,unknown.principal,{jobId:unknownJob.id,journalNonce:NONCE},unknown.options()));
 assert.equal(await count('agent_results',unknown.owner),0);assert.deepEqual((await readCurrent(db,unknown.owner,unknown.now)).workspace,unknown.planning);

 const limit=await fixture('pending-limit',{capability:false});for(let i=0;i<AGENT_LIMITS.pendingJobs;i++)await limit.create();
 const beforeLimit=await readCurrent(db,limit.owner,limit.now),limitReceipts=await count('workspace_mutations',limit.owner),limitAudit=await count('audit_events',limit.owner);
 await assert.rejects(limit.create());assert.deepEqual(await readCurrent(db,limit.owner,limit.now),beforeLimit);assert.equal(await count('workspace_mutations',limit.owner),limitReceipts);assert.equal(await count('audit_events',limit.owner),limitAudit);
 assert.equal(await count('agent_jobs',limit.owner),AGENT_LIMITS.pendingJobs);assert.equal(await count('workspace_job_intents',limit.owner),AGENT_LIMITS.pendingJobs);assert.equal(await count('job_attempts',limit.owner),0);
 assert.equal((await db.prepare('PRAGMA foreign_key_check').all()).results.length,0);
 assert.equal((await db.prepare('SELECT COUNT(*) n FROM agent_protocol_claims').first()).n,0);assert.equal((await db.prepare('SELECT COUNT(*) n FROM workspace_assertions').first()).n,0);
 console.log(JSON.stringify({environment:'actual-isolated-Miniflare-D1',migrations:migrations.length,syntheticAdapterOnly:true,providerInvoked:false,ownerCommands:['create','budget','approve','accept-result','device-revoke','reviewed-restore'],claimRace:'single-attempt',claimRetry:'same-journal-token-rotation',events:'gaps-dedup-immutable',completion:'ordered-proof-atomic-replay',revocation:'late-guarded',expiry:'unknown-no-requeue',restore:'unknown-retained-old-epoch-fenced',pendingLimit:AGENT_LIMITS.pendingJobs,portable:'historical-data-without-authority'}));
 console.log('PASS actual isolated D1 agents: owner commands, budget, approval, race, lease, ordered events, completion rollback/replay, revocation, expiry, reviewed recovery, portable exclusions and row limits. No live provider/device installation was verified.');
}finally{await mf.dispose();}
