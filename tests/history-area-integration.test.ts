import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {workspaceFixture,projectFixture,taskFixture,FIXTURE_AT} from './helpers/workspace.ts';
import {parseWorkspaceExport} from '../lib/workspace-validation.ts';
import {loadWorkspace,readCurrent} from '../lib/workspace-store.ts';
import {executeWorkspaceCommand} from '../lib/workspace-transaction.ts';
import {workspaceHandlers} from '../lib/workspace-handlers.ts';
import {exportWorkspaceBundle,parseWorkspaceBundle} from '../lib/workspace-export.ts';
import {stageImport} from '../lib/import-staging.ts';
import {previewPlanningMerge} from '../lib/workspace-merge.ts';
import {previewEntityDeletion} from '../lib/workspace-deletion.ts';
const now=FIXTURE_AT;
function fixture(){return parseWorkspaceExport(workspaceFixture({projects:[projectFixture()],tasks:[]}));}
const area={id:'stable-map-area',projectId:'p1',name:'Map',aliases:['Mapping'],order:7,archivedAt:now};
const selection={projects:[],milestones:[],tasks:['area-task'],captures:[],activity:[],areas:[area.id]};
function incoming(){const ws=fixture();ws.areas=[structuredClone(area)];ws.tasks=[taskFixture('area-task',{areaId:area.id,workType:'review',notes:'Owner classification and evidence',evidence:'Retained source statement'})];return parseWorkspaceExport(ws);}
test('owner area creation audit stores the stable created identity and full row change',async()=>{
 const {db,sqlite}=database();try{
  await loadWorkspace(db,'owner',fixture,now);
  const result=await executeWorkspaceCommand('owner',{protocolVersion:1,expectedRevision:1,mutationId:'area-identity-integration-0001',command:{type:'area.create',projectId:'p1',name:'Map',aliases:[]}},{db,handlers:workspaceHandlers,now:()=>now});
  assert.equal(result.status,'committed');const created=result.envelope.workspace.areas![0];
  const event=sqlite.prepare('SELECT entity_id,payload_json FROM audit_events WHERE user_id=?').get('owner')!;
  assert.equal(event.entity_id,created.id);const payload=JSON.parse(String(event.payload_json));assert.equal(payload.entityId,created.id);assert.deepEqual(payload.changes,[{path:['areas',created.id],before:{exists:false,value:null},after:{exists:true,value:created}}]);
 }finally{sqlite.close();}
});
test('merge preview retains archived areas and task classification without inferring lifecycle authority',()=>{
 const source=incoming(),original=structuredClone(source),preview=previewPlanningMerge(fixture(),source,selection);
 assert.deepEqual(preview.workspace.areas,[area]);assert.equal(preview.workspace.tasks[0].areaId,area.id);assert.equal(preview.workspace.tasks[0].workType,'review');assert.equal(preview.workspace.tasks[0].status,'proposed');assert.equal(preview.workspace.tasks[0].notes,source.tasks[0].notes);assert.equal(preview.workspace.tasks[0].evidence,source.tasks[0].evidence);assert.deepEqual(source,original);
 const rename=structuredClone(preview.workspace);rename.areas![0].name='Updated map';const conflict=previewPlanningMerge(preview.workspace,rename,{...selection,tasks:[]});assert.equal(conflict.conflicts[0].collection,'areas');assert.equal(conflict.workspace.areas![0].id,area.id);
});
test('reviewed import merge and export retain area identities, aliases, archives and classification',async()=>{
 const {db,sqlite}=database();try{
  await loadWorkspace(db,'owner',fixture,now);await loadWorkspace(db,'other',fixture,now);
  const stage=await stageImport(db,'owner',new TextEncoder().encode(JSON.stringify(incoming())),now);assert.deepEqual(stage.diagnostics,[]);
  const result=await executeWorkspaceCommand('owner',{protocolVersion:1,expectedRevision:1,mutationId:'area-import-integration-0001',command:{type:'workspace.import.commit',importId:stage.id,hash:stage.hash,targetRevision:1,mode:'merge',selection}},{db,handlers:workspaceHandlers,now:()=>now});assert.equal(result.status,'committed');
  const current=(await readCurrent(db,'owner')).workspace;assert.deepEqual(current.areas,[area]);assert.equal(current.tasks[0].areaId,area.id);assert.equal(current.tasks[0].workType,'review');assert.equal(current.tasks[0].status,'proposed');assert.deepEqual((await readCurrent(db,'other')).workspace,fixture());
  const bundle=await exportWorkspaceBundle(db,'owner');assert.deepEqual(parseWorkspaceBundle(bundle).planning,current);assert.equal(bundle.source.planningSchemaVersion,5);
 }finally{sqlite.close();}
});
test('archived areas block project deletion even with no task or milestone descendants',async()=>{
 const ws=fixture();ws.projects[0].archivedAt=now;ws.areas=[structuredClone(area)];
 const preview=await previewEntityDeletion(ws,'project','p1',1);assert.equal(preview.canDelete,false);assert.ok(preview.blockers.length>0);assert.ok(preview.references.some(reference=>reference.id===area.id));assert.deepEqual(ws.areas,[area]);
});
test('reviewed replace restores archived area metadata and task owner fields losslessly',async()=>{
 const {db,sqlite}=database();try{
  await loadWorkspace(db,'owner',fixture,now);const source=incoming();
  const stage=await stageImport(db,'owner',new TextEncoder().encode(JSON.stringify(source)),now);assert.deepEqual(stage.diagnostics,[]);
  const result=await executeWorkspaceCommand('owner',{protocolVersion:1,expectedRevision:1,mutationId:'area-replace-integration-0001',command:{type:'workspace.import.commit',importId:stage.id,hash:stage.hash,targetRevision:1,mode:'replace'}},{db,handlers:workspaceHandlers,now:()=>now});
  assert.equal(result.status,'committed');assert.deepEqual((await readCurrent(db,'owner')).workspace,source);
  const bundle=await exportWorkspaceBundle(db,'owner');assert.deepEqual(bundle.planning,source);assert.deepEqual(parseWorkspaceBundle(bundle).planning,source);
 }finally{sqlite.close();}
});
test('merging a classified task without its missing area rejects rather than dropping classification',()=>{
 const source=incoming(),current=fixture(),before=structuredClone(current);
 assert.throws(()=>previewPlanningMerge(current,source,{...selection,areas:[]}),/area/i);assert.deepEqual(current,before);
});
