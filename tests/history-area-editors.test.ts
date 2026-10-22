import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {build} from 'esbuild';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {createSeedWorkspace} from '../lib/seed.ts';
import {parseWorkspaceExport} from '../lib/workspace-validation.ts';
import {applyCommand} from '../lib/planning.ts';
import {previewProjectBaseline,applyProjectBaseline,BASELINE_ID} from '../lib/project-baselines.ts';
const at='2026-10-22T10:00:00.000Z';
const directory=await mkdtemp(join(process.cwd(),'.baseline-render-area-'));
let fields:typeof import('../components/planning-editors'),tasks:typeof import('../components/task-editor'),captures:typeof import('../components/capture-editors'),ui:typeof import('../components/ui'),areas:typeof import('../components/area-editor');
try{
 const names=['planning-editors','task-editor','capture-editors','ui','area-editor'];
 for(const name of names)await build({entryPoints:[`components/${name}.tsx`],outfile:join(directory,`${name}.cjs`),bundle:true,platform:'node',format:'cjs',packages:'external',jsx:'automatic',logLevel:'silent'});
 const require=createRequire(import.meta.url);fields=require(join(directory,'planning-editors.cjs'));tasks=require(join(directory,'task-editor.cjs'));captures=require(join(directory,'capture-editors.cjs'));ui=require(join(directory,'ui.cjs'));areas=require(join(directory,'area-editor.cjs'));
}finally{await rm(directory,{recursive:true,force:true});}
function fixture(){const workspace=parseWorkspaceExport(createSeedWorkspace(at)),projectId=workspace.projects[0].id;workspace.areas=[{id:'map',projectId,name:'Map',aliases:[],order:1,archivedAt:null},{id:'archived',projectId,name:'Previous area',aliases:[],order:2,archivedAt:at},{id:'foreign',projectId:workspace.projects[1].id,name:'Foreign area',aliases:[],order:0,archivedAt:null}];return {workspace,projectId};}
test('classification choices expose exhaustive owner types and project-local active areas with explicit legacy defaults',()=>{
 const {workspace,projectId}=fixture(),html=renderToStaticMarkup(createElement(fields.TaskClassificationFields,{workspace,projectId,onChange:()=>{}}));
 assert.match(html,/Unclassified/);assert.match(html,/<option value="other" selected="">Other/);assert.match(html,/Map/);assert.doesNotMatch(html,/Previous area|Foreign area/);
 for(const label of ['Planning','Implementation','Testing','Review','Research','Decision','Operations','Other'])assert.match(html,new RegExp(`>${label}</option>`));
 const retained=renderToStaticMarkup(createElement(fields.TaskClassificationFields,{workspace,projectId,areaId:'archived',workType:'review',onChange:()=>{}}));assert.match(retained,/Previous area \(archived\)/);assert.match(retained,/<option value="archived" selected="">/);
});
test('actual task editor preserves saved classification and conversion offers explicit unclassified choices',()=>{
 const {workspace,projectId}=fixture(),task={...workspace.tasks[0],areaId:'map',workType:'review' as const};workspace.tasks[0]=task;
 const html=renderToStaticMarkup(createElement(tasks.TaskEditor,{revision:1,task,projectId,workspace,onSave:async()=>{},onClose:()=>{}}));assert.match(html,/<option value="map" selected="">Map/);assert.match(html,/<option value="review" selected="">Review/);
 const capture={id:'capture',title:'Owner thought',body:'Retained body',projectId,kind:'idea' as const,sourceUrl:null,status:'inbox' as const,createdAt:at,convertedTaskId:null};
 const convert=renderToStaticMarkup(createElement(captures.ConvertEditor,{capture,workspace,onSave:async()=>{},onClose:()=>{}}));assert.match(convert,/Area/);assert.match(convert,/Work type/);assert.match(convert,/Unclassified/);assert.match(convert,/<option value="other" selected="">Other/);
});
test('shared task context labels legacy tasks and retains archived area identity',()=>{
 const {workspace}=fixture(),task={...workspace.tasks[0],areaId:'archived',workType:'planning' as const};const html=renderToStaticMarkup(createElement(ui.TaskContext,{task,workspace,showProject:false}));assert.match(html,/Previous area \/ Planning/);assert.match(html,/Area archived/);assert.match(html,new RegExp(`${workspace.projects[0].name} / Previous area / Planning`));
 const legacy=renderToStaticMarkup(createElement(ui.TaskContext,{task:{...task,areaId:null,workType:'other'},workspace}));assert.match(legacy,/Unclassified \/ Other/);
});
test('area manager exposes stable rename and archive/restore actions without deletion',()=>{
 const {workspace}=fixture(),html=renderToStaticMarkup(createElement(areas.AreaManager,{workspace,project:workspace.projects[0],onSave:async()=>{}}));assert.match(html,/Create area/);assert.match(html,/>Edit</);assert.match(html,/>Archive</);assert.match(html,/>Restore</);assert.doesNotMatch(html,/>Delete</);
});
test('baseline proposals default to unclassified and preserve later explicit owner classification',()=>{
 const {workspace,projectId}=fixture(),proposals=previewProjectBaseline(workspace,projectId);assert.ok(proposals.length>0);assert.ok(proposals.every(value=>value.areaId===null&&value.workType==='other'));
 const applied=applyProjectBaseline(workspace,projectId,BASELINE_ID,at),task=applied.tasks.find(value=>value.id===proposals[0].id)!;assert.equal(task.areaId,null);assert.equal(task.workType,'other');
 const classified=applyCommand(applied,{type:'task.update',id:task.id,patch:{areaId:'map',workType:'review'}},at),before=structuredClone(classified.tasks);
 assert.deepEqual(applyProjectBaseline(classified,projectId,BASELINE_ID,at).tasks,before);const retained=previewProjectBaseline(classified,projectId).find(value=>value.id===task.id)!;assert.equal(retained.areaId,'map');assert.equal(retained.workType,'review');
});
