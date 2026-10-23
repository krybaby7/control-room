import { legacyWorkspaceFixture } from './helpers/workspace.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeedWorkspace } from '../lib/seed.ts';
import { repairPlanningImport } from '../lib/import-repair.ts';
const at='2026-10-17T12:00:00.000Z';
const encode=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value));
const decode=(value:Uint8Array)=>JSON.parse(new TextDecoder().decode(value));
test('orphan project mapping changes only explicit field and preserves input bytes/history',async()=>{
 const source=createSeedWorkspace(at);source.tasks[0].projectId='orphan';const bytes=encode({workspace:source,updatedAt:at,revision:3}),original=bytes.slice();
 const result=await repairPlanningImport(bytes,{type:'map-project',collection:'tasks',id:source.tasks[0].id,projectId:source.projects[0].id});
 assert.equal(decode(result.raw).workspace.tasks[0].projectId,source.projects[0].id);assert.equal(result.report.changes[0].before,'orphan');assert.deepEqual(result.report.changes[0].path,['workspace','tasks',0,'projectId']);assert.deepEqual(bytes,original);assert.equal(decode(result.raw).workspace.tasks[0].completedAt,source.tasks[0].completedAt);assert.match(result.report.sourceHash,/^[a-f0-9]{64}$/);
});
test('broken dependency removal preserves other edges and does not invent lifecycle values',async()=>{
 const source=createSeedWorkspace(at);source.tasks[0].dependsOn=['missing',source.tasks[1].id];const result=await repairPlanningImport(encode(source),{type:'remove-dependency',taskId:source.tasks[0].id,dependencyId:'missing'});
 const repaired=decode(result.raw);assert.deepEqual(repaired.tasks[0],{...source.tasks[0],dependsOn:[source.tasks[1].id]});assert.deepEqual(result.report.changes[0].before,source.tasks[0].dependsOn);
});
test('duplicate exact occurrence rename rejects ambiguous references and permits isolated duplicate',async()=>{
 const source=createSeedWorkspace(at);source.tasks.push({...source.tasks[0]});
 await assert.rejects(repairPlanningImport(encode(source),{type:'rename-duplicate',collection:'tasks',occurrenceIndex:source.tasks.length-1,newId:'replacement'}),/ambiguous/);
 for(const task of source.tasks)task.dependsOn=[];for(const capture of source.captures)capture.convertedTaskId=null;
 const result=await repairPlanningImport(encode(source),{type:'rename-duplicate',collection:'tasks',occurrenceIndex:source.tasks.length-1,newId:'replacement'});
 assert.equal(decode(result.raw).tasks.at(-1).id,'replacement');assert.equal(decode(result.raw).tasks[0].id,source.tasks[0].id);
 await assert.rejects(repairPlanningImport(encode(source),{type:'rename-duplicate',collection:'tasks',occurrenceIndex:0,newId:source.projects[0].id}),/unique/);
});
test('cross-collection duplicate rename propagates only typed unambiguous references',async()=>{
 const source=createSeedWorkspace(at);source.captures[0].id=source.tasks[0].id;
 const result=await repairPlanningImport(encode(source),{type:'rename-duplicate',collection:'tasks',occurrenceIndex:0,newId:'renamed-task'});
 const repaired=decode(result.raw);assert.equal(repaired.tasks[0].id,'renamed-task');assert.equal(repaired.captures[0].id,source.tasks[0].id);assert.ok(repaired.tasks.some((task:{dependsOn:string[]})=>task.dependsOn.includes('renamed-task')));
});
test('exclusion retains exact record in recovery report without cascading or dropping modules',async()=>{
 const source=createSeedWorkspace(at);source.tasks[1].dependsOn=[source.tasks[0].id];const bundle={planning:source,modules:{future:{schemaVersion:99,records:[{unknown:'preserve'}]}},unknown:'retained'};
 const result=await repairPlanningImport(encode(bundle),{type:'exclude-record',collection:'tasks',id:source.tasks[0].id});const repaired=decode(result.raw);
 assert.deepEqual(result.report.excludedRecords,[{collection:'tasks',id:source.tasks[0].id,record:source.tasks[0]}]);assert.equal(repaired.planning.tasks.length,source.tasks.length-1);assert.deepEqual(repaired.planning.tasks[0].dependsOn,[source.tasks[0].id]);assert.deepEqual(repaired.modules,bundle.modules);assert.equal(repaired.unknown,'retained');assert.ok(result.report.warnings.length);
 source.tasks.push({...source.tasks[0]});await assert.rejects(repairPlanningImport(encode(source),{type:'exclude-record',collection:'tasks',id:source.tasks[0].id}),/ambiguous/);
});
test('migration uses saved anchor and fails closed on unknown versions while ordinary repairs preserve them',async()=>{
 const source=legacyWorkspaceFixture(1,at);source.tasks[0].weekly=true;
 const migrated=decode((await repairPlanningImport(encode({workspace:source,updatedAt:at}),{type:'migrate'})).raw);assert.equal(migrated.workspace.schemaVersion,5);assert.ok(migrated.workspace.tasks.every((task:{areaId:string|null;workType:string})=>task.areaId===null&&task.workType==='other'));assert.equal(migrated.workspace.tasks[0].weeklyWeek,'2026-10-12');
 const future={...source,schemaVersion:999};await assert.rejects(repairPlanningImport(encode(future),{type:'migrate'}),/version/);
 const repaired=await repairPlanningImport(encode(future),{type:'exclude-record',collection:'captures',id:source.captures[0].id});assert.equal(decode(repaired.raw).schemaVersion,999);
});
test('byte, fatal UTF-8, JSON, operation and target constraints reject without side effects',async()=>{
 for(const raw of [new Uint8Array(8_000_001),Uint8Array.of(0xff),encode('not an object'),new TextEncoder().encode('{')])await assert.rejects(repairPlanningImport(raw,{type:'migrate'}));
 const source=createSeedWorkspace(at),raw=encode(source);
 await assert.rejects(repairPlanningImport(raw,{type:'migrate',unknown:true} as never));
 await assert.rejects(repairPlanningImport(raw,{type:'map-project',collection:'tasks',id:source.tasks[0].id,projectId:'missing'}));
 assert.deepEqual(decode(raw),source);
});
