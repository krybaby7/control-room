import test from 'node:test';
import { legacyPlanningFixture } from './helpers/workspace.ts';
import assert from 'node:assert/strict';
import { migrationFixture,migrationSavedAt } from './fixtures/migration.ts';
import { parsePlanningImport,encodePlanning,decodePlanning } from '../lib/workspace-codec.ts';
import { database } from './helpers/sqlite.ts';
import { loadWorkspace,mutateWorkspace } from '../lib/workspace-store.ts';
test('synthetic v1/v2 rehearsal preserves IDs, archived prerequisites, saved weeks and owner boundaries',async()=>{
 const legacy=migrationFixture(),v3=parsePlanningImport(legacy,migrationSavedAt);
 assert.equal(v3.schemaVersion,5);assert.ok(v3.tasks.every(task=>task.areaId===null&&task.workType==='other'));
 assert.equal(v3.tasks[0].archivedFromStatus,'done');assert.equal(v3.tasks[1].weeklyWeek,'2026-10-12');
 assert.deepEqual(v3.tasks.map(t=>t.id),legacy.tasks.map(t=>t.id));assert.deepEqual(decodePlanning(encodePlanning(v3),migrationSavedAt),v3);
 const v2=legacyPlanningFixture(v3,2);delete v2.areas;for(const task of v2.tasks){delete task.areaId;delete task.workType;}assert.deepEqual(parsePlanningImport(v2),v3);
 const {db}=database();await loadWorkspace(db,'synthetic-a',()=>legacy,migrationSavedAt);await loadWorkspace(db,'synthetic-b',()=>({...legacy,tasks:[]}),migrationSavedAt);
 await mutateWorkspace(db,'synthetic-a',1,'synthetic-mutate-01',{type:'project.update',id:'synthetic-project',patch:{goal:'A only'}},migrationSavedAt);
 assert.equal((await loadWorkspace(db,'synthetic-b',()=>legacy,migrationSavedAt)).workspace.projects[0].goal,'Preserve IDs');
 assert.throws(()=>parsePlanningImport({...v3,unexpected:'reject'}),/unsupported|Unrecognized|Invalid/i);
});
