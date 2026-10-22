import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {Miniflare} from 'miniflare';
import {loadWorkspace,type SqlDatabase} from '../lib/workspace-store.ts';
import {workspaceFixture} from './helpers/workspace.ts';
import {executeWorkspaceCommand} from '../lib/workspace-transaction.ts';
import {workspaceHandlers} from '../lib/workspace-handlers.ts';
import {contentHash} from '../lib/canonical-json.ts';
import {historyRecoveryAdmission} from '../lib/history/admission.ts';
import {ingestHistoryPage,readHistoryRecord,listHistoryRecords} from '../lib/history/store.ts';
const owner='synthetic-d1-history-owner',foreign='synthetic-d1-history-foreign',now='2026-10-22T12:00:00.000Z';
test('actual thirty-migration D1 atomically admits 250 unavailable messages with bounded bindings and replay/CAS/owner/epoch fences',{timeout:120000},async t=>{
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("synthetic history D1 proof")}}',d1Databases:{DB:'synthetic-history-ingest-d1'}});
 try{
  const native=await mf.getD1Database('DB');
  const migrations=(await readdir(new URL('../drizzle/',import.meta.url))).filter(name=>/^\d+.*\.sql$/u.test(name)).sort();assert.equal(migrations.length,30);
  for(const name of migrations)for(const sql of (await readFile(new URL('../drizzle/'+name,import.meta.url),'utf8')).split('--> statement-breakpoint'))if(sql.trim())await native.prepare(sql.trim()).run();
  let maxBindings=0,prepared=0;
  const db:SqlDatabase={prepare(sql){prepared++;const statement=native.prepare(sql);return {bind(...values){maxBindings=Math.max(maxBindings,values.length);assert.ok(values.length<=100,'History D1 statement exceeds 100 bound parameters.');assert.ok(new TextEncoder().encode(JSON.stringify(values)).byteLength<=2*1024*1024,'History D1 statement exceeds bounded metadata argument size.');return statement.bind(...values);},first:()=>statement.first(),all:()=>statement.all(),run:()=>statement.run()};},batch:statements=>native.batch(statements as never)};
  for(const user of [owner,foreign]){
   await loadWorkspace(db,user,()=>workspaceFixture(),now);
   const configured=await executeWorkspaceCommand(user,{protocolVersion:1,expectedRevision:1,mutationId:crypto.randomUUID(),command:{type:'history.source.configure',sourceId:'source',expectedRowRevision:null,kind:'codex_local',scopeLabel:'Synthetic selected device',roots:['synthetic-root'],accountId:null,deviceId:null,includeArchived:true,exclusions:[]}},{db,now:()=>now,handlers:workspaceHandlers});
   assert.equal(configured.status,'committed');
  }
  const source=await readHistoryRecord(db,owner,'source','source');assert.ok(source);
  const epoch=source.record.value.epoch,scopeRevision=source.record.value.scopeRevision;
  const knownDigest=await contentHash('synthetic provider-known unavailable content');
  const messages=Array.from({length:250},(_,i)=>({id:'message-'+i,conversationId:'conversation',nativeMessageId:'native-'+i,revisionDigest:knownDigest,normalizationVersion:'unicode-v1',parentNativeMessageId:null,sequence:i,role:'assistant' as const,occurredAt:null,observedAt:now,bodyObjectKey:'unavailable:synthetic-'+i,contentBytes:0,availability:'unavailable' as const}));
  const envelope={protocolVersion:1,epoch,scopeRevision,page:{codecVersion:1,sourceId:'source',runId:'run',pageId:'first',previousCursor:null,nextCursor:'next',inventoryExhausted:false,conversations:[{id:'conversation',sourceId:'source',nativeThreadId:'native-thread',sessionTreeId:null,parentConversationId:null,title:'Synthetic unavailable transcript',projectId:null,repositoryIdentity:null,branch:null,createdAt:null,sourceUpdatedAt:null,archived:false,availability:'partial'}],messages,segments:[],attachments:[],gaps:[],objectManifest:[]}};
  const options={now,prepareAdmission:historyRecoveryAdmission(db)};
  const first=await ingestHistoryPage(db,owner,envelope,options);assert.equal(first.status,'committed');
  const replay=await ingestHistoryPage(db,owner,envelope,options);assert.equal(replay.status,'replayed');assert.deepEqual(first.receipt,replay.receipt);
  const retained=await listHistoryRecords(db,owner,'message',{limit:200});assert.equal(retained.length,200);assert.equal((await listHistoryRecords(db,owner,'message',{limit:200,after:retained.at(-1)!.record.id})).length,50);
  assert.equal((await listHistoryRecords(db,foreign,'message')).length,0);
  await assert.rejects(ingestHistoryPage(db,foreign,envelope,options),/generation|epoch/u);
  await assert.rejects(ingestHistoryPage(db,owner,{...envelope,epoch:'stale-epoch'},options),/generation|epoch/u);
  await assert.rejects(ingestHistoryPage(db,owner,{...envelope,page:{...envelope.page,nextCursor:'changed'}},options),/digest/u);
  const before=(await db.prepare('SELECT id,row_revision,content_hash FROM project_history WHERE user_id=? ORDER BY id').bind(owner).all<Record<string,unknown>>()).results;
  const second={...envelope,page:{...envelope.page,pageId:'second',previousCursor:'next',nextCursor:null,inventoryExhausted:true,conversations:[],messages:[]}};
  const lost=await ingestHistoryPage(db,owner,second,{...options,beforeCommit:async()=>{await native.prepare('UPDATE project_history SET row_revision=row_revision+1 WHERE user_id=? AND id=?').bind(owner,source.record.id).run();}});assert.equal(lost.status,'conflict');
  const after=(await db.prepare('SELECT id,row_revision,content_hash FROM project_history WHERE user_id=? ORDER BY id').bind(owner).all<Record<string,unknown>>()).results;
  assert.deepEqual(after,before.map(row=>({...row,row_revision:row.id===source.record.id?Number(row.row_revision)+1:row.row_revision})));assert.equal((await listHistoryRecords(db,owner,'ingest_page')).length,1);assert.equal((await listHistoryRecords(db,owner,'cursor'))[0].record.value.cursor,'next');
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM workspace_job_intents WHERE user_id=? AND kind='area_analysis'").bind(owner).first<{n:number}>())!.n,1);
  assert.equal((await db.prepare('SELECT revision FROM workspaces WHERE user_id=?').bind(owner).first<{revision:number}>())!.revision,2);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM history_object_ledger WHERE user_id=?').bind(owner).first<{n:number}>())!.n,0);
  assert.ok(prepared>250);assert.ok(maxBindings>0&&maxBindings<=100);t.diagnostic(`Maximum bound parameters: ${maxBindings}; prepared statements: ${prepared}.`);
 }finally{await mf.dispose();}
});
