import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {workspaceFixture} from './helpers/workspace.ts';
import {loadWorkspace,readCurrent,type SqlDatabase} from '../lib/workspace-store.ts';
import {workspaceHandlers} from '../lib/workspace-handlers.ts';
import {executeWorkspaceCommand} from '../lib/workspace-transaction.ts';
import {exportWorkspaceBundle} from '../lib/workspace-export.ts';
import {stageImport} from '../lib/import-staging.ts';
import {readHistoryRecord} from '../lib/history/store.ts';
import {previewHistoryRemoval} from '../lib/history/removal.ts';
import {ownerReader} from '../lib/workspace-modules.ts';
import {stageHistoryObject} from '../lib/history/object-store.ts';
import {contentHash} from '../lib/canonical-json.ts';
import {readAreaAnalysisJob,type AreaAnalysisAuthority} from '../lib/history/analysis-job-store.ts';
import {runHistoryRemovalProjection} from '../lib/history/removal-projection.ts';
const owner='synthetic-restored-removal-owner',now='2026-10-22T12:00:00.000Z';
async function fixture(){const f=database();await loadWorkspace(f.db,owner,()=>workspaceFixture(),now);
 const send=async(command:unknown,db:SqlDatabase=f.db)=>executeWorkspaceCommand(owner,{protocolVersion:1,expectedRevision:(await readCurrent(f.db,owner,now)).revision,mutationId:crypto.randomUUID(),command},{db,handlers:workspaceHandlers,now:()=>now});
 assert.equal((await send({type:'history.source.configure',sourceId:'source',expectedRowRevision:null,kind:'codex_local',scopeLabel:'Synthetic source',roots:['synthetic-root'],accountId:null,deviceId:null,includeArchived:true,exclusions:[]})).status,'committed');
 const source=(await readHistoryRecord(f.db,owner,'source','source'))!.record.value,objects=new Map<string,Uint8Array>();let reads=0,deletes=0;const bytes=new TextEncoder().encode('Synthetic retained physical bytes'),bucket={async put(key:string,data:Uint8Array){objects.set(key,data.slice());},async get(key:string){reads++;return objects.get(key)??null;},async delete(key:string){deletes++;objects.delete(key);}};
 const object=await stageHistoryObject({db:f.db,bucket,authorize:async()=>true,now:()=>now},{ownerId:owner,sourceId:'source',epoch:source.epoch,scopeRevision:source.scopeRevision,bytes,sha256:await contentHash(bytes)});
 const exported=await exportWorkspaceBundle(f.db,owner,{now:()=>now});
 // An older authentic metadata backup restored after subsequent global epochs.
 f.sqlite.prepare('INSERT INTO workspace_execution_state(user_id,epoch,restored_at) VALUES(?,4,?)').run(owner,'2026-10-22T11:00:00.000Z');
 const staged=await stageImport(f.db,owner,new TextEncoder().encode(JSON.stringify(exported)),now);assert.deepEqual(staged.diagnostics,[]);const revision=(await readCurrent(f.db,owner,now)).revision;
 assert.equal((await send({type:'workspace.import.commit',importId:staged.id,hash:staged.hash,targetRevision:revision,mode:'replace'})).status,'committed');
 const restored=(await readHistoryRecord(f.db,owner,'source','source'))!;assert.equal(restored.record.value.executionEpoch,0);assert.equal(restored.record.value.paused,true);assert.equal(f.sqlite.prepare('SELECT epoch FROM workspace_execution_state WHERE user_id=?').get(owner)!.epoch,5);
 const preview=await previewHistoryRemoval(ownerReader(f.db,owner),'source'),command={type:'history.source.remove',sourceId:'source',expectedRowRevision:restored.rowRevision,previewDigest:preview.digest,reason:'Explicit synthetic removal after reviewed restore'};
 const baselineReads=reads;return {...f,send,command,object,objects,bytes,counts:()=>({reads:reads-baselineReads,deletes})};}
test('generic cross-epoch restore can directly remove its paused source and finish metadata-only work while retaining bytes',async()=>{const f=await fixture();try{
 const ledger=f.sqlite.prepare('SELECT * FROM history_object_ledger WHERE user_id=?').all(owner);assert.equal((await f.send(f.command)).status,'committed');const removed=(await readHistoryRecord(f.db,owner,'source','source'))!;assert.equal(removed.record.value.executionEpoch,5);assert.ok(removed.record.value.removedAt);assert.equal(removed.record.value.paused,true);
 const intent=f.sqlite.prepare("SELECT id,execution_epoch FROM workspace_job_intents WHERE user_id=? AND kind='area_analysis'").get(owner)!;assert.equal(intent.execution_epoch,5);const job=(await readAreaAnalysisJob(f.db,owner,String(intent.id)))!;
 const authority:AreaAnalysisAuthority={ownerId:owner,principalRef:'synthetic-native-service',verifiedAt:now,expiresAt:'2026-10-22T13:00:00.000Z',async guardAt(){return {sql:'1=1',bindings:[]};},async pinGuardAt(){return {sql:'1=1',bindings:[]};}};
 assert.equal((await runHistoryRemovalProjection(f.db,job,{authority,now})).status,'removal_reprojected');assert.equal((await readAreaAnalysisJob(f.db,owner,job.intentId))!.status,'succeeded');assert.deepEqual(f.sqlite.prepare('SELECT * FROM history_object_ledger WHERE user_id=?').all(owner),ledger);assert.deepEqual(f.objects.get(f.object.key),f.bytes);assert.deepEqual(f.counts(),{reads:0,deletes:0});assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM review_analysis_requests WHERE user_id=?').get(owner)!.n,0);
 }finally{f.sqlite.close();}});
test('global epoch change between removal preparation and atomic commit leaves source, tombstone and job untouched',async()=>{const f=await fixture();try{
 const before=f.sqlite.prepare('SELECT * FROM project_history WHERE user_id=? ORDER BY id').all(owner),receipts=f.sqlite.prepare('SELECT * FROM workspace_mutations WHERE user_id=? ORDER BY mutation_id').all(owner),revision=(await readCurrent(f.db,owner,now)).revision;let raced=false;const commitStarts=new WeakSet();const db:SqlDatabase={prepare(sql){const statement=f.db.prepare(sql);if(sql.includes('INSERT INTO workspace_command_guards'))commitStarts.add(statement);return statement;},async batch(statements){if(!raced&&statements.some(statement=>commitStarts.has(statement))){raced=true;f.sqlite.prepare('UPDATE workspace_execution_state SET epoch=6 WHERE user_id=?').run(owner);}return f.db.batch(statements);}};
 await assert.rejects(f.send(f.command,db),/could not be confirmed/);assert.equal(raced,true);assert.deepEqual(f.sqlite.prepare('SELECT * FROM project_history WHERE user_id=? ORDER BY id').all(owner),before);assert.deepEqual(f.sqlite.prepare('SELECT * FROM workspace_mutations WHERE user_id=? ORDER BY mutation_id').all(owner),receipts);assert.equal((await readCurrent(f.db,owner,now)).revision,revision);assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM workspace_job_intents WHERE user_id=? AND kind='area_analysis'").get(owner)!.n,0);assert.deepEqual(f.counts(),{reads:0,deletes:0});
 }finally{f.sqlite.close();}});
