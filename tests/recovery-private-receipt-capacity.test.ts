import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {database} from './helpers/sqlite.ts';
import {workspaceFixture} from './helpers/workspace.ts';
import {loadWorkspace} from '../lib/workspace-store.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {readOperationalWatermarks} from '../lib/operational-watermarks.ts';
import {RECEIPT_CAPACITY,receiptCount} from '../lib/workspace-capacity.ts';
import {mutationEpoch} from '../lib/idempotency-retention.ts';
import {captureRecoveryPrivateContinuity,validateRecoveryPrivateContinuity,PRIVATE_CONTINUITY_LIMITS} from '../lib/recovery-private-continuity.ts';
const OWNER='synthetic-receipt-capacity-owner',FOREIGN='synthetic-foreign-receipt-owner',NOW='2026-10-18T12:00:00.000Z',EPOCH='b'.repeat(32),SHA='a'.repeat(64);
function receiptId(index:number){return index<50000?'legacy-capacity-'+String(index).padStart(8,'0'):'m1_'+EPOCH+'_'+index.toString(16).padStart(32,'0');}
test('private inspection captures every receipt at the advertised hard capacity plus epoch and stream head',{timeout:120000},async()=>{
 const f=database();try{
  assert.equal(RECEIPT_CAPACITY.hard,100000,'fixture deliberately exercises the advertised receipt boundary');
  assert.ok(PRIVATE_CONTINUITY_LIMITS.rows>RECEIPT_CAPACITY.hard,'aggregate private rows must leave room for permanent epochs and operational heads');
  await loadWorkspace(f.db,OWNER,()=>workspaceFixture(),NOW);
  const insert=f.sqlite.prepare('INSERT INTO workspace_mutations(user_id,mutation_id,command_hash,revision,committed_at) VALUES(?,?,?,?,?)');
  f.sqlite.exec('BEGIN IMMEDIATE');
  try{
   f.sqlite.prepare("INSERT INTO workspace_mutation_epochs(user_id,epoch,status,created_at,retired_at) VALUES(?,?,'active',?,NULL)").run(OWNER,EPOCH,NOW);
   f.sqlite.prepare('INSERT INTO operational_stream_heads(user_id,stream_id,revision,last_sequence) VALUES(?,?,?,?)').run(OWNER,'sources',7,19);
   f.sqlite.prepare('INSERT INTO workspace_execution_state(user_id,epoch,restored_at) VALUES(?,0,?)').run(OWNER,NOW);
   for(let index=0;index<RECEIPT_CAPACITY.hard;index++)insert.run(OWNER,receiptId(index),SHA,index+1,NOW);
   insert.run(FOREIGN,'foreign-capacity-receipt',SHA,1,NOW);
   f.sqlite.prepare('UPDATE workspaces SET revision=? WHERE user_id=?').run(RECEIPT_CAPACITY.hard,OWNER);
   f.sqlite.exec('COMMIT');
  }catch(error){f.sqlite.exec('ROLLBACK');throw error;}
  assert.equal(await receiptCount(f.db,OWNER),RECEIPT_CAPACITY.hard);
  const sourceContext={workspaceRevision:RECEIPT_CAPACITY.hard,executionEpoch:0,operationalWatermarks:await readOperationalWatermarks(f.db,OWNER)};
  const input={manifestSha256:SHA,ownerContextHash:await contentHash(OWNER),sourceContext};
  const value=await captureRecoveryPrivateContinuity(f.db,OWNER,input,NOW);
  assert.equal(value.authority,'inspection-only');
  const receipts=value.tables.workspace_mutations;assert.equal(receipts.length,100000);
  for(let index=0;index<receipts.length;index++){
   const row=receipts[index];assert.equal(row.mutation_id,receiptId(index));assert.equal(row.command_hash,SHA);assert.equal(row.revision,index+1);assert.equal(row.committed_at,NOW);
   assert.equal(mutationEpoch(row.mutation_id),index<50000?null:EPOCH);
  }
  assert.deepEqual(value.tables.workspace_mutation_epochs,[{epoch:EPOCH,status:'active',created_at:NOW,retired_at:null}]);
  assert.deepEqual(value.tables.operational_stream_heads,[{stream_id:'sources',revision:7,last_sequence:19}]);
  assert.deepEqual(value.sourceContext,sourceContext);
  const serializedBytes=new TextEncoder().encode(canonical(value)).byteLength;assert.ok(serializedBytes>16000000,'exercise an actual multi-megabyte receipt collection');assert.ok(serializedBytes<=PRIVATE_CONTINUITY_LIMITS.bytes);
  const checked=await validateRecoveryPrivateContinuity(value,{...input,sha256:value.sha256,ownerId:OWNER});
  assert.equal(checked.tables.workspace_mutations.length,100000);
  // Compare the complete captured identities/bodies with the unchanged database,
  // rather than checking only the first/last receipt or a count.
  const capturedHash=createHash('sha256'),sourceHash=createHash('sha256');
  for(const row of checked.tables.workspace_mutations)capturedHash.update(canonical(row)+'\n');
  for(const row of f.sqlite.prepare('SELECT mutation_id,command_hash,revision,committed_at FROM workspace_mutations WHERE user_id=? ORDER BY mutation_id').iterate(OWNER))sourceHash.update(canonical(row)+'\n');
  assert.equal(capturedHash.digest('hex'),sourceHash.digest('hex'));
  assert.equal(await receiptCount(f.db,OWNER),100000);assert.equal(await receiptCount(f.db,FOREIGN),1);
  assert.equal(checked.tables.workspace_mutations.some(row=>row.mutation_id==='foreign-capacity-receipt'),false);
  assert.deepEqual({...f.sqlite.prepare('SELECT stream_id,revision,last_sequence FROM operational_stream_heads WHERE user_id=?').get(OWNER)},{stream_id:'sources',revision:7,last_sequence:19});
 }finally{f.sqlite.close();}
});
