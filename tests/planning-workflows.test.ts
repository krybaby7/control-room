import test from 'node:test';
import assert from 'node:assert/strict';
import {createSeedWorkspace} from '../lib/seed.ts';
import {migratePlanningV3ToV4,migratePlanningV4ToV5} from '../lib/planning-migration.ts';
import {parseWorkspaceExport} from '../lib/workspace-validation.ts';
import {encodePlanning,decodePlanning,measurePlanning} from '../lib/workspace-codec.ts';
import type {Workspace} from '../lib/types.ts';
const at='2026-10-18T00:00:00.000Z';
function legacyV3():Workspace {const raw=JSON.parse(JSON.stringify(createSeedWorkspace(at)));raw.schemaVersion=3;for(const row of raw.projects)delete row.archivedAt;for(const row of raw.milestones){delete row.archivedAt;delete row.sortKey;}for(const row of raw.tasks)delete row.estimateMinutes;return raw;}
test('v3 to v4 clones only explicit defaults and preserves every source record and ID',()=>{
 const source=legacyV3(),original=JSON.stringify(source),result=migratePlanningV3ToV4(source);assert.equal(JSON.stringify(source),original);assert.equal(result.schemaVersion,4);
 for(const collection of ['projects','milestones','tasks','captures','activity'] as const)assert.deepEqual(result[collection].map(row=>row.id),source[collection].map(row=>row.id));
 assert.ok(result.tasks.every(row=>row.estimateMinutes===null));assert.ok(result.projects.every(row=>row.archivedAt===null));const current=migratePlanningV4ToV5(result);assert.equal(current.schemaVersion,5);assert.deepEqual(parseWorkspaceExport(source),current);assert.deepEqual(decodePlanning(encodePlanning(result)),current);
});
test('current schema validates owner estimates/archive instants and unique milestone ordering without silent normalization',()=>{
 const source=parseWorkspaceExport(legacyV3());source.tasks[0].estimateMinutes=45;source.projects[0].archivedAt=at;source.milestones[0].archivedAt=at;
 assert.deepEqual(parseWorkspaceExport(source),source);assert.ok(measurePlanning(source).contentBytes>measurePlanning(parseWorkspaceExport(legacyV3())).contentBytes);
 for(const estimateMinutes of [0,1.5,10081]){const invalid=structuredClone(source);invalid.tasks[0].estimateMinutes=estimateMinutes;assert.throws(()=>parseWorkspaceExport(invalid),/Invalid workspace/);}
 const duplicate=structuredClone(source);const same=duplicate.milestones.filter(row=>row.projectId===duplicate.milestones[0].projectId);same[1].sortKey=same[0].sortKey;assert.throws(()=>parseWorkspaceExport(duplicate),/ordering/);
 assert.throws(()=>parseWorkspaceExport({...source,schemaVersion:999}),/version/);
});

test('accepted legacy ordering metadata is retained rather than silently overwritten',()=>{const source=legacyV3();source.milestones[0].sortKey=50;assert.equal(parseWorkspaceExport(source).milestones[0].sortKey,50);assert.equal(source.milestones[0].sortKey,50);});
