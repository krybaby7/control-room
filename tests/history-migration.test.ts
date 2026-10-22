import test from 'node:test';
import assert from 'node:assert/strict';
import {createSeedWorkspace} from '../lib/seed.ts';
import {parseWorkspaceExport} from '../lib/workspace-validation.ts';
import {encodePlanning,decodePlanning} from '../lib/workspace-codec.ts';
const now='2026-10-22T10:00:00.000Z';
test('legacy planning migrates without inferred classification or changed owner fields',()=>{
 const original=createSeedWorkspace(now);original.schemaVersion=4;
 const before=structuredClone(original),migrated=parseWorkspaceExport(original,now);
 assert.equal(migrated.schemaVersion,5);assert.deepEqual(migrated.areas,[]);
 for(const task of migrated.tasks){assert.equal(task.areaId,null);assert.equal(task.workType,'other');const {areaId:_a,workType:_w,...rest}=task;assert.deepEqual(rest,before.tasks.find(t=>t.id===task.id));}
 assert.deepEqual(original,before);assert.deepEqual(decodePlanning(encodePlanning(migrated),now),migrated);
});
import {applyCommand} from '../lib/planning.ts';
import {measurePlanning,measureValidatedPlanning} from '../lib/workspace-migrations.ts';
for(const version of [1,2,4] as const)test(`near-bound v${version} migrates, edits and round trips without owner field loss`,()=>{
 const original=createSeedWorkspace(now);original.schemaVersion=version;delete original.areas;
 const base={id:'synthetic-task',projectId:original.projects[0].id,milestoneId:null,title:'Map review remains unclassified',notes:'',status:'todo' as const,horizon:'later' as const,priority:'normal' as const,dueDate:null,weekly:false,dependsOn:[],blocker:'',sourceUrl:null,evidence:'',estimateMinutes:null,createdAt:now,updatedAt:now,completedAt:null,weeklyWeek:null,archivedFromStatus:null};
 original.tasks=Array.from({length:100},(_,i)=>({...base,id:`synthetic-${i}`,notes:'x'.repeat(9400)}));
 const before=structuredClone(original),migrated=parseWorkspaceExport(original,now);
 assert.equal(migrated.schemaVersion,5);assert.ok(measurePlanning(migrated).contentBytes>970000);assert.deepEqual(measurePlanning(migrated),measureValidatedPlanning(migrated));
 for(const task of migrated.tasks){const {areaId,workType,...rest}=task;assert.equal(areaId,null);assert.equal(workType,'other');assert.deepEqual(rest,before.tasks.find(t=>t.id===task.id));}
 const edited=applyCommand(migrated,{type:'task.update',id:'synthetic-0',patch:{title:'Owner edit'}},now);
 assert.deepEqual(decodePlanning(encodePlanning(edited),now),edited);assert.deepEqual(original,before);
 const tooLarge=structuredClone(original);tooLarge.tasks.forEach(t=>t.notes='x'.repeat(10000));assert.throws(()=>parseWorkspaceExport(tooLarge),/legacy.*limit/i);
});
test('v5 content headroom and compact generated defaults use exact measurement',()=>{
 const ws=parseWorkspaceExport(createSeedWorkspace(now));assert.deepEqual(measurePlanning(ws),measureValidatedPlanning(ws));
 ws.areas=[{id:'area',projectId:ws.projects[0].id,name:'Quoted " area',aliases:['alias'],order:0,archivedAt:null}];
 assert.deepEqual(measurePlanning(ws),measureValidatedPlanning(ws));assert.deepEqual(decodePlanning(encodePlanning(ws)),ws);
});
test('v4 migration preserves weekly commitments, archived completion and baseline markers',()=>{
 const legacy=createSeedWorkspace(now);legacy.schemaVersion=4;delete legacy.areas;
 legacy.tasks=[{id:'baseline:synthetic:task',projectId:legacy.projects[0].id,milestoneId:null,title:'Historical owner title',notes:'Owner notes',status:'archived',horizon:'now',priority:'high',dueDate:'2026-10-22',weekly:false,dependsOn:[],blocker:'',sourceUrl:'https://example.test/owner',evidence:'Saved evidence',estimateMinutes:25,createdAt:now,updatedAt:now,completedAt:now,weeklyWeek:null,archivedFromStatus:'done'}, {id:'weekly-task',projectId:legacy.projects[1].id,milestoneId:null,title:'Pinned owner task',notes:'',status:'todo',horizon:'next',priority:'normal',dueDate:null,weekly:true,dependsOn:['baseline:synthetic:task'],blocker:'',sourceUrl:null,evidence:'',estimateMinutes:null,createdAt:now,updatedAt:now,completedAt:null,weeklyWeek:'2026-10-19',archivedFromStatus:null}];
 const migrated=parseWorkspaceExport(legacy);for(const task of migrated.tasks){const {areaId:_a,workType:_w,...retained}=task;assert.deepEqual(retained,legacy.tasks.find(row=>row.id===task.id));}assert.deepEqual(decodePlanning(encodePlanning(migrated)),migrated);
});
test('v5 accepts migration headroom while retaining the larger content bound',()=>{
 const ws=parseWorkspaceExport(createSeedWorkspace(now));
 const projectId=ws.projects[0].id;
 ws.captures=Array.from({length:140},(_,index)=>({id:`headroom-${index}`,projectId,title:'Owner capture',body:'x'.repeat(10000),kind:'idea',sourceUrl:null,status:'inbox',createdAt:now,convertedTaskId:null}));
 assert.ok(measurePlanning(ws).contentBytes>1_000_000);assert.deepEqual(decodePlanning(encodePlanning(ws)),ws);
 ws.captures.push(...Array.from({length:10},(_,index)=>({...ws.captures[0],id:`overflow-${index}`})));assert.throws(()=>parseWorkspaceExport(ws),/1.5 MB user-content/i);
});
