import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeedWorkspace } from '../lib/seed.ts';
import { parsePlanningImport } from '../lib/workspace-codec.ts';
import { previewEntityDeletion, entityDeleteHandler } from '../lib/workspace-deletion.ts';
import type { PrepareContext } from '../lib/workspace-transaction.ts';
import type { Workspace } from '../lib/types.ts';
const at='2026-10-17T12:00:00.000Z';
function seed(){const workspace=parsePlanningImport(createSeedWorkspace(at));workspace.tasks[0]={...workspace.tasks[0],status:'archived',archivedFromStatus:'todo',weekly:false};for(const task of workspace.tasks)task.dependsOn=[];for(const capture of workspace.captures)capture.convertedTaskId=null;return workspace;}
async function context(workspace:Workspace,kind:'task'|'capture'='task',id=workspace.tasks[0].id):Promise<PrepareContext>{const preview=await previewEntityDeletion(workspace,kind,id,9);return {userId:'owner',before:{workspace,revision:9,updatedAt:at},command:{type:'entity.delete',entityType:kind,id,previewHash:preview.previewHash,targetRevision:9},now:at,query:{async get(){return null;},async list(){return [];}},async readImport(){throw new Error('Not an import');}};}
test('archived deletion reduces counts and bytes, requests backup, and preserves exact history in owner event',async()=>{
  const workspace=seed(),original=structuredClone(workspace);const preview=await previewEntityDeletion(workspace,'task',workspace.tasks[0].id,9);
  assert.equal(preview.canDelete,true);assert.equal(preview.afterCounts.tasks,preview.beforeCounts.tasks-1);assert.ok(preview.contentBytesRemoved>0);
  const plan=await entityDeleteHandler.prepare(await context(workspace));
  assert.equal(plan.planningAfter.tasks.length,workspace.tasks.length-1);assert.deepEqual(plan.planningAfter.tasks,workspace.tasks.slice(1));assert.deepEqual(plan.backup,{reason:'delete'});assert.deepEqual(plan.writes,[]);assert.deepEqual(plan.jobs,[]);
  assert.deepEqual(plan.events[0].changes[0].before.value,workspace.tasks[0]);assert.deepEqual(plan.events[0].changes[0].after,{exists:false,value:null});assert.equal(plan.events[0].actorId,'owner');assert.equal(plan.events[0].occurredAt,at);assert.deepEqual(workspace,original);
  assert.equal(workspace.tasks[0].completedAt,null);assert.equal(plan.events[0].changes[0].before.exists,true);
});
test('active tasks and captures cannot be permanently removed',async()=>{
  const workspace=seed();workspace.tasks[0].status='todo';workspace.tasks[0].archivedFromStatus=null;
  assert.equal((await previewEntityDeletion(workspace,'task',workspace.tasks[0].id,9)).canDelete,false);
  await assert.rejects(entityDeleteHandler.prepare(await context(workspace)),/Archive/);
  await assert.rejects(entityDeleteHandler.prepare(await context(workspace,'capture',workspace.captures[0].id)),/Archive/);
});
test('dependencies and converted captures block deletion until explicit unlink',async()=>{
  const workspace=seed();workspace.tasks[1].dependsOn=[workspace.tasks[0].id];workspace.captures[0].convertedTaskId=workspace.tasks[0].id;
  const preview=await previewEntityDeletion(workspace,'task',workspace.tasks[0].id,9);
  assert.equal(preview.references.length,2);assert.equal(preview.canDelete,false);await assert.rejects(entityDeleteHandler.prepare(await context(workspace)),/reference/);
  workspace.captures[0].status='archived';await assert.rejects(entityDeleteHandler.prepare(await context(workspace,'capture',workspace.captures[0].id)),/Unlink/);
});
test('unlinked archived capture removal retains every other record and timestamp',async()=>{
  const workspace=seed();workspace.captures[0].status='archived';const id=workspace.captures[0].id;
  const plan=await entityDeleteHandler.prepare(await context(workspace,'capture',id));assert.equal(plan.planningAfter.captures.length,workspace.captures.length-1);assert.deepEqual(plan.planningAfter.tasks,workspace.tasks);assert.deepEqual(plan.planningAfter.activity,workspace.activity);
});
test('revision, record content, and strict command validation invalidate stale previews',async()=>{
  const workspace=seed(),ctx=await context(workspace);
  await assert.rejects(entityDeleteHandler.prepare({...ctx,command:{...ctx.command,targetRevision:8}}),/stale/);
  await assert.rejects(entityDeleteHandler.prepare({...ctx,command:{...ctx.command,ownerId:'forged'}}),/Invalid/);
  workspace.tasks[0].notes='Changed after review';await assert.rejects(entityDeleteHandler.prepare(ctx),/changed/);
  await assert.rejects(previewEntityDeletion(workspace,'task','missing',9),/does not exist/);
});
test('any owner normalized module row fails closed until typed references exist',async()=>{
  const workspace=seed(),ctx=await context(workspace);
  for(const populated of ['weekly_plans','evidence_links','attachments','workspace_configuration']) {
    const planContext={...ctx,query:{...ctx.query,async list(table:string){return table===populated?[{id:'opaque',row_revision:1,payload_json:'{}',content_hash:'hash'}]:[];}}};
    await assert.rejects(entityDeleteHandler.prepare(planContext),/typed reference adapter/);
  }
});
