import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {createSeedWorkspace} from '../lib/seed.ts';
import {stageImport,readStagedImport} from '../lib/import-staging.ts';
import {reviewedImportHandler} from '../lib/workspace-import-handler.ts';
import {ownerReader} from '../lib/workspace-modules.ts';
import {exportRegistry,ownerExportModule,canonical,contentHash} from '../lib/workspace-export.ts';
import type {PrepareContext} from '../lib/workspace-transaction.ts';
const now='2026-10-18T00:00:00.000Z';
function setup(){const result=database();result.sqlite.exec('CREATE TABLE IF NOT EXISTS workspace_imports(user_id TEXT NOT NULL,id TEXT NOT NULL,content_hash TEXT NOT NULL,created_at TEXT NOT NULL,expires_at TEXT NOT NULL,bytes INTEGER NOT NULL,metadata_json TEXT NOT NULL,PRIMARY KEY(user_id,id));CREATE TABLE IF NOT EXISTS workspace_import_chunks(user_id TEXT NOT NULL,import_id TEXT NOT NULL,ordinal INTEGER NOT NULL,content_base64 TEXT NOT NULL,PRIMARY KEY(user_id,import_id,ordinal))');return result;}
async function fixture(){const {db,sqlite}=setup();const workspace=createSeedWorkspace(now);const stage=await stageImport(db,'a',new TextEncoder().encode(JSON.stringify(workspace)),now);const context:PrepareContext={readImport:id=>readStagedImport(db,'a',id,now),userId:'a',before:{workspace,revision:5,updatedAt:now},now,query:ownerReader(db,'a'),command:{type:'workspace.import.commit',importId:stage.id,hash:stage.hash,targetRevision:5,mode:'replace'}};return {db,sqlite,stage,context};}
test('reviewed restore preparation requests backup and epoch rotation without touching stage or workspace',async()=>{
 const {db,sqlite,stage,context}=await fixture();const plan=await reviewedImportHandler.prepare(context);assert.equal(plan.restoreEpoch,true);assert.deepEqual(plan.backup,{reason:'restore'});assert.equal(plan.events[0].kind,'workspace.import.commit');assert.equal(plan.events[0].actorId,'a');assert.equal(plan.events[0].sourceRef,stage.hash);assert.deepEqual(plan.writes,[]);assert.deepEqual(plan.jobs,[]);assert.equal((await readStagedImport(db,'a',stage.id,now)).stage.hash,stage.hash);assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workspace_mutations').get()!.n,0);sqlite.close();
});
test('owner, digest, target revision, invalid stage and extra command fields fail closed',async()=>{
 const {db,sqlite,context}=await fixture();for(const patch of [{userId:'b',query:ownerReader(db,'b'),readImport:(id:string)=>readStagedImport(db,'b',id,now)},{command:{...context.command,hash:'0'.repeat(64)}},{command:{...context.command,targetRevision:4}},{command:{...context.command,approval:true}}])await assert.rejects(reviewedImportHandler.prepare({...context,...patch} as PrepareContext));
 const invalid=await stageImport(db,'a',new TextEncoder().encode('{bad'),now);await assert.rejects(reviewedImportHandler.prepare({...context,command:{...context.command,importId:invalid.id,hash:invalid.hash}}));assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workspace_mutations').get()!.n,0);sqlite.close();
});
test('replace refuses existing normalized data omitted by a legacy planning import',async()=>{
 const {sqlite,context}=await fixture();sqlite.prepare('INSERT INTO evidence_records(user_id,id,row_revision,payload_json,content_hash) VALUES(?,?,1,?,?)').run('a','ev','{}','hash');await assert.rejects(reviewedImportHandler.prepare(context),/normalized/);assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM evidence_records').get()!.n,1);sqlite.close();
});
test('merge requires explicit selection and retains source lifecycle as provenance only',async()=>{
 const {db,sqlite,context}=await fixture();const incoming=structuredClone(context.before.workspace);const task={...incoming.tasks[0],id:'imported-task',status:'done' as const,weekly:true,weeklyWeek:'2026-10-12',completedAt:now,dependsOn:[],blocker:''};incoming.tasks.push(task);const stage=await stageImport(db,'a',new TextEncoder().encode(JSON.stringify(incoming)),now);const command={...context.command,importId:stage.id,hash:stage.hash,mode:'merge'};
 await assert.rejects(reviewedImportHandler.prepare({...context,command}),/selection/);
 const plan=await reviewedImportHandler.prepare({...context,command:{...command,selection:{projects:[],milestones:[],tasks:['imported-task'],captures:[],activity:[]}}});const imported=plan.planningAfter.tasks.find(row=>row.id==='imported-task')!;assert.equal(imported.status,'proposed');assert.ok(!imported.weekly);assert.ok(plan.historyImports?.some(row=>(row.source as {id?:string}).id==='imported-task'));assert.equal(context.before.workspace.tasks.some(row=>row.id==='imported-task'),false);sqlite.close();
});

test('audit source claims append as namespaced provenance and normalized replacement is a dry-run plan',async()=>{
 const {db,sqlite,context}=await fixture();exportRegistry.register(ownerExportModule('evidence_records',()=>{}));const value={summary:'incoming evidence'};const source={id:'source-event',kind:'task.completed',payload:{claim:'historical only'}};
 const bundle={format:'control-room',bundleVersion:1,exportedAt:now,source:{workspaceRevision:2,planningSchemaVersion:context.before.workspace.schemaVersion,moduleWatermarks:{},sourceHashes:{}},planning:context.before.workspace,modules:{audit_events:{schemaVersion:1,records:[source]},evidence_records:{schemaVersion:1,records:[{id:'ev-new',rowRevision:1,contentHash:await contentHash(canonical(value)),value}]}},attachments:[],completeness:'metadata-only'};
 sqlite.prepare('INSERT INTO evidence_records(user_id,id,row_revision,payload_json,content_hash) VALUES(?,?,1,?,?)').run('a','ev-old','{}','oldhash');const stage=await stageImport(db,'a',new TextEncoder().encode(JSON.stringify(bundle)),now);assert.deepEqual(stage.diagnostics,[]);const command={...context.command,importId:stage.id,hash:stage.hash};const plan=await reviewedImportHandler.prepare({...context,command});assert.deepEqual(plan.historyImports,[{id:`import_${stage.hash}_0`,source,importHash:stage.hash}]);assert.deepEqual(plan.replacements?.[0].records,[{id:'ev-new',value}]);assert.equal(plan.replacements?.[0].beforeRows[0].id,'ev-old');assert.equal(sqlite.prepare('SELECT id FROM evidence_records').get()!.id,'ev-old');await assert.rejects(reviewedImportHandler.prepare({...context,command:{...command,mode:'merge',selection:{projects:[],milestones:[],tasks:[],captures:[],activity:[]}}}),/Normalized module merge/);assert.equal((await readStagedImport(db,'a',stage.id,now)).stage.hash,stage.hash);sqlite.close();
});

test('reviewed repaired import retains full source repair as untrusted provenance',async()=>{
 const {db,sqlite,context,stage:parent}=await fixture();
 const report={sourceHash:parent.hash,operation:{type:'migrate'},changes:[],excludedRecords:[],warnings:['Review original source']};
 const repaired=await stageImport(db,'a',new TextEncoder().encode(JSON.stringify(context.before.workspace)),now,{parentId:parent.id,parentHash:parent.hash,reports:[JSON.stringify(report)]});
 const plan=await reviewedImportHandler.prepare({...context,command:{...context.command,importId:repaired.id,hash:repaired.hash}});
 assert.ok(plan.historyImports?.some(item=>(item.source as {kind?:string}).kind==='import-repair'));
 assert.equal((plan.historyImports?.find(item=>(item.source as {kind?:string}).kind==='import-repair')?.source as {report:unknown}).report!==undefined,true);
 assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM workspace_mutations').get()!.n,0);sqlite.close();
});
