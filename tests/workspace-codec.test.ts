import { legacyWorkspaceFixture } from './helpers/workspace.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeedWorkspace } from '../lib/seed.ts';
import { encodePlanning, decodePlanning, parsePlanningImport, measurePlanning } from '../lib/workspace-codec.ts';
import { migratePlanningV1ToV2, migratePlanningV2ToV3 } from '../lib/workspace-migrations.ts';
const at = '2026-10-17T12:00:00.000Z';
test('explicit migrations preserve original records and saved weekly/archive history', () => {
  const source = legacyWorkspaceFixture(1,at);
  source.tasks[0].weekly=true;
  source.tasks[1].status='archived'; source.tasks[1].completedAt=at;
  const original=structuredClone(source);
  const v2=migratePlanningV1ToV2(source,at);
  const v3=migratePlanningV2ToV3(v2);
  assert.deepEqual(source,original);
  assert.equal(v3.tasks[0].weeklyWeek,'2026-10-12');
  assert.equal(v3.tasks[1].archivedFromStatus,'done');
  assert.deepEqual(v3.tasks.map(t=>t.id),source.tasks.map(t=>t.id));
  assert.deepEqual(v3.tasks.map(t=>t.updatedAt),source.tasks.map(t=>t.updatedAt));
});
test('compact defaults hydrate and repeated exports are stable without losing owner text', () => {
  const workspace=parsePlanningImport(createSeedWorkspace(at));
  workspace.tasks[0].notes='weeklyWeek archivedFromStatus schemaVersion مرحبا';
  const encoded=encodePlanning(workspace);
  assert.equal(Object.hasOwn(JSON.parse(encoded).tasks[0],'weeklyWeek'),false);
  assert.equal(Object.hasOwn(JSON.parse(encoded).tasks[0],'archivedFromStatus'),false);
  let current=workspace;
  for(let i=0;i<5;i++) current=decodePlanning(encodePlanning(current),at);
  assert.deepEqual(current,workspace);
  assert.equal(encodePlanning(current),encoded);
  assert.throws(()=>decodePlanning('{',at),/JSON/);
  assert.throws(()=>parsePlanningImport({...workspace,schemaVersion:999}),/version/);
});
for(const [version,limit] of [[4,1_000_000],[5,1_500_000]] as const)test(`v${version} UTF-8 content boundary counts Arabic bytes at its original bound`, () => {
  const workspace=parsePlanningImport(createSeedWorkspace(at));
  const template=workspace.tasks[0];
  workspace.tasks=Array.from({length:160},(_,i)=>({...template,id:`utf8-${i}`,notes:''}));
  if(version===4){workspace.schemaVersion=4;delete workspace.areas;for(const task of workspace.tasks){delete task.areaId;delete task.workType;}}
  const before=measurePlanning(workspace);
  workspace.tasks[0].notes='ع';
  assert.equal(measurePlanning(workspace).contentBytes,before.contentBytes+2);
  workspace.tasks[0].notes='';
  let remaining=limit-measurePlanning(workspace).contentBytes;
  for(const task of workspace.tasks) {
    const amount=Math.min(10000,remaining); task.notes='x'.repeat(amount); remaining-=amount;
  }
  assert.equal(remaining,0);
  assert.equal(measurePlanning(workspace).contentBytes,limit);
  assert.deepEqual(decodePlanning(encodePlanning(workspace)),parsePlanningImport(workspace));
  workspace.tasks[0].notes='ع'+workspace.tasks[0].notes.slice(1);
  assert.equal(measurePlanning(workspace).contentBytes,limit+1);
  assert.throws(()=>encodePlanning(workspace),/user-content/);
});
test('maximum task weekly metadata has a separate bounded serialized allowance', () => {
  const workspace=parsePlanningImport(createSeedWorkspace(at));
  workspace.tasks=Array.from({length:2000},(_,i)=>({...workspace.tasks[0],id:`weekly-${i}`,title:'Task',notes:'',blocker:'',evidence:'',weekly:true,weeklyWeek:'2026-10-12'}));
  const active=measurePlanning(workspace);
  const unpinned=structuredClone(workspace);
  for(const task of unpinned.tasks) {task.weekly=false;task.weeklyWeek=null;}
  // weekly itself remains owner content; only its generated week is excluded.
  assert.equal(active.contentBytes,measurePlanning(unpinned).contentBytes-2000);
  assert.ok(active.serializedBytes>measurePlanning(unpinned).serializedBytes);
  assert.deepEqual(decodePlanning(encodePlanning(workspace)),workspace);
});
