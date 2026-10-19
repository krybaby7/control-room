import test from 'node:test';
import assert from 'node:assert/strict';
import {workspaceFixture,taskFixture} from './helpers/workspace.ts';
import {buildWorkspaceBundle,ExportRegistry,BUNDLE_LIMITS,type ExportModule,type ImportContext} from '../lib/workspace-export.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
const at='2026-10-18T12:00:00.000Z';
function adapter(key:string,validate:NonNullable<ExportModule['validateReferences']>,scope?:'module'|'bundle'):ExportModule{return {key,schemaVersion:1,policy:'append-only',exportRows:async()=>[],parseAndMigrate:input=>input.records,validateReferences:validate,...(scope?{referenceValidationScope:scope}:{})};}
function input(modules:Record<string,{schemaVersion:number;records:unknown[]}>){return {planning:workspaceFixture({tasks:[taskFixture('original-task')]}),modules,workspaceRevision:7,operationalWatermarks:{sources:0},exportedAt:at};}
test('default validators run for each module with its rows, while explicitly shared whole-bundle validators run once per build',async()=>{
 const contexts:ImportContext[]=[],seenRows:unknown[][]=[],shared=(context:ImportContext,rows:unknown[])=>{contexts.push(context);seenRows.push(rows);};
 const modules={alpha:{schemaVersion:1,records:[{id:'a',text:'Original alpha'}]},beta:{schemaVersion:1,records:[{id:'b',text:'Original beta'}]}},base=input(modules),defaults=new ExportRegistry();
 defaults.register(adapter('alpha',shared));defaults.register(adapter('beta',shared));const originalInput=structuredClone(base),original=await buildWorkspaceBundle(base,{registry:defaults});assert.deepEqual(base,originalInput);
 assert.equal(contexts.length,2);assert.notEqual(contexts[0],contexts[1]);assert.equal(contexts[0].planning,base.planning);assert.equal(seenRows[0],modules.alpha.records);assert.equal(seenRows[1],modules.beta.records);
 contexts.length=0;seenRows.length=0;const scoped=new ExportRegistry();scoped.register(adapter('alpha',shared,'bundle'));scoped.register(adapter('beta',shared,'bundle'));
 assert.deepEqual(await buildWorkspaceBundle(base,{registry:scoped}),original);assert.deepEqual(base,originalInput);assert.equal(contexts.length,1);
 modules.beta.records[0].text='Later owner content';const changed=await buildWorkspaceBundle(base,{registry:scoped});assert.equal(contexts.length,2);assert.notEqual(contexts[0],contexts[1]);assert.equal(changed.source.sourceHashes.beta,await contentHash(canonical(modules.beta.records)));assert.notEqual(changed.source.sourceHashes.beta,original.source.sourceHashes.beta);
});
test('mixed default and bundle scopes preserve default invocation and distinct validator identities',async()=>{
 let shared=0,other=0;const fn=()=>{shared++;},different=()=>{other++;},registry=new ExportRegistry();
 registry.register(adapter('alpha',fn,'bundle'));registry.register(adapter('beta',fn));registry.register(adapter('gamma',fn,'bundle'));registry.register(adapter('delta',different,'bundle'));
 await buildWorkspaceBundle(input(Object.fromEntries(['alpha','beta','gamma','delta'].map(key=>[key,{schemaVersion:1,records:[]}]))),{registry});assert.equal(shared,2);assert.equal(other,1);
 assert.throws(()=>registry.register({...adapter('invalid',fn),referenceValidationScope:'unknown'} as unknown as ExportModule),/Invalid/);
});
test('an empty first module never conceals invalid later-module references or later planning mutations',async()=>{
 let calls=0;const validate=(context:ImportContext)=>{calls++;for(const raw of context.modules.beta.records){const row=raw as {taskId:string};if(!context.planning.tasks.some(task=>task.id===row.taskId))throw new Error('Exact task reference is missing.');}},registry=new ExportRegistry();
 registry.register(adapter('alpha',validate,'bundle'));registry.register(adapter('beta',validate,'bundle'));
 const base=input({alpha:{schemaVersion:1,records:[]},beta:{schemaVersion:1,records:[{id:'original-reference',taskId:'missing'}]}});
 await assert.rejects(buildWorkspaceBundle(base,{registry}),/Exact task reference/);assert.equal(calls,1);
 base.modules.beta.records=[{id:'original-reference',taskId:'original-task'}];await buildWorkspaceBundle(base,{registry});assert.equal(calls,2);
 base.planning.tasks=[];await assert.rejects(buildWorkspaceBundle(base,{registry}),/Exact task reference/);assert.equal(calls,3);
});
test('shared reference validation never skips portability, per-module rows or module hashes',async()=>{
 const validate=()=>{},registry=new ExportRegistry();registry.register(adapter('alpha',validate,'bundle'));registry.register(adapter('beta',validate,'bundle'));
 const base=input({alpha:{schemaVersion:1,records:[]},beta:{schemaVersion:1,records:[{id:'b',text:'Original'}]}}),built=await buildWorkspaceBundle(base,{registry});assert.equal(built.source.sourceHashes.beta,await contentHash(canonical(base.modules.beta.records)));assert.deepEqual(built.source.moduleWatermarks,built.source.sourceHashes);
 await assert.rejects(buildWorkspaceBundle({...base,modules:{...base.modules,beta:{schemaVersion:1,records:[{id:'b',password:'not portable'}]}}},{registry}),/Authority/);
 await assert.rejects(buildWorkspaceBundle({...base,modules:{...base.modules,beta:{schemaVersion:1,records:Array.from({length:BUNDLE_LIMITS.rows+1},(_,index)=>({id:String(index)}))}}},{registry}),/row limit/);
});

test('default validator context-container reassignment stays local to that invocation',async()=>{
 const base=input({alpha:{schemaVersion:1,records:[]},beta:{schemaVersion:1,records:[]}}),originalPlanning=base.planning,originalModules=base.modules,registry=new ExportRegistry();let second=false;
 registry.register(adapter('alpha',context=>{context.planning=workspaceFixture();context.modules={};}));
 registry.register(adapter('beta',context=>{second=true;assert.equal(context.planning,originalPlanning);assert.equal(context.modules,originalModules);assert.equal(context.planning.tasks[0].id,'original-task');}));
 const built=await buildWorkspaceBundle(base,{registry});assert.equal(second,true);assert.equal(built.planning,originalPlanning);assert.equal(base.planning,originalPlanning);assert.equal(base.modules,originalModules);
});
