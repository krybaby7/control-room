import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeedWorkspace } from '../lib/seed.ts';
import { parsePlanningImport } from '../lib/workspace-codec.ts';
import { previewEntityDeletion, entityDeleteHandler } from '../lib/workspace-deletion.ts';
import type { PrepareContext } from '../lib/workspace-transaction.ts';
import type { Workspace } from '../lib/types.ts';
import {referenceRegistry,readReferenceSnapshot} from '../lib/workspace-references.ts';
import {database} from './helpers/sqlite.ts';
import {loadWorkspace,readCurrent} from '../lib/workspace-store.ts';
import {executeWorkspaceCommand} from '../lib/workspace-transaction.ts';
import {canonical,contentHash} from '../lib/workspace-export.ts';
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
test('unknown or invalid normalized module rows fail closed without typed valid references',async()=>{
  const workspace=seed(),ctx=await context(workspace);
  for(const populated of ['weekly_plans','evidence_links','attachments','workspace_configuration']) {
    const planContext={...ctx,query:{...ctx.query,async list(table:string){return table===populated?[{id:'opaque',row_revision:1,payload_json:'{}',content_hash:await contentHash('{}')}]:[];}}};
    await assert.rejects(entityDeleteHandler.prepare(planContext),/Missing typed reference descriptor|Invalid normalized reference payload/);
  }
});
test('registered unrelated normalized rows permit deletion; exact references and dangling references block',async()=>{
  const workspace=seed(),ctx=await context(workspace);let subject:{type:'project'|'task';id:string}={type:'project',id:workspace.projects[0].id};
  const query={...ctx.query,async list(table:string){const value={id:'requirement',subject,label:'Synthetic deletion reference',scope:'implementation',required:true,maxAgeDays:null,candidate:null,requireAttachment:false,archivedAt:null};return table==='evidence_requirements'?[{id:'requirement',row_revision:1,payload_json:JSON.stringify(value),content_hash:await contentHash(canonical(value))}]:[];}};
  const reviewed=async()=>{const snapshot=await readReferenceSnapshot(query,referenceRegistry),preview=await previewEntityDeletion(workspace,'task',workspace.tasks[0].id,9,snapshot);return {...ctx,query,command:{...ctx.command,previewHash:preview.previewHash}};};
  const plan=await entityDeleteHandler.prepare(await reviewed());assert.equal(plan.referenceSnapshot?.rows.length,1);assert.equal(plan.planningAfter.tasks.length,workspace.tasks.length-1);
  const old=await reviewed();subject={type:'task',id:workspace.tasks[0].id};await assert.rejects(entityDeleteHandler.prepare(old),/changed/);
  await assert.rejects(entityDeleteHandler.prepare(await reviewed()),/Normalized records still reference/);
  subject={type:'task',id:'missing-task'};await assert.rejects(entityDeleteHandler.prepare(await reviewed()),/dangling references/);
});

test('archived empty project removal retains historical activity text and audits the cleared link',async()=>{
 const workspace=seed(),project=workspace.projects[0];project.archivedAt=at;
 workspace.tasks=workspace.tasks.filter(row=>row.projectId!==project.id);workspace.milestones=workspace.milestones.filter(row=>row.projectId!==project.id);workspace.captures=workspace.captures.filter(row=>row.projectId!==project.id);
 workspace.activity.push({id:'retained-activity',text:'Original project history',at,projectId:project.id});
 const preview=await previewEntityDeletion(workspace,'project',project.id,9);assert.equal(preview.canDelete,true);assert.equal(preview.historicalActivity.at(-1)?.text,'Original project history');
 const ctx=await context(workspace),plan=await entityDeleteHandler.prepare({...ctx,command:{type:'entity.delete',entityType:'project',id:project.id,previewHash:preview.previewHash,targetRevision:9}});
 assert.equal(plan.planningAfter.projects.some(row=>row.id===project.id),false);assert.deepEqual(plan.planningAfter.activity.find(row=>row.id==='retained-activity'),{id:'retained-activity',text:'Original project history',at,projectId:null});
 assert.ok(plan.events[0].changes.some(change=>change.path.join('.')==='activity.retained-activity.projectId'&&change.before.value===project.id&&change.after.value===null));assert.deepEqual(plan.backup,{reason:'delete'});assert.ok(plan.referenceSnapshot);assert.equal(workspace.activity.at(-1)?.projectId,project.id);
});
test('project deletion requires archive and zero milestone/task/capture links with readable labels',async()=>{
 const workspace=seed(),project=workspace.projects[0];workspace.captures[0].projectId=project.id;let preview=await previewEntityDeletion(workspace,'project',project.id,9);assert.equal(preview.canDelete,false);assert.match(preview.blockers.join(' '),/Archive/);project.archivedAt=at;
 preview=await previewEntityDeletion(workspace,'project',project.id,9);assert.equal(preview.canDelete,false);for(const collection of ['milestones','tasks','captures'])assert.ok(preview.references.some(ref=>ref.collection===collection),collection);assert.ok(preview.references.every(ref=>ref.label));
});
test('milestone deletion requires archive and no linked tasks, including archived tasks',async()=>{
 const workspace=seed(),milestone=workspace.milestones[0];workspace.tasks[0].milestoneId=milestone.id;
 let preview=await previewEntityDeletion(workspace,'milestone',milestone.id,9);assert.match(preview.blockers.join(' '),/Archive/);milestone.archivedAt=at;preview=await previewEntityDeletion(workspace,'milestone',milestone.id,9);assert.equal(preview.canDelete,false);assert.ok(preview.references.some(ref=>ref.id===workspace.tasks[0].id));
 workspace.tasks=workspace.tasks.map(row=>row.milestoneId===milestone.id?{...row,milestoneId:null}:row);preview=await previewEntityDeletion(workspace,'milestone',milestone.id,9);assert.equal(preview.canDelete,true);
 const ctx=await context(workspace),plan=await entityDeleteHandler.prepare({...ctx,command:{type:'entity.delete',entityType:'milestone',id:milestone.id,previewHash:preview.previewHash,targetRevision:9}});assert.equal(plan.planningAfter.milestones.some(row=>row.id===milestone.id),false);assert.deepEqual(plan.planningAfter.tasks,workspace.tasks);assert.deepEqual(plan.backup,{reason:'delete'});
});
test('project historical activity change invalidates exact impact digest',async()=>{
 const workspace=seed(),project=workspace.projects[0];project.archivedAt=at;workspace.tasks=workspace.tasks.filter(row=>row.projectId!==project.id);workspace.milestones=workspace.milestones.filter(row=>row.projectId!==project.id);workspace.captures=workspace.captures.filter(row=>row.projectId!==project.id);workspace.activity.push({id:'historical-link',text:'Before',at,projectId:project.id});
 const preview=await previewEntityDeletion(workspace,'project',project.id,9),ctx=await context(workspace);workspace.activity.at(-1)!.text='Changed after review';await assert.rejects(entityDeleteHandler.prepare({...ctx,command:{type:'entity.delete',entityType:'project',id:project.id,previewHash:preview.previewHash,targetRevision:9}}),/changed/);
});

for(const entityType of ['project','milestone'] as const)test(`${entityType} deletion commits one recovery point, replays once, and isolates owners`,async()=>{
 const {db,sqlite}=database(),workspace=seed();let id:string;
 if(entityType==='project'){const project=workspace.projects[0];id=project.id;project.archivedAt=at;workspace.tasks=workspace.tasks.filter(row=>row.projectId!==id);workspace.captures=workspace.captures.filter(row=>row.projectId!==id);workspace.milestones=workspace.milestones.filter(row=>row.projectId!==id);}
 else {const milestone=workspace.milestones[0];id=milestone.id;milestone.archivedAt=at;workspace.tasks=workspace.tasks.map(row=>row.milestoneId===id?{...row,milestoneId:null}:row);}
 await loadWorkspace(db,'a',()=>workspace,at);await loadWorkspace(db,'b',()=>workspace,at);const before=await readCurrent(db,'a'),foreign=await readCurrent(db,'b'),preview=await previewEntityDeletion(before.workspace,entityType,id,before.revision);
 const command={type:'entity.delete',entityType,id,previewHash:preview.previewHash,targetRevision:before.revision},input={protocolVersion:1,expectedRevision:before.revision,mutationId:`delete-${entityType}-synthetic-0001`,command},deps={db,now:()=>at,handlers:new Map([['entity.delete',entityDeleteHandler]])};
 assert.equal((await executeWorkspaceCommand('a',input,deps)).status,'committed');assert.equal((await executeWorkspaceCommand('a',input,deps)).status,'replayed');assert.deepEqual(await readCurrent(db,'b'),foreign);assert.equal((await readCurrent(db,'a')).revision,before.revision+1);
 for(const table of ['workspace_backups','workspace_mutations','audit_events'])assert.equal(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id=?`).get('a')!.n,1,table);
 const backup=sqlite.prepare('SELECT content FROM workspace_backups WHERE user_id=?').get('a')!;assert.ok(String(backup.content).includes(id));sqlite.close();
});
