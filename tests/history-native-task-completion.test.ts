import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {workspaceFixture,taskFixture} from './helpers/workspace.ts';
import {loadWorkspace,readCurrent} from '../lib/workspace-store.ts';
import {workspaceHandlers} from '../lib/workspace-handlers.ts';
import {executeWorkspaceCommand} from '../lib/workspace-transaction.ts';
import {issueMutationId} from '../lib/idempotency-retention.ts';
import {nativeCompletedTaskIds} from '../lib/history/native-task-completion.ts';
const now='2026-10-22T12:00:00.000Z',owner='synthetic-task-owner';
test('only exact active native owner done transition accepts a task; restored, legacy and foreign receipts do not',async()=>{const f=database();try{
 await loadWorkspace(f.db,owner,()=>workspaceFixture({tasks:[taskFixture()]}),now);let current=await readCurrent(f.db,owner,now);const id=current.workspace.tasks[0].id;
 const mutationId=await issueMutationId(f.db,owner,now);const saved=await executeWorkspaceCommand(owner,{protocolVersion:1,expectedRevision:current.revision,mutationId,command:{type:'task.update',id,patch:{status:'done'}}},{db:f.db,handlers:workspaceHandlers,now:()=>now});assert.equal(saved.status,'committed');current=await readCurrent(f.db,owner,now);assert.deepEqual([...await nativeCompletedTaskIds(f.db,owner,current.workspace)],[id]);assert.deepEqual([...await nativeCompletedTaskIds(f.db,'foreign',current.workspace)],[]);
 f.sqlite.prepare('INSERT OR REPLACE INTO workspace_execution_state(user_id,epoch,restored_at) VALUES(?,1,?)').run(owner,now);assert.deepEqual([...await nativeCompletedTaskIds(f.db,owner,current.workspace)],[]);f.sqlite.prepare('DELETE FROM workspace_execution_state WHERE user_id=?').run(owner);
 f.sqlite.prepare("UPDATE workspace_mutation_epochs SET status='retired',retired_at=? WHERE user_id=?").run(now,owner);assert.deepEqual([...await nativeCompletedTaskIds(f.db,owner,current.workspace)],[]);assert.equal(current.workspace.tasks.find(task=>task.id===id)!.status,'done');
 }finally{f.sqlite.close();}});
test('imported historical done task and a legacy receipt never become native accepted completion',async()=>{const f=database();try{
 const workspace=workspaceFixture({tasks:[taskFixture()]});workspace.tasks[0].status='done';workspace.tasks[0].completedAt=now;await loadWorkspace(f.db,owner,()=>workspace,now);assert.deepEqual([...await nativeCompletedTaskIds(f.db,owner,(await readCurrent(f.db,owner,now)).workspace)],[]);
 }finally{f.sqlite.close();}});

test('an actual legacy command receipt and later unrelated active native receipt cannot accept historical done work',async()=>{const f=database();try{
 await loadWorkspace(f.db,owner,()=>workspaceFixture({tasks:[taskFixture()]}),now);const legacy=await executeWorkspaceCommand(owner,{protocolVersion:1,expectedRevision:1,mutationId:crypto.randomUUID(),command:{type:'task.update',id:'task-1',patch:{status:'done'}}},{db:f.db,handlers:workspaceHandlers,now:()=>now});assert.equal(legacy.status,'committed');
 await executeWorkspaceCommand(owner,{protocolVersion:1,expectedRevision:2,mutationId:await issueMutationId(f.db,owner,now),command:{type:'workspace.backup'}},{db:f.db,handlers:workspaceHandlers,now:()=>now});assert.deepEqual([...await nativeCompletedTaskIds(f.db,owner,(await readCurrent(f.db,owner,now)).workspace)],[]);
 }finally{f.sqlite.close();}});
test('SQL byte bound rejects oversized eligible audit sets before returning any payload, and pruned receipt becomes unknown',async()=>{const f=database();try{
 await loadWorkspace(f.db,owner,()=>workspaceFixture({tasks:[taskFixture()]}),now);const mutationId=await issueMutationId(f.db,owner,now);await executeWorkspaceCommand(owner,{protocolVersion:1,expectedRevision:1,mutationId,command:{type:'task.update',id:'task-1',patch:{status:'done'}}},{db:f.db,handlers:workspaceHandlers,now:()=>now});const current=(await readCurrent(f.db,owner,now)).workspace;assert.deepEqual([...await nativeCompletedTaskIds(f.db,owner,current)],['task-1']);
 const receipt=f.sqlite.prepare('SELECT * FROM workspace_mutations WHERE user_id=? AND mutation_id=?').get(owner,mutationId)!;f.sqlite.prepare('DELETE FROM workspace_mutations WHERE user_id=? AND mutation_id=?').run(owner,mutationId);assert.deepEqual([...await nativeCompletedTaskIds(f.db,owner,current)],[]);f.sqlite.prepare('INSERT INTO workspace_mutations(user_id,mutation_id,command_hash,revision,committed_at) VALUES(?,?,?,?,?)').run(owner,mutationId,receipt.command_hash,receipt.revision,receipt.committed_at);
 for(let i=0;i<5;i++)f.sqlite.prepare("INSERT INTO audit_events(user_id,event_id,workspace_revision,ordinal,kind,entity_type,entity_id,occurred_at,payload_json,origin,actor_id) VALUES(?,?,2,?,'task.update','task','task-1',?,?,'owner',?)").run(owner,'synthetic-overbound-'+i,100+i,now,' '.repeat(2*1024*1024),owner);
 assert.deepEqual([...await nativeCompletedTaskIds(f.db,owner,current)],[]);
 }finally{f.sqlite.close();}});
