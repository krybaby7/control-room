import test from 'node:test';
import assert from 'node:assert/strict';
import {createSeedWorkspace} from '../lib/seed.ts';
import {parseWorkspaceExport} from '../lib/workspace-validation.ts';
import {encodePlanning,decodePlanning,measurePlanning} from '../lib/workspace-codec.ts';
import {measureValidatedPlanning} from '../lib/workspace-migrations.ts';
import {applyWorkflowCommand} from '../lib/planning-workflows.ts';

const now='2026-10-26T08:00:00.000Z';
test('older folder binding projects to a list and the list survives storage and restore',()=>{
 const old=createSeedWorkspace(now);delete old.projects[0].personalRepositoryKeys;old.projects[0].personalRepositoryKey='app';
 const current=parseWorkspaceExport(old);
 assert.deepEqual(current.projects[0].personalRepositoryKeys,['app']);
 assert.ok(!Object.hasOwn(current.projects[0],'personalRepositoryKey'));
 const edited=applyWorkflowCommand(current,{type:'project.edit',id:current.projects[0].id,patch:{personalRepositoryKeys:['app','map-lab']}},{now,newId:()=>crypto.randomUUID()}).workspace;
 assert.deepEqual(decodePlanning(encodePlanning(edited)),edited);
 assert.deepEqual(parseWorkspaceExport(JSON.parse(JSON.stringify(edited))),edited);
 assert.deepEqual(measurePlanning(edited),measureValidatedPlanning(edited));
});
test('folder lists are bounded, unique and owned by one project including archived projects',()=>{
 for(const keys of [['a','a'],['a','b','c','d','e'],['bad/key']]){
  const ws=createSeedWorkspace(now);Object.assign(ws.projects[0],{personalRepositoryKeys:keys});assert.throws(()=>parseWorkspaceExport(ws));
 }
 const ws=createSeedWorkspace(now);Object.assign(ws.projects[0],{personalRepositoryKeys:['app','map-lab'],archivedAt:now});Object.assign(ws.projects[1],{personalRepositoryKeys:['map-lab']});assert.throws(()=>parseWorkspaceExport(ws),/folder|repository/i);
});
