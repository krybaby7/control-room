import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {createSeedWorkspace} from '../lib/seed.ts';
import {loadWorkspace} from '../lib/workspace-store.ts';
import {executeWorkspaceCommand} from '../lib/workspace-transaction.ts';
import {workspaceHandlers} from '../lib/workspace-handlers.ts';
import {readHistoryRecord} from '../lib/history/store.ts';
const now='2026-10-22T12:00:00.000Z';
test('source configuration uses owner receipt/CAS, rotates scope and never claims verified access',async()=>{
 const {db,sqlite}=database();try{
  await loadWorkspace(db,'synthetic-owner',()=>createSeedWorkspace(now),now);let revision=1;
  const send=async(command:Record<string,unknown>,mutationId:string)=>{const result=await executeWorkspaceCommand('synthetic-owner',{protocolVersion:1,expectedRevision:revision,mutationId,command:command as never},{db,now:()=>now,handlers:workspaceHandlers});if(result.status!=='conflict')revision=result.envelope.revision;return result;};
  const command={type:'history.source.configure',sourceId:'source-a',expectedRowRevision:null,kind:'codex_local',scopeLabel:'Selected synthetic device',roots:['selected-root'],accountId:null,deviceId:null,includeArchived:true,exclusions:[]};
  assert.equal((await send(command,'history_source_create_01')).status,'committed');
  const source=(await readHistoryRecord(db,'synthetic-owner','source','source-a'))!;
  assert.equal(source.record.value.capability.unattendedRead,false);assert.equal(source.record.value.capability.verifiedAt,null);
  assert.equal((await send(command,'history_source_create_01')).status,'replayed');
  await assert.rejects(send({...command,expectedRowRevision:999},'history_source_stale_01'),/revision/);
  const result=await send({type:'history.source.disconnect',sourceId:'source-a',expectedRowRevision:source.rowRevision},'history_source_pause_01');assert.equal(result.status,'committed');
  const paused=(await readHistoryRecord(db,'synthetic-owner','source','source-a'))!;assert.equal(paused.record.value.paused,true);assert.notEqual(paused.record.value.epoch,source.record.value.epoch);assert.equal(paused.record.value.scopeRevision,2);
  assert.equal(await readHistoryRecord(db,'foreign-owner','source','source-a'),null);
 }finally{sqlite.close();}
});

test('reviewed removal fences the source and keeps owner records and retained evidence',async()=>{
 const {db,sqlite}=database();try{
  const owner='synthetic-removal';await loadWorkspace(db,owner,()=>createSeedWorkspace(now),now);let revision=1;
  const send=async(command:Record<string,unknown>,mutationId:string)=>{const result=await executeWorkspaceCommand(owner,{protocolVersion:1,expectedRevision:revision,mutationId,command:command as never},{db,now:()=>now,handlers:workspaceHandlers});if(result.status!=='conflict')revision=result.envelope.revision;return result;};
  await send({type:'history.source.configure',sourceId:'source-a',expectedRowRevision:null,kind:'codex_local',scopeLabel:'Synthetic',roots:[],accountId:null,deviceId:null,includeArchived:true,exclusions:[]},'history_remove_setup_001');
  await assert.rejects(send({type:'history.source.configure',sourceId:'source-a',expectedRowRevision:1,kind:'claude_code_local',scopeLabel:'Synthetic',roots:[],accountId:null,deviceId:null,includeArchived:true,exclusions:[]},'history_remove_kind_001'),/different provider/);
  await assert.rejects(send({type:'history.source.remove',sourceId:'source-a',expectedRowRevision:1,previewDigest:'a'.repeat(64),reason:'Owner request'},'history_remove_live_001'),/Pause/);
  await send({type:'history.source.disconnect',sourceId:'source-a',expectedRowRevision:1},'history_remove_pause_001');
  const {ownerReader}=await import('../lib/workspace-modules.ts');const {previewHistoryRemoval}=await import('../lib/history/removal.ts');
  const preview=await previewHistoryRemoval(ownerReader(db,owner),'source-a');
  await assert.rejects(send({type:'history.source.remove',sourceId:'source-a',expectedRowRevision:2,previewDigest:'b'.repeat(64),reason:'Owner request'},'history_remove_stale_001'),/impact changed/);
  const before=(await db.prepare('SELECT content FROM workspaces WHERE user_id=?').bind(owner).first<{content:string}>());
  const result=await send({type:'history.source.remove',sourceId:'source-a',expectedRowRevision:2,previewDigest:preview.digest,reason:'Owner request'},'history_remove_apply_001');assert.equal(result.status,'committed');
  const removed=await readHistoryRecord(db,owner,'source','source-a');assert.equal(removed!.record.value.removedAt,now);assert.equal(removed!.record.value.paused,true);
  assert.equal((await db.prepare("SELECT COUNT(*) count FROM project_history WHERE user_id=? AND json_extract(payload_json,'$.kind')='source_removal'").bind(owner).first<{count:number}>())!.count,1);
  assert.equal((await db.prepare('SELECT content FROM workspaces WHERE user_id=?').bind(owner).first<{content:string}>())!.content,before!.content);
  await assert.rejects(send({type:'history.source.resume',sourceId:'source-a',expectedRowRevision:3},'history_remove_resume_001'),/Removed source/);
 }finally{sqlite.close();}
});

test('a removal preview cannot commit across an independently changed history row set',async()=>{
 const {db,sqlite}=database();try{
  const owner='synthetic-removal-race';await loadWorkspace(db,owner,()=>createSeedWorkspace(now),now);
  const send=(expectedRevision:number,command:unknown,mutationId:string,handlers=workspaceHandlers)=>executeWorkspaceCommand(owner,{protocolVersion:1,expectedRevision,mutationId,command},{db,now:()=>now,handlers});
  await send(1,{type:'history.source.configure',sourceId:'source-race',expectedRowRevision:null,kind:'codex_local',scopeLabel:'Synthetic',roots:[],accountId:null,deviceId:null,includeArchived:true,exclusions:[]},'history_removal_race_cfg');
  await send(2,{type:'history.source.pause',sourceId:'source-race',expectedRowRevision:1},'history_removal_race_pause');
  const {ownerReader}=await import('../lib/workspace-modules.ts'),{previewHistoryRemoval}=await import('../lib/history/removal.ts'),{historyRecordId}=await import('../lib/history/record.ts'),{canonical,contentHash}=await import('../lib/canonical-json.ts');
  const preview=await previewHistoryRemoval(ownerReader(db,owner),'source-race'),handlers=new Map(workspaceHandlers),original=handlers.get('history.source.remove')!;
  handlers.set('history.source.remove',{async prepare(ctx){const plan=await original.prepare(ctx),id=await historyRecordId('gap','new-gap'),record={id,kind:'gap',value:{id:'new-gap',sourceId:'source-race',conversationId:null,kind:'access',explanation:'Independent retained gap',detectedAt:now,resolvedAt:null}},payload=canonical(record);await db.prepare('INSERT INTO project_history(user_id,id,row_revision,payload_json,content_hash) VALUES(?,?,1,?,?)').bind(owner,id,payload,await contentHash(payload)).run();return plan;}});
  await assert.rejects(send(3,{type:'history.source.remove',sourceId:'source-race',expectedRowRevision:2,previewDigest:preview.digest,reason:'Reviewed request'},'history_removal_race_apply',handlers));
  assert.equal((await readHistoryRecord(db,owner,'source','source-race'))!.record.value.removedAt,null);
  assert.equal((await db.prepare('SELECT revision FROM workspaces WHERE user_id=?').bind(owner).first<{revision:number}>())!.revision,3);
  assert.equal((await db.prepare("SELECT COUNT(*) count FROM project_history WHERE user_id=? AND json_extract(payload_json,'$.kind')='source_removal'").bind(owner).first<{count:number}>())!.count,0);
  assert.equal((await db.prepare("SELECT COUNT(*) count FROM workspace_job_intents WHERE user_id=? AND kind='area_analysis'").bind(owner).first<{count:number}>())!.count,0);
 }finally{sqlite.close();}
});
