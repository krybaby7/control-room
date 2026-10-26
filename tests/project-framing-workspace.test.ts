import test from 'node:test';
import assert from 'node:assert/strict';
import {createSeedWorkspace} from '../lib/seed.ts';
import {parseWorkspaceExport} from '../lib/workspace-validation.ts';
import {encodePlanning,decodePlanning,measurePlanning} from '../lib/workspace-codec.ts';
import {measureValidatedPlanning} from '../lib/workspace-migrations.ts';
import {applyWorkflowCommand} from '../lib/planning-workflows.ts';
import {database} from './helpers/sqlite.ts';
import {loadWorkspace} from '../lib/workspace-store.ts';
import {exportWorkspaceBundle,parseWorkspaceBundle} from '../lib/workspace-export.ts';

const now='2026-10-26T08:00:00.000Z';
const context={now,newId:()=>crypto.randomUUID()};
test('older workspaces read framing empty and task-plan inclusion off without changing IDs',()=>{
 const raw=createSeedWorkspace(now),ids=raw.projects.map(p=>p.id);for(const p of raw.projects){delete p.framing;delete p.includeTaskPlanInBriefings;delete p.personalRepositoryKey;}
 const restored=parseWorkspaceExport(raw);
 assert.deepEqual(restored.projects.map(p=>p.id),ids);
 for(const p of restored.projects){assert.equal(p.framing,'');assert.equal(p.includeTaskPlanInBriefings,false);assert.deepEqual(p.personalRepositoryKeys,[]);}
});
test('project framing and folder mapping survive editing, export and restore verbatim',()=>{
 const source=parseWorkspaceExport(createSeedWorkspace(now));
 const framing='  A shared place for our work.\n\nKeep decisions with their reasons.  ';
 const created=applyWorkflowCommand(source,{type:'project.create',project:{name:'Folder',description:'',goal:'',color:'teal',repositories:[],framing,includeTaskPlanInBriefings:true,personalRepositoryKey:'folder_key'}},context).workspace;
 const project=created.projects.at(-1)!;
 assert.equal(project.framing,framing);assert.equal(project.includeTaskPlanInBriefings,true);assert.deepEqual(project.personalRepositoryKeys,['folder_key']);
 const exported=encodePlanning(created);
 assert.deepEqual(decodePlanning(exported),created);assert.deepEqual(parseWorkspaceExport(JSON.parse(JSON.stringify(created))),created);
 assert.deepEqual(measurePlanning(created),measureValidatedPlanning(created));
 const edited=applyWorkflowCommand(created,{type:'project.edit',id:project.id,patch:{framing:'',includeTaskPlanInBriefings:false}},context).workspace;
 assert.equal(edited.projects.at(-1)!.framing,'');assert.equal(edited.projects.at(-1)!.includeTaskPlanInBriefings,false);assert.deepEqual(edited.projects.at(-1)!.personalRepositoryKeys,['folder_key']);
});
test('project create defaults framing and optional plan and rejects invalid new fields at both boundaries',()=>{
 const source=parseWorkspaceExport(createSeedWorkspace(now));
 const input={name:'Folder',description:'',goal:'',color:'teal',repositories:[]};
 const created=applyWorkflowCommand(source,{type:'project.create',project:input},context).workspace;
 assert.equal(created.projects.at(-1)!.framing,'');assert.equal(created.projects.at(-1)!.includeTaskPlanInBriefings,false);
 for(const patch of [{framing:'x'.repeat(2501)},{framing:5},{framing:'bad\u0000text'},{includeTaskPlanInBriefings:'yes'},{personalRepositoryKey:'bad/key'}]){
  assert.throws(()=>applyWorkflowCommand(source,{type:'project.create',project:{...input,...patch}},context));
  const invalid=structuredClone(source);Object.assign(invalid.projects[0],patch);assert.throws(()=>parseWorkspaceExport(invalid));
 }
 const boundary=structuredClone(source);boundary.projects[0].framing='x'.repeat(2500);assert.equal(parseWorkspaceExport(boundary).projects[0].framing?.length,2500);
});
test('a folder has at most one durable project association',()=>{
 const source=parseWorkspaceExport(createSeedWorkspace(now));source.projects[0].personalRepositoryKeys=['folder_key'];source.projects[1].personalRepositoryKeys=['folder_key'];
 assert.throws(()=>parseWorkspaceExport(source),/folder|repository/i);
});
test('native owner export and restored bundle retain framing, plan opt-in and folder association',async()=>{
 const {db,sqlite}=database();try{
  const workspace=createSeedWorkspace(now);Object.assign(workspace.projects[0],{framing:'Our purpose.\nKeep this rule.',includeTaskPlanInBriefings:true,personalRepositoryKeys:['synthetic_folder','map_lab']});
  await loadWorkspace(db,'synthetic-framing-owner',()=>workspace,now);
  const bundle=await exportWorkspaceBundle(db,'synthetic-framing-owner');
  const restored=parseWorkspaceBundle(JSON.parse(JSON.stringify(bundle)));
  assert.equal(restored.planning.projects[0].framing,workspace.projects[0].framing);assert.equal(restored.planning.projects[0].includeTaskPlanInBriefings,true);assert.deepEqual(restored.planning.projects[0].personalRepositoryKeys,['synthetic_folder','map_lab']);
 }finally{sqlite.close();}
});
