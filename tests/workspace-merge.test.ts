import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeedWorkspace } from '../lib/seed.ts';
import { parsePlanningImport } from '../lib/workspace-codec.ts';
import { previewPlanningMerge, type PlanningMergeSelection } from '../lib/workspace-merge.ts';
const at='2026-10-17T12:00:00.000Z';
const base=parsePlanningImport(createSeedWorkspace(at));
const seed=()=>structuredClone(base);
const selection=(patch:Partial<PlanningMergeSelection>={}):PlanningMergeSelection=>({projects:[],milestones:[],tasks:[],captures:[],activity:[],...patch});
test('explicit selected collision replaces content visibly and preserves order and inputs',()=>{
  const current=seed(),incoming=seed();incoming.tasks[0].notes='Incoming notes';incoming.tasks[1].notes='Not selected';
  const originals=[structuredClone(current),structuredClone(incoming)];
  const result=previewPlanningMerge(current,incoming,selection({tasks:[incoming.tasks[0].id]}));
  assert.equal(result.changed,1);assert.equal(result.added,0);assert.equal(result.conflicts.length,1);
  assert.equal(result.conflicts[0].before.id,current.tasks[0].id);assert.equal(result.conflicts[0].after.id,current.tasks[0].id);
  assert.equal(result.workspace.tasks[0].notes,'Incoming notes');assert.deepEqual(result.workspace.tasks[1],current.tasks[1]);
  assert.deepEqual(result.workspace.tasks.map(t=>t.id),current.tasks.map(t=>t.id));
  assert.deepEqual([current,incoming],originals);
});
test('new completed pinned source task becomes an uncommitted proposal with original history in source claims',()=>{
  const current=seed(),incoming=seed();const task={...incoming.tasks[0],id:'new-task',status:'done' as const,weekly:true,weeklyWeek:'2026-10-12',completedAt:at,dependsOn:[],blocker:''};incoming.tasks.push(task);
  const result=previewPlanningMerge(current,incoming,selection({tasks:[task.id]}));const added=result.workspace.tasks.at(-1)!;
  assert.equal(result.added,1);assert.equal(added.id,task.id);assert.equal(added.status,'proposed');assert.equal(added.weekly,false);assert.equal(added.weeklyWeek,null);assert.equal(added.completedAt,null);assert.equal(added.archivedFromStatus,null);
  assert.equal(added.createdAt,task.createdAt);assert.equal(added.updatedAt,task.updatedAt);assert.deepEqual(result.sourceClaims[0].record,task);
});
test('archived target lifecycle history survives imported task status and weekly changes',()=>{
  const current=seed(),incoming=seed();current.tasks[0]={...current.tasks[0],status:'archived',archivedFromStatus:'done',completedAt:at,weekly:false,weeklyWeek:'2026-10-12',dependsOn:[],blocker:''};
  incoming.tasks[0]={...incoming.tasks[0],status:'doing',weekly:true,weeklyWeek:'2026-10-12',notes:'Imported evidence notes'};
  const result=previewPlanningMerge(current,incoming,selection({tasks:[current.tasks[0].id]}));const task=result.workspace.tasks[0];
  assert.equal(task.status,'archived');assert.equal(task.archivedFromStatus,'done');assert.equal(task.completedAt,at);assert.equal(task.weekly,false);assert.equal(task.weeklyWeek,'2026-10-12');assert.equal(task.notes,'Imported evidence notes');
});
test('new achieved milestone retains source acceptance claim without granting acceptance',()=>{
  const current=seed(),incoming=seed();incoming.milestones.push({...incoming.milestones[0],id:'source-milestone',sortKey:incoming.milestones.filter(m=>m.projectId===incoming.milestones[0].projectId).length,status:'achieved',evidence:'Source says accepted'});
  const result=previewPlanningMerge(current,incoming,selection({milestones:['source-milestone']}));
  assert.equal(result.workspace.milestones.at(-1)!.status,'planned');assert.equal((result.sourceClaims[0].record as typeof incoming.milestones[number]).status,'achieved');
});
test('selection rejects duplicates, unknown IDs, unknown collections and omitted collections',()=>{
  const current=seed(),incoming=seed();
  for(const invalid of [selection({tasks:[incoming.tasks[0].id,incoming.tasks[0].id]}),selection({tasks:['absent']}),{...selection(),other:[]},{tasks:[]}])assert.throws(()=>previewPlanningMerge(current,incoming,invalid as PlanningMergeSelection),/selection/);
});
test('selected references require their project and global identity collisions are rejected',()=>{
  const current=seed(),incoming=seed();
  incoming.projects.push({...incoming.projects[0],id:'new-project'});
  incoming.tasks.push({...incoming.tasks[0],id:'new-task',projectId:'new-project',milestoneId:null,dependsOn:[]});
  assert.throws(()=>previewPlanningMerge(current,incoming,selection({tasks:['new-task']})),/missing project/);
  assert.equal(previewPlanningMerge(current,incoming,selection({projects:['new-project'],tasks:['new-task']})).added,2);
  const collision=seed();collision.captures.push({...collision.captures[0],id:'collision'});
  const target=seed();target.tasks.push({...target.tasks[0],id:'collision'});
  assert.throws(()=>previewPlanningMerge(target,collision,selection({captures:['collision']})),/unique/);
});
test('final merged graph rejects introduced cycles and completed dependencies',()=>{
  const current=seed(),incoming=seed();
  current.tasks[0].dependsOn=[current.tasks[1].id];
  incoming.tasks[1].dependsOn=[incoming.tasks[0].id];
  assert.throws(()=>previewPlanningMerge(current,incoming,selection({tasks:[incoming.tasks[1].id]})),/cycle/);
  const completed=seed(),source=seed();completed.tasks[0]={...completed.tasks[0],status:'done',completedAt:at,dependsOn:[],blocker:''};
  source.tasks[0].dependsOn=[source.tasks[1].id];
  assert.throws(()=>previewPlanningMerge(completed,source,selection({tasks:[source.tasks[0].id]})),/unfinished dependencies/);
});
test('final merge enforces count and UTF-8 content budgets across individually valid sources',()=>{
  const current=seed(),incoming=seed();
  current.tasks=Array.from({length:2000},(_,i)=>({...current.tasks[0],id:`target-${i}`,notes:'',title:'Task'}));
  incoming.tasks=[{...incoming.tasks[0],id:'additional-task'}];
  assert.throws(()=>previewPlanningMerge(current,incoming,selection({tasks:['additional-task']})),/2000/);
  const target=seed(),source=seed();
  target.tasks=Array.from({length:60},(_,i)=>({...target.tasks[0],id:`current-${i}`,notes:'ع'.repeat(4500)}));
  source.tasks=Array.from({length:60},(_,i)=>({...source.tasks[0],id:`incoming-${i}`,notes:'ع'.repeat(4500)}));
  assert.throws(()=>previewPlanningMerge(target,source,selection({tasks:source.tasks.map(t=>t.id)})),/user-content storage limit/);
});
test('empty selection is a detached unchanged preview and archived incoming additions remain proposals',()=>{
  const current=seed(),incoming=seed();
  const empty=previewPlanningMerge(current,incoming,selection());assert.deepEqual(empty.workspace,current);assert.equal(empty.changed,0);assert.equal(empty.added,0);assert.deepEqual(empty.conflicts,[]);
  empty.workspace.projects[0].goal='detached';assert.notEqual(current.projects[0].goal,'detached');
  const task={...incoming.tasks[0],id:'archived-source',status:'archived' as const,archivedFromStatus:'done' as const,completedAt:at,weekly:false,dependsOn:[],blocker:''};incoming.tasks.push(task);
  const result=previewPlanningMerge(current,incoming,selection({tasks:[task.id]}));
  assert.equal(result.workspace.tasks.at(-1)!.status,'proposed');assert.equal(result.workspace.tasks.at(-1)!.completedAt,null);assert.equal(result.workspace.tasks.at(-1)!.archivedFromStatus,null);assert.deepEqual(result.sourceClaims[0].record,task);
});
