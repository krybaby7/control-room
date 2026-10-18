import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {artifactSeedFixture,artifactNow as now,artifactLater as later} from './fixtures/agent-artifact.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {readCurrent,type SqlDatabase} from '../lib/workspace-store.ts';
import {agentJobResultSchema,type AgentJobResultV1} from '../lib/agents/contracts.ts';
import {buildAgentApprovalEnvelope} from '../lib/agents/policy.ts';
import {claimAgentJob,reportAgentEvents,completeAgentAttempt,renewAgentLease,agentPrivateCapacityGuard,type AgentLease} from '../lib/agents/store.ts';
const nonce='synthetic_journal_capacity_nonce_00000000000001';
type Fixture=Awaited<ReturnType<typeof artifactSeedFixture>>;
function result(lease:AgentLease):AgentJobResultV1{return agentJobResultSchema.parse({attemptId:lease.attemptId,epoch:lease.executionEpoch,disposition:'succeeded',requestedModel:lease.record.spec.requestedModel,observedModel:lease.record.spec.requestedModel,modelVerified:true,terminalProtocolObserved:true,processExitConfirmed:true,terminationUnconfirmed:false,artifactIds:[],usage:{inputTokens:null,outputTokens:null,runtimeSeconds:null,costDollars:null},diagnostic:'ok'});}
async function queue(f:Fixture,index:number){
 if(index===0)return f.jobId;const jobId='synthetic-capacity-job-'+index,intentId='synthetic-capacity-intent-'+index,approvalId='synthetic-capacity-approval-'+index,record={...f.record,id:jobId,intentId};
 const previous=JSON.parse(f.sqlite.prepare('SELECT payload_json FROM job_approvals WHERE user_id=? AND id=?').get(f.owner,'approval-1')!.payload_json as string);
 const envelope=await buildAgentApprovalEnvelope(record.spec,{approval:{...previous.approval,id:approvalId,jobId},executionBinding:f.binding,reservationId:'budget-1',approverId:f.owner},now);
 f.sqlite.prepare("INSERT INTO workspace_job_intents(user_id,id,kind,dedupe_key,payload_json,not_before,status,execution_epoch,cancel_requested) VALUES(?,?,'agent.execute',?,?,?,'pending',0,0)").run(f.owner,intentId,jobId,canonical({jobId,specSha256:record.specSha256}),now);
 f.sqlite.prepare('INSERT INTO agent_jobs(user_id,id,row_revision,payload_json,content_hash,intent_id,project_id,task_id,spec_hash,created_at) VALUES(?,?,1,?,?,?,?,?,?,?)').run(f.owner,jobId,canonical(record),await contentHash(canonical(record)),intentId,'p1','task-1',record.specSha256,now);
 f.sqlite.prepare("INSERT INTO agent_job_state(user_id,job_id,intent_id,status,operational_revision,spec_hash,task_hash,device_id,approval_id,execution_epoch,updated_at) VALUES(?,?,?,'queued',1,?,?,?,?,0,?)").run(f.owner,jobId,intentId,record.specSha256,record.spec.taskSnapshotSha256,f.principal.deviceId,approvalId,now);
 f.sqlite.prepare('INSERT INTO job_approvals(user_id,id,job_id,device_id,spec_hash,binding_hash,payload_json,created_at,expires_at,reserved_seconds) VALUES(?,?,?,?,?,?,?,?,?,?)').run(f.owner,approvalId,jobId,f.principal.deviceId,record.specSha256,envelope.bindingSha256,canonical(envelope),now,envelope.approval.expiresAt,120);
 f.sqlite.prepare('UPDATE agent_budgets SET reserved_jobs=reserved_jobs+1,reserved_seconds=reserved_seconds+120,operational_revision=operational_revision+1 WHERE user_id=?').run(f.owner);return jobId;
}
async function report(db:SqlDatabase,f:Fixture,lease:AgentLease,progress:number){
 const base={schemaVersion:1,attemptId:lease.attemptId,epoch:lease.executionEpoch,observedAt:later(1),diagnostic:'ok'},value=result(lease),events=[
 {...base,sequence:1,kind:'accepted',details:{specSha256:lease.record.specSha256,capabilitySha256:lease.executionBinding.capabilitySha256}},
 {...base,sequence:2,kind:'started',details:{runtimePackageSha256:lease.executionBinding.runtime.packageSha256,toolPolicySha256:lease.executionBinding.runtime.toolPolicySha256,requestedModel:lease.record.spec.requestedModel,observedModel:lease.record.spec.requestedModel}},
 ...Array.from({length:progress},(_,i)=>({...base,sequence:i+3,kind:'progress',details:{stage:'executing',completedUnits:i,totalUnits:progress}})),
 {...base,sequence:progress+3,kind:'process_exit',details:{exitCode:0,processExitConfirmed:true,terminationUnconfirmed:false}},
 {...base,sequence:progress+4,kind:'completed',details:{resultSha256:await contentHash(canonical(value))}}];
 for(let offset=0;offset<events.length;offset+=50)await reportAgentEvents(db,f.principal,{attemptId:lease.attemptId,leaseToken:lease.leaseToken,events:events.slice(offset,offset+50)},{...f.options,now:later(2)});
 return {events,value};
}
async function finish(db:SqlDatabase,f:Fixture,lease:AgentLease,value:AgentJobResultV1){return completeAgentAttempt(db,f.principal,{attemptId:lease.attemptId,leaseToken:lease.leaseToken,result:value},{...f.options,now:later(3),verifyResult:async()=>({adapterChecksPassed:true})});}
async function seedHistory(){
 const f=await artifactSeedFixture();f.sqlite.prepare('UPDATE agent_budgets SET maximum_jobs=12,maximum_seconds=7200,payload_json=? WHERE user_id=?').run(canonical({maximumJobs:12,maximumSeconds:7200,enabled:true}),f.owner);
 for(let index=0;index<4;index++){const jobId=await queue(f,index),lease=await claimAgentJob(f.db,f.principal,{jobId,journalNonce:nonce+index},f.options);assert.ok(lease);const {value}=await report(f.db,f,lease,800);await finish(f.db,f,lease,value);}
 const history=(await f.db.prepare('SELECT * FROM job_events WHERE user_id=? ORDER BY attempt_id,epoch,sequence').bind(f.owner).all()).results;
 assert.ok(new TextEncoder().encode(canonical(history)).length>1800000,'native immutable history must exceed the old whole-table proof bound');
 return f;
}
test('finite private reservation admits terminal reporting after native history crosses1.8MB; actual D1 verifies chunk proofs',{timeout:180000},async()=>{
 const f=await seedHistory(),mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("synthetic journal capacity");}}',compatibilityDate:'2026-05-15',d1Databases:['DB'],d1Persist:false,cf:false});
 try{
  const jobId=await queue(f,4),lease=await claimAgentJob(f.db,f.principal,{jobId,journalNonce:nonce+'4'},f.options);assert.ok(lease);
  const db=await mf.getD1Database('DB') as unknown as SqlDatabase;
  for(const name of (await readdir(new URL('../drizzle/',import.meta.url))).filter(name=>name.endsWith('.sql')).sort())for(const statement of (await readFile(new URL('../drizzle/'+name,import.meta.url),'utf8')).split('--> statement-breakpoint'))if(statement.trim())await db.prepare(statement.trim()).run();
  const tables=f.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row=>String(row.name)).filter(table=>Number(f.sqlite.prepare('SELECT COUNT(*) n FROM "'+table+'"').get()!.n)>0),remaining=new Set(tables),order:string[]=[];
  while(remaining.size){let changed=false;for(const table of [...remaining]){const deps=f.sqlite.prepare('PRAGMA foreign_key_list("'+table+'")').all().map(row=>String(row.table)).filter(parent=>parent!==table&&remaining.has(parent));if(!deps.length){order.push(table);remaining.delete(table);changed=true;}}assert.ok(changed,'fixture FK order must remain closed');}
  for(const table of order){const rows=f.sqlite.prepare('SELECT * FROM "'+table+'"').all();for(let offset=0;offset<rows.length;offset+=32)await db.batch(rows.slice(offset,offset+32).map(row=>{const columns=Object.keys(row);return db.prepare('INSERT INTO "'+table+'"('+columns.map(name=>'"'+name+'"').join(',')+') VALUES('+columns.map(()=>'?').join(',')+')').bind(...columns.map(name=>row[name] as string|number|null));}));}
  const beforePlanning=await readCurrent(db,f.owner,now),renewed=await renewAgentLease(db,f.principal,{attemptId:lease.attemptId,leaseToken:lease.leaseToken},{...f.options,now:later(1)});assert.equal(renewed.attemptId,lease.attemptId);
  const {events,value}=await report(db,f,renewed,10),terminal=await finish(db,f,renewed,value);
  assert.deepEqual(await finish(db,f,renewed,value),terminal);
  await reportAgentEvents(db,f.principal,{attemptId:lease.attemptId,leaseToken:lease.leaseToken,events},{...f.options,now:later(4)});
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM job_events WHERE user_id=? AND attempt_id=?').bind(f.owner,lease.attemptId).first<{n:number}>())!.n,14);
  assert.equal((await db.prepare('SELECT released_at FROM agent_device_slots WHERE user_id=?').bind(f.owner).first<{released_at:string}>())!.released_at,later(3));
  assert.equal((await db.prepare('SELECT reserved_seconds FROM agent_budgets WHERE user_id=?').bind(f.owner).first<{reserved_seconds:number}>())!.reserved_seconds,0);
  const afterPlanning=await readCurrent(db,f.owner,now);assert.deepEqual(afterPlanning.workspace,beforePlanning.workspace);assert.equal(afterPlanning.revision,beforePlanning.revision);
 }finally{await mf.dispose();f.sqlite.close();}
});
test('private growth reservation is owner scoped and a late quota race cannot consume an approval',async()=>{
 const f=await artifactSeedFixture();try{
  const oversized=await agentPrivateCapacityGuard(f.db,f.owner,{growth:[{table:'workspace_mutations',bytes:67108864,rows:1}]});assert.equal(await f.db.prepare('SELECT 1 WHERE '+oversized.sql).bind(...oversized.bindings).first(),null);
  const before=canonical(f.sqlite.prepare('SELECT * FROM agent_budgets WHERE user_id=?').all(f.owner));
  f.sqlite.exec('BEGIN IMMEDIATE');const receipt=f.sqlite.prepare('INSERT INTO workspace_mutations(user_id,mutation_id,command_hash,revision,committed_at) VALUES(?,?,?,?,?)');for(let index=0;index<99999;index++)receipt.run(f.owner,'capacity-native-'+String(index).padStart(8,'0'),'a'.repeat(64),1,now);f.sqlite.exec('COMMIT');
  let batches=0;const raced:SqlDatabase={prepare:sql=>f.db.prepare(sql),async batch(statements){batches++;receipt.run(f.owner,'synthetic-late-private-growth','a'.repeat(64),1,now);return f.db.batch(statements);}};
  await assert.rejects(()=>claimAgentJob(raced,f.principal,{jobId:f.jobId,journalNonce:nonce},f.options));assert.equal(batches,1,'quota race must occur after admission precheck');assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM job_attempts WHERE user_id=?').get(f.owner)!.n,0);assert.equal(f.sqlite.prepare('SELECT consumed_at FROM job_approvals WHERE user_id=?').get(f.owner)!.consumed_at,null);assert.equal(canonical(f.sqlite.prepare('SELECT * FROM agent_budgets WHERE user_id=?').all(f.owner)),before);
 }finally{f.sqlite.close();}
});


test('pending PUT holds are clock independent and fund exact-cap settlement growth',async()=>{
 const f=await artifactSeedFixture();try{
  f.sqlite.prepare('INSERT INTO attachment_upload_attempts(user_id,token,attachment_id,storage_key,created_at,settled_at) VALUES(?,?,?,?,?,NULL)').run(f.owner,'synthetic-pending-token','11111111-1111-4111-8111-111111111111','attachments/synthetic/11111111-1111-4111-8111-111111111111','2000-01-01T00:00:00.000Z');
  const {privateCapacityGuard,PRIVATE_JOURNAL_RESERVATION}=await import('../lib/private-capacity.ts');
  async function allowed(bytes:number,extra:{newPendingPuts?:number;settlingPendingPuts?:number}={}){
   const proof=await privateCapacityGuard(f.db,f.owner,{...extra,growth:[{table:'workspace_mutations',bytes,rows:0}]});
   return (await f.db.prepare('SELECT 1 WHERE '+proof.sql).bind(...proof.bindings).first())!==null;
  }
  let low=0,high=67108864;while(low<high){const mid=Math.ceil((low+high)/2);if(await allowed(mid))low=mid;else high=mid-1;}
  assert.equal(await allowed(low),true);assert.equal(await allowed(low+1),false);
  assert.equal(await allowed(low+PRIVATE_JOURNAL_RESERVATION.pendingPutBytes,{settlingPendingPuts:1}),true);
  assert.equal(await allowed(low+PRIVATE_JOURNAL_RESERVATION.pendingPutBytes+1,{settlingPendingPuts:1}),false);
  assert.equal(await allowed(low,{newPendingPuts:1}),false);
  assert.equal(await allowed(low-PRIVATE_JOURNAL_RESERVATION.pendingPutBytes,{newPendingPuts:1}),true);
  assert.equal(await allowed(0,{settlingPendingPuts:2}),false,'no credit for a missing pending row');
  await assert.rejects(()=>privateCapacityGuard(f.db,f.owner,{newPendingPuts:501}));
  assert.equal(f.sqlite.prepare('SELECT settled_at FROM attachment_upload_attempts WHERE user_id=?').get(f.owner)!.settled_at,null,'capacity quotes never fabricate physical settlement');
 }finally{f.sqlite.close();}
});
