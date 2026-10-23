import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {workspace} from './fixtures/history-understanding.ts';
import {loadWorkspace} from '../lib/workspace-store.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {historyRecordId,parseHistoryRecord,type HistoryRecordKind} from '../lib/history/record.ts';
import {stageHistoryObject} from '../lib/history/object-store.ts';
import {associationTarget} from '../lib/history/association.ts';
import {loadHistoryAnalysisInput} from '../lib/history/analysis-input.ts';
const now='2026-10-22T12:00:00.000Z';
async function fixture(){
 const f=database();await loadWorkspace(f.db,'owner',()=>structuredClone(workspace),now);await loadWorkspace(f.db,'foreign',()=>structuredClone(workspace),now);
 const objects=new Map<string,Uint8Array>();let gets=0;
 const bucket={async get(key:string,max:number){gets++;const bytes=objects.get(key);assert.ok(!bytes||bytes.length<=max);return bytes??null;},async put(key:string,bytes:Uint8Array){objects.set(key,bytes);},async delete(key:string){objects.delete(key);}};
 async function insert(kind:HistoryRecordKind,value:unknown,owner='owner',logicalId=(value as {id:string}).id){const record=parseHistoryRecord({kind,id:await historyRecordId(kind,logicalId),value}),payload=canonical(record),hash=await contentHash(payload);f.sqlite.prepare('INSERT INTO project_history(user_id,id,row_revision,payload_json,content_hash,stream_sequence) VALUES(?,?,1,?,?,0)').run(owner,record.id,payload,hash);return {record,hash};}
 for(const id of ['s','other'])await insert('source',{id,epoch:'e',scopeRevision:1,executionEpoch:0,paused:false,removedAt:null,configuration:{codecVersion:1,sourceId:id,kind:'codex_local',epoch:'e',scopeRevision:1,roots:[],accountId:null,deviceId:null,includeArchived:true,exclusions:[],parserVersion:'v1',normalizationVersion:'unicode-v1'},capability:{sourceId:id,kind:'codex_local',scopeLabel:'Synthetic source',inventory:'unverified',contentRead:'unverified',unattendedRead:false,verifiedAt:null,proofRef:null,limitation:'Synthetic only'}});
 for(const [id,sourceId]of [['c','s'],['other-c','other']])await insert('conversation',{id,sourceId,nativeThreadId:id,sessionTreeId:null,parentConversationId:null,title:'Project title does not grant association',projectId:'project',repositoryIdentity:'github.com/example/app',branch:null,createdAt:null,sourceUpdatedAt:null,archived:false,availability:'complete'});
 for(const [id,conversationId,sourceId]of [['m1','c','s'],['m2','c','s'],['other-m','other-c','other']]){const bytes=new TextEncoder().encode(id+' normalized immutable text'),sha256=await contentHash(bytes),object=await stageHistoryObject({db:f.db,bucket,authorize:async()=>true,now:()=>now},{ownerId:'owner',sourceId,epoch:'e',scopeRevision:1,bytes,sha256});await insert('message',{id,conversationId,nativeMessageId:id==='m2'?'m1':id,revisionDigest:sha256,normalizationVersion:'unicode-v1',parentNativeMessageId:null,sequence:0,role:'user',occurredAt:null,observedAt:now,bodyObjectKey:object.key,contentBytes:bytes.length,availability:'complete'});}
 const rule={id:'rule',projectId:'project',areaId:'app',scope:'conversation',targetIds:[associationTarget('s','c')],reason:'Synthetic owner rule',provenanceRef:'owner-mutation:synthetic',rowRevision:1};const inserted=await insert('association_rule',rule);
 return {...f,bucket,objects,insert,ruleRecord:inserted,gets:()=>gets};
}
test('actual SQLite loader retains all selected revisions, pins rows, and trusts associations only with native grants',async()=>{
 const f=await fixture();try{
  const first=await loadHistoryAnalysisInput(f.db,'owner',{sourceIds:['s'],bucket:f.bucket,now});
  assert.deepEqual(first.snapshot.messages.map(row=>row.message.id).sort(),['m1','m2']);assert.equal(first.snapshot.associations.length,0);assert.equal(first.snapshot.messages.every(row=>row.requiredContentAvailable),true);assert.equal(first.snapshot.contexts.every(row=>row.basis==='provider_metadata'&&row.branch===null&&row.commit===null),true);
  f.sqlite.prepare('INSERT INTO acceptance_owner_grants(user_id,record_id,content_hash) VALUES(?,?,?)').run('owner',f.ruleRecord.record.id,f.ruleRecord.hash);
  const loaded=await loadHistoryAnalysisInput(f.db,'owner',{sourceIds:['s'],bucket:f.bucket,now});assert.equal(loaded.snapshot.associations.length,2);assert.ok(loaded.expectedRows.some(row=>row.kind==='message'&&row.logicalId==='m1'));assert.equal(loaded.planningRevision,1);assert.equal(loaded.historyHead,null);
  await assert.rejects(loadHistoryAnalysisInput(f.db,'foreign',{sourceIds:['s'],bucket:f.bucket,now}),/source/i);
 }finally{f.sqlite.close();}
});
test('missing and corrupt bytes stay explicit unavailable input; foreign ledger bytes are never opened',async()=>{
 const f=await fixture();try{
  f.objects.clear();const missing=await loadHistoryAnalysisInput(f.db,'owner',{sourceIds:['s'],bucket:f.bucket,now});assert.equal(missing.snapshot.messages.length,2);assert.equal(missing.snapshot.messages.every(row=>!row.requiredContentAvailable&&row.text===''),true);assert.ok(missing.unknowns.length>=2);
  f.sqlite.prepare("UPDATE history_object_ledger SET source_id='other' WHERE user_id='owner' AND source_id='s'").run();const before=f.gets();await loadHistoryAnalysisInput(f.db,'owner',{sourceIds:['s'],bucket:f.bucket,now});assert.equal(f.gets(),before);
 }finally{f.sqlite.close();}
});
test('record tampering and concurrent planning/source mutation cannot yield a pinned snapshot',async()=>{
 const f=await fixture();try{
  const row=f.sqlite.prepare("SELECT id FROM project_history WHERE user_id='owner' AND json_extract(payload_json,'$.kind')='message' LIMIT 1").get()!;f.sqlite.prepare("UPDATE project_history SET content_hash=? WHERE id=?").run('0'.repeat(64),row.id);await assert.rejects(loadHistoryAnalysisInput(f.db,'owner',{sourceIds:['s'],bucket:f.bucket,now}),/integrity|hash/i);
 }finally{f.sqlite.close();}
 const g=await fixture();try{let changed=false;const bucket={...g.bucket,async get(key:string,max:number){if(!changed){changed=true;g.sqlite.prepare("UPDATE workspaces SET revision=revision+1 WHERE user_id='owner'").run();}return g.bucket.get(key,max);}};await assert.rejects(loadHistoryAnalysisInput(g.db,'owner',{sourceIds:['s'],bucket,now}),/changed|conflict/i);}finally{g.sqlite.close();}
});
test('only actual completed native journals trust exact scoped checkpoints; imported and publication markers are excluded',async()=>{
 const f=await fixture();try{
  const {describeHistoryAnalysisScope,reserveHistoryAnalysis,prepareHistoryAnalysisCompletion}=await import('../lib/history/analysis-journal.ts');const {ownerReader}=await import('../lib/workspace-modules.ts');
  const pinned=await loadHistoryAnalysisInput(f.db,'owner',{sourceIds:['s'],bucket:f.bucket,now}),inputDigest=await contentHash('synthetic input'),checkpoint={id:'analysis:'+inputDigest,sourceWatermark:pinned.historyInputWatermark,inputDigest,normalizationVersion:'unicode-v1',extractorVersion:'extractor-v1',processedMessageRevisionIds:['m1','m2'],processedSegmentIds:[],affectedAreaIds:['app'],state:'complete'};
  await f.insert('analysis_checkpoint',checkpoint);await f.insert('analysis_checkpoint',{...checkpoint,id:'publication:synthetic'});
  assert.deepEqual((await loadHistoryAnalysisInput(f.db,'owner',{sourceIds:['s'],bucket:f.bucket,now})).trustedCheckpointIds,[]);
  const policy={id:'analysis',enabled:true,provider:'synthetic',model:'synthetic-v1',maxCostDollars:1,maxInputBytes:4096,maxOutputTokens:1000,timeoutMs:1000},payload=canonical(policy);
  f.sqlite.prepare("INSERT INTO review_settings(user_id,id,row_revision,payload_json,content_hash,setting_kind) VALUES('owner','analysis',1,?,?,'analysis')").run(payload,await contentHash(payload));const scope=await describeHistoryAnalysisScope(ownerReader(f.db,'owner'),['s'],0);
  f.sqlite.prepare("INSERT INTO review_analysis_consents(user_id,policy_hash,provider,model,max_cost_micros,created_at,expires_at,revoked_at) VALUES('owner',?,?,?,1000000,?,'2027-01-01T00:00:00.000Z',NULL)").run(scope.scopeHash,policy.provider,policy.model,now);
  const reservation=await reserveHistoryAnalysis(f.db,'owner',{sourceIds:['s'],privateSnapshotHash:await contentHash('private snapshot'),inputDigest,sourceWatermarkHash:await contentHash(pinned.historyInputWatermark),chunkHash:inputDigest,inputBytes:50,provider:policy.provider,model:policy.model,quoteUpperBoundDollars:0.1,now});assert.equal(reservation.status,'admitted');if(reservation.status!=='admitted')return;
  const completion=await prepareHistoryAnalysisCompletion(f.db,'owner',{requestId:reservation.requestId,inputDigest,claimHashes:[],checkpointDigest:await contentHash(canonical(checkpoint)),usage:{inputTokens:1,outputTokens:1,costDollars:0.01},now});await f.db.batch([completion.statement(f.db,'1',[])]);
  assert.deepEqual((await loadHistoryAnalysisInput(f.db,'owner',{sourceIds:['s'],bucket:f.bucket,now})).trustedCheckpointIds,[checkpoint.id]);
  // An owner overview may select additional sources without discarding a native
  // checkpoint whose exact journal source scope is still wholly selected.
  assert.deepEqual((await loadHistoryAnalysisInput(f.db,'owner',{sourceIds:['s','other'],bucket:f.bucket,now})).trustedCheckpointIds,[checkpoint.id]);
  assert.deepEqual((await loadHistoryAnalysisInput(f.db,'owner',{sourceIds:['other'],bucket:f.bucket,now})).trustedCheckpointIds,[]);
 }finally{f.sqlite.close();}
});
test('malformed UTF8 and body digest mismatch remain explicit unknown, with no partial normalized text',async()=>{
 const f=await fixture();try{
  for(const key of f.objects.keys())f.objects.set(key,Uint8Array.of(255));
  const invalid=Uint8Array.of(255),digest=await contentHash(invalid),object=await stageHistoryObject({db:f.db,bucket:f.bucket,authorize:async()=>true,now:()=>now},{ownerId:'owner',sourceId:'s',epoch:'e',scopeRevision:1,bytes:invalid,sha256:digest});
  await f.insert('message',{id:'invalid-utf8',conversationId:'c',nativeMessageId:'invalid-utf8',revisionDigest:digest,normalizationVersion:'unicode-v1',parentNativeMessageId:null,sequence:1,role:'user',occurredAt:null,observedAt:now,bodyObjectKey:object.key,contentBytes:1,availability:'complete'});
  const result=await loadHistoryAnalysisInput(f.db,'owner',{sourceIds:['s'],bucket:f.bucket,now});assert.equal(result.snapshot.messages.length,3);assert.ok(result.snapshot.messages.every(body=>!body.requiredContentAvailable&&body.text===''));
 }finally{f.sqlite.close();}
});
test('8 MiB private input bound rejects before buffering an oversized normalized message',async()=>{
 const f=await fixture();try{
  await f.insert('message',{id:'oversized',conversationId:'c',nativeMessageId:'oversized',revisionDigest:'a'.repeat(64),normalizationVersion:'unicode-v1',parentNativeMessageId:null,sequence:1,role:'user',occurredAt:null,observedAt:now,bodyObjectKey:'never-opened',contentBytes:8*1024*1024+1,availability:'complete'});
  await assert.rejects(loadHistoryAnalysisInput(f.db,'owner',{sourceIds:['s'],bucket:f.bucket,now}),/8 MiB bound/);
 }finally{f.sqlite.close();}
});
test('physical identity mismatch with a valid payload hash and execution epoch races fail closed',async()=>{
 const f=await fixture();try{
  const physical=await historyRecordId('message','m1'),row=f.sqlite.prepare("SELECT payload_json FROM project_history WHERE user_id='owner' AND id=?").get(physical)!,record=JSON.parse(String(row.payload_json));record.value.id='different-logical-id';const payload=canonical(record);f.sqlite.prepare("UPDATE project_history SET payload_json=?,content_hash=? WHERE user_id='owner' AND id=?").run(payload,await contentHash(payload),physical);
  await assert.rejects(loadHistoryAnalysisInput(f.db,'owner',{sourceIds:['s'],bucket:f.bucket,now}),/identity/);
 }finally{f.sqlite.close();}
 const g=await fixture();try{let changed=false;const bucket={...g.bucket,async get(key:string,max:number){if(!changed){changed=true;g.sqlite.prepare("INSERT INTO workspace_execution_state(user_id,epoch,restored_at) VALUES('owner',1,?)").run(now);}return g.bucket.get(key,max);}};await assert.rejects(loadHistoryAnalysisInput(g.db,'owner',{sourceIds:['s'],bucket,now}),/changed/);}finally{g.sqlite.close();}
});
