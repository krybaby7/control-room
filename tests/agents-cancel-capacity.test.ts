import test from 'node:test';
import assert from 'node:assert/strict';
import {artifactFixture,artifactNow as now} from './fixtures/agent-artifact.ts';
import {privateCapacityGuard,PRIVATE_JOURNAL_RESERVATION} from '../lib/private-capacity.ts';
import {executeWorkspaceCommand} from '../lib/workspace-transaction.ts';
import {workspaceHandlers} from '../lib/workspace-handlers.ts';
import {readCurrent} from '../lib/workspace-store.ts';
test('first native cancellation spends its reserved rows at the absolute private row quota without releasing unknown execution',{timeout:120000},async()=>{
 const f=await artifactFixture();try{
  async function allowed(epochRows:number){
   const proof=await privateCapacityGuard(f.db,f.owner,{growth:[{table:'workspace_mutations',rows:99000,bytes:0},{table:'workspace_mutation_epochs',rows:epochRows,bytes:0}]});
   return (await f.db.prepare('SELECT 1 WHERE '+proof.sql).bind(...proof.bindings).first())!==null;
  }
  let low=0,high=100000;while(low<high){const middle=Math.ceil((low+high)/2);if(await allowed(middle))low=middle;else high=middle-1;}
  assert.ok(low>98000,'use a real near200k-row retained profile');
  f.sqlite.exec('BEGIN IMMEDIATE');
  try{
   const receipt=f.sqlite.prepare('INSERT INTO workspace_mutations(user_id,mutation_id,command_hash,revision,committed_at) VALUES(?,?,?,?,?)');
   for(let index=0;index<99000;index++)receipt.run(f.owner,'retained-cancel-capacity-'+String(index).padStart(8,'0'),'a'.repeat(64),1,now);
   const epoch=f.sqlite.prepare("INSERT INTO workspace_mutation_epochs(user_id,epoch,status,created_at,retired_at) VALUES(?,?,'retired',?,?)");
   for(let index=0;index<low;index++)epoch.run(f.owner,index.toString(16).padStart(32,'0'),now,now);
   f.sqlite.exec('COMMIT');
  }catch(error){f.sqlite.exec('ROLLBACK');throw error;}
  const ordinary=await privateCapacityGuard(f.db,f.owner,{growth:[{table:'workspace_mutations',bytes:400,rows:1}]});
  assert.equal(await f.db.prepare('SELECT 1 WHERE '+ordinary.sql).bind(...ordinary.bindings).first(),null,'ordinary fresh receipt cannot spend held safety rows');
  const funded=await privateCapacityGuard(f.db,f.owner,{firstCancelAttemptIds:[f.lease.attemptId],growth:[{table:'workspace_mutations',bytes:400,rows:1}]});
  assert.notEqual(await f.db.prepare('SELECT 1 WHERE '+funded.sql).bind(...funded.bindings).first(),null);
  const before=await readCurrent(f.db,f.owner,now),state=f.sqlite.prepare('SELECT operational_revision FROM agent_job_state WHERE user_id=? AND job_id=?').get(f.owner,f.jobId)!,mutationId='funded-first-cancel-000000000001';
  const result=await executeWorkspaceCommand(f.owner,{protocolVersion:1,expectedRevision:before.revision,mutationId,command:{type:'jobs.cancel',id:f.jobId,expectedOperationalRevision:Number(state.operational_revision)}},{db:f.db,handlers:workspaceHandlers,now:()=>now});
  assert.equal(result.status,'committed');
  const after=f.sqlite.prepare('SELECT cancel_request_id,cancel_requested_at,status FROM agent_job_state WHERE user_id=? AND job_id=?').get(f.owner,f.jobId)!;
  assert.equal(after.cancel_request_id,mutationId);assert.equal(after.cancel_requested_at,now);assert.equal(after.status,'cancelling');
  assert.equal(f.sqlite.prepare('SELECT released_at FROM agent_device_slots WHERE user_id=?').get(f.owner)!.released_at,null);
  assert.equal(f.sqlite.prepare('SELECT reserved_seconds FROM agent_budgets WHERE user_id=?').get(f.owner)!.reserved_seconds,120);
  assert.equal(f.sqlite.prepare('SELECT result_json FROM job_attempts WHERE user_id=? AND id=?').get(f.owner,f.lease.attemptId)!.result_json,null);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_mutations WHERE user_id=?').get(f.owner)!.n,99001);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_mutation_epochs WHERE user_id=?').get(f.owner)!.n,low);
  assert.deepEqual((await readCurrent(f.db,f.owner,now)).workspace,before.workspace);
  const replay=await executeWorkspaceCommand(f.owner,{protocolVersion:1,expectedRevision:before.revision,mutationId,command:{type:'jobs.cancel',id:f.jobId,expectedOperationalRevision:Number(state.operational_revision)}},{db:f.db,handlers:workspaceHandlers,now:()=>now});assert.equal(replay.status,'replayed');
  const reused=await privateCapacityGuard(f.db,f.owner,{firstCancelAttemptIds:[f.lease.attemptId],growth:[{table:'workspace_mutations',bytes:400,rows:1}]});
  assert.equal(await f.db.prepare('SELECT 1 WHERE '+reused.sql).bind(...reused.bindings).first(),null,'persisted first cancellation cannot earn another safety credit');
  await assert.rejects(()=>privateCapacityGuard(f.db,f.owner,{firstCancelAttemptIds:[f.lease.attemptId],growth:[{table:'workspace_mutations',bytes:PRIVATE_JOURNAL_RESERVATION.firstCancelBytes+1,rows:1}]}));
 }finally{f.sqlite.close();}
});
