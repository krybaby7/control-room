import {test} from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {workspaceFixture} from './helpers/workspace.ts';
import {loadWorkspace} from '../lib/workspace-store.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {historyRecordId} from '../lib/history/record.ts';
import {historyRecoveryAdmission} from '../lib/history/admission.ts';
import {ingestHistoryPage,listHistoryRecords} from '../lib/history/store.ts';
const owner='synthetic-admitted-history-owner',now='2026-10-22T00:00:00.000Z';
async function fixture(){
 const {db,sqlite}=database();await loadWorkspace(db,owner,()=>workspaceFixture(),now);
 const id=await historyRecordId('source','source');
 const value={id:'source',configuration:{codecVersion:1,sourceId:'source',kind:'codex_local',epoch:'epoch',scopeRevision:1,roots:['synthetic-root'],accountId:null,deviceId:null,includeArchived:true,exclusions:[],parserVersion:'v1',normalizationVersion:'v1'},capability:{sourceId:'source',kind:'codex_local',scopeLabel:'synthetic',inventory:'verified',contentRead:'verified',unattendedRead:false,verifiedAt:now,proofRef:'synthetic-proof',limitation:null},epoch:'epoch',scopeRevision:1,executionEpoch:0,paused:false,removedAt:null};
 const payload=canonical({id,kind:'source',value});await db.prepare('INSERT INTO project_history(user_id,id,row_revision,payload_json,content_hash,stream_sequence) VALUES(?,?,1,?,?,0)').bind(owner,id,payload,await contentHash(payload)).run();
 const envelope={protocolVersion:1,epoch:'epoch',scopeRevision:1,page:{codecVersion:1,sourceId:'source',runId:'run',pageId:'page',previousCursor:null,nextCursor:'next',inventoryExhausted:false,conversations:[{id:'conversation',sourceId:'source',nativeThreadId:'thread',sessionTreeId:null,parentConversationId:null,title:'synthetic title',projectId:null,repositoryIdentity:null,branch:null,createdAt:null,sourceUpdatedAt:null,archived:false,availability:'partial'}],messages:[],segments:[],attachments:[],gaps:[],objectManifest:[]}};
 return {db,sqlite,envelope,options:{now,prepareAdmission:historyRecoveryAdmission(db)}};
}
test('actual portable serializer and private capacity admit immutable acknowledgement and subsequent cursor update',async()=>{const f=await fixture();try{
 assert.equal((await ingestHistoryPage(f.db,owner,f.envelope,f.options)).status,'committed');
 const second={...f.envelope,page:{...f.envelope.page,pageId:'second',previousCursor:'next',nextCursor:null,inventoryExhausted:true,conversations:[{...f.envelope.page.conversations[0],title:'synthetic updated metadata'}]}};
 assert.equal((await ingestHistoryPage(f.db,owner,second,f.options)).status,'committed');
 assert.equal((await ingestHistoryPage(f.db,owner,f.envelope,f.options)).status,'replayed');
 assert.equal((await listHistoryRecords(f.db,owner,'ingest_page')).length,2);
 assert.equal((await f.db.prepare('SELECT revision FROM workspaces WHERE user_id=?').bind(owner).first<{revision:number}>())!.revision,1);
 assert.equal((await f.db.prepare("SELECT COUNT(*) n FROM workspace_job_intents WHERE user_id=? AND kind='area_analysis'").bind(owner).first<{n:number}>())!.n,2);
 }finally{f.sqlite.close();}});
test('real-adapter ingress rejects forged owner metadata without effects',async()=>{const f=await fixture();try{
 const before=(await f.db.prepare('SELECT * FROM project_history WHERE user_id=?').bind(owner).all()).results;
 await assert.rejects(ingestHistoryPage(f.db,owner,{...f.envelope,ownerId:'forged-owner'},f.options));
 assert.deepEqual((await f.db.prepare('SELECT * FROM project_history WHERE user_id=?').bind(owner).all()).results,before);
 assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM workspace_job_intents WHERE user_id=?').bind(owner).first<{n:number}>())!.n,0);
 }finally{f.sqlite.close();}});
test('real recoverability row ceiling rejects a page without any partial rows, acknowledgements or jobs',async()=>{const f=await fixture();try{
 const insert=f.sqlite.prepare('INSERT INTO project_history(user_id,id,row_revision,payload_json,content_hash,stream_sequence) VALUES(?,?,1,?,?,0)');
 for(let i=0;i<9995;i++){const logical='synthetic-retained-'+i,id=await historyRecordId('conversation',logical);const payload=canonical({id,kind:'conversation',value:{...f.envelope.page.conversations[0],id:logical,nativeThreadId:logical}});insert.run(owner,id,payload,await contentHash(payload));}
 await assert.rejects(ingestHistoryPage(f.db,owner,f.envelope,f.options),/capacity|row limit|row bound/iu);
 assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM project_history WHERE user_id=?').bind(owner).first<{n:number}>())!.n,9996);
 assert.equal((await listHistoryRecords(f.db,owner,'ingest_page')).length,0);
 assert.equal((await listHistoryRecords(f.db,owner,'cursor')).length,0);
 assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM workspace_job_intents WHERE user_id=?').bind(owner).first<{n:number}>())!.n,0);
 }finally{f.sqlite.close();}});
test('real serializer admits 250 immutable normalized messages with bounded private manifest SQL',async()=>{const f=await fixture();try{
 const key=`history/${crypto.randomUUID()}/${crypto.randomUUID()}`,sha256=await contentHash('synthetic body');await f.db.prepare("INSERT INTO history_object_ledger(user_id,key,source_id,epoch,scope_revision,sha256,bytes,status,pending_token,created_at,verified_at,purged_at) VALUES(?,?,?,?,?,?,?,'ready',NULL,?,?,NULL)").bind(owner,key,'source','epoch',1,sha256,14,now,now).run();
 const messages=Array.from({length:250},(_,i)=>({id:'synthetic-message-'+i,conversationId:'conversation',nativeMessageId:'native-'+i,revisionDigest:sha256,normalizationVersion:'v1',parentNativeMessageId:null,sequence:i,role:'user' as const,occurredAt:null,observedAt:now,bodyObjectKey:key,contentBytes:14,availability:'complete' as const}));
 assert.equal((await ingestHistoryPage(f.db,owner,{...f.envelope,page:{...f.envelope.page,messages,objectManifest:[{key,sha256,bytes:14}]}},f.options)).status,'committed');
 const retained=await listHistoryRecords(f.db,owner,'message',{limit:200});assert.equal(retained.length,200);assert.equal((await listHistoryRecords(f.db,owner,'message',{limit:200,after:retained.at(-1)!.record.id})).length,50);
 }finally{f.sqlite.close();}});
test('quoted full normalized row-set boundary rejects concurrent unrelated history growth',async()=>{const f=await fixture();try{
 const result=await ingestHistoryPage(f.db,owner,f.envelope,{...f.options,beforeCommit:async()=>{const logical='synthetic-concurrent-record',id=await historyRecordId('conversation',logical);const payload=canonical({id,kind:'conversation',value:{...f.envelope.page.conversations[0],id:logical,nativeThreadId:logical}});await f.db.prepare('INSERT INTO project_history(user_id,id,row_revision,payload_json,content_hash,stream_sequence) VALUES(?,?,1,?,?,0)').bind(owner,id,payload,await contentHash(payload)).run();}});
 assert.equal(result.status,'conflict');assert.equal((await listHistoryRecords(f.db,owner,'conversation')).length,1);assert.equal((await listHistoryRecords(f.db,owner,'ingest_page')).length,0);assert.equal((await listHistoryRecords(f.db,owner,'cursor')).length,0);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM workspace_job_intents WHERE user_id=?').bind(owner).first<{n:number}>())!.n,0);
 }finally{f.sqlite.close();}});
test('real serializer admits explicit unavailable metadata without inventing physical content',async()=>{const f=await fixture();try{const message={id:'unavailable-message',conversationId:'conversation',nativeMessageId:'unavailable-native',revisionDigest:'0'.repeat(64),normalizationVersion:'v1',parentNativeMessageId:null,sequence:0,role:'assistant',occurredAt:null,observedAt:now,bodyObjectKey:'unavailable:synthetic',contentBytes:0,availability:'unavailable'};assert.equal((await ingestHistoryPage(f.db,owner,{...f.envelope,page:{...f.envelope.page,messages:[message]}},f.options)).status,'committed');assert.equal((await listHistoryRecords(f.db,owner,'message')).length,1);assert.equal((await f.db.prepare('SELECT COUNT(*) n FROM history_object_ledger').first<{n:number}>())!.n,0);}finally{f.sqlite.close();}});
