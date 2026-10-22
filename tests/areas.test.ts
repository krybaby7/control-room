import test from 'node:test';
import assert from 'node:assert/strict';
import {createSeedWorkspace} from '../lib/seed.ts';
import {applyCommand} from '../lib/planning.ts';
const now='2026-10-22T10:00:00.000Z';
test('area owner commands retain identity on rename and archive, reject duplicate names',()=>{
 const ws=createSeedWorkspace(now),projectId=ws.projects[0].id;
 const created=applyCommand(ws,{type:'area.create',projectId,name:'Android testing',aliases:[]},now);
 assert.equal(created.areas?.length,1);const id=created.areas![0].id;
 assert.throws(()=>applyCommand(created,{type:'area.create',projectId,name:' android TESTING ',aliases:[]},now),/duplicate|already/i);
 const renamed=applyCommand(created,{type:'area.update',id,patch:{name:'Android acceptance'}},now);
 assert.equal(renamed.areas![0].id,id);assert.ok(renamed.areas![0].aliases.includes('Android testing'));
 const archived=applyCommand(renamed,{type:'area.archive',id},now);assert.equal(archived.areas![0].archivedAt,now);
 assert.equal(applyCommand(archived,{type:'area.restore',id},now).areas![0].archivedAt,null);
});
import {parseWorkspaceExport} from '../lib/workspace-validation.ts';
import {applyWorkflowCommand} from '../lib/planning-workflows.ts';
const taskInput=(projectId:string)=>({projectId,milestoneId:null,title:'Synthetic task',notes:'owner notes',status:'todo',horizon:'later',priority:'normal',dueDate:null,weekly:false,dependsOn:[],blocker:'',sourceUrl:null,evidence:''});
test('classification rejects missing, foreign and newly assigned archived areas; preserves existing links',()=>{
 let ws=createSeedWorkspace(now);const projectId=ws.projects[0].id,foreign=ws.projects[1].id;
 ws=applyCommand(ws,{type:'area.create',projectId,name:'Map'},now);const areaId=ws.areas![0].id;
 assert.throws(()=>applyCommand(ws,{type:'task.create',task:{...taskInput(projectId),areaId:'missing'}},now),/area/i);
 assert.throws(()=>applyCommand(ws,{type:'task.create',task:{...taskInput(foreign),areaId}},now),/area/i);
 ws=applyCommand(ws,{type:'task.create',task:{...taskInput(projectId),areaId,workType:'review'}},now);const task=ws.tasks.at(-1)!;
 ws=applyCommand(ws,{type:'area.archive',id:areaId},now);
 assert.equal(parseWorkspaceExport(ws).tasks.at(-1)!.areaId,areaId);
 ws=applyCommand(ws,{type:'task.update',id:task.id,patch:{notes:'changed'}},now);assert.equal(ws.tasks.at(-1)!.areaId,areaId);
 assert.throws(()=>applyCommand(ws,{type:'task.create',task:{...taskInput(projectId),areaId}},now),/active area/i);
 const moved=applyWorkflowCommand(ws,{type:'task.move',ids:[task.id],projectId:foreign,milestoneId:null},{now,newId:()=>crypto.randomUUID()}).workspace;
 assert.equal(moved.tasks.at(-1)!.areaId,null);assert.equal(moved.tasks.at(-1)!.workType,'review');
 const invalid=structuredClone(ws);invalid.tasks.at(-1)!.projectId=foreign;assert.throws(()=>parseWorkspaceExport(invalid),/area/i);
});
test('area aliases and normalized conflicts are validated atomically',()=>{
 let ws=createSeedWorkspace(now);const projectId=ws.projects[0].id;
 ws=applyCommand(ws,{type:'area.create',projectId,name:'Map',aliases:['Cartography']},now);const before=structuredClone(ws);
 assert.throws(()=>applyCommand(ws,{type:'area.create',projectId,name:'ＣＡＲＴＯＧＲＡＰＨＹ'},now),/duplicate/i);
 assert.throws(()=>applyCommand(ws,{type:'area.update',id:ws.areas![0].id,patch:{aliases:['x',' X ']}},now),/duplicate/i);
 assert.deepEqual(ws,before);assert.throws(()=>applyCommand(ws,{type:'area.delete',id:ws.areas![0].id},now));
});
import {database} from './helpers/sqlite.ts';
import {loadWorkspace,readCurrent} from '../lib/workspace-store.ts';
import {executeWorkspaceCommand} from '../lib/workspace-transaction.ts';
import {workspaceHandlers} from '../lib/workspace-handlers.ts';
test('area commands share owner transaction receipts, retry identity and revision CAS',async()=>{
 const {db,sqlite}=database();await loadWorkspace(db,'area-owner',()=>createSeedWorkspace(now),now);await loadWorkspace(db,'other-owner',()=>createSeedWorkspace(now),now);
 const workspace=(await readCurrent(db,'area-owner')).workspace,projectId=workspace.projects[0].id;
 const input={protocolVersion:1 as const,expectedRevision:1,mutationId:'area-synthetic-mutation-0001',command:{type:'area.create',projectId,name:'Map',aliases:[]}};
 const deps={db,handlers:workspaceHandlers,now:()=>now};
 try{
  const created=await executeWorkspaceCommand('area-owner',input,deps);assert.equal(created.status,'committed');assert.equal(created.envelope.workspace.areas!.length,1);
  const retry=await executeWorkspaceCommand('area-owner',input,deps);assert.ok(retry.status!=='conflict');assert.equal(retry.receipt.appliedRevision,created.receipt.appliedRevision);assert.deepEqual(retry.envelope.workspace.areas,created.envelope.workspace.areas);
  const conflict=await executeWorkspaceCommand('area-owner',{...input,mutationId:'area-synthetic-mutation-0002',command:{...input.command,name:'Second'}},deps);assert.deepEqual(conflict,{status:'conflict',currentRevision:2});
  assert.equal((await readCurrent(db,'other-owner')).workspace.areas!.length,0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM workspace_mutations WHERE user_id=?').get('area-owner')!.n,1);
  const event=sqlite.prepare('SELECT payload_json FROM audit_events WHERE user_id=?').get('area-owner')!;assert.equal(JSON.parse(String(event.payload_json)).changes[0].path[0],'areas');
 }finally{sqlite.close();}
});
