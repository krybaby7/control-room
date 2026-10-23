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
async function fixture(withOther=false){
 const f=database();await loadWorkspace(f.db,'owner',()=>structuredClone(workspace),now);await loadWorkspace(f.db,'foreign',()=>structuredClone(workspace),now);
 const objects=new Map<string,Uint8Array>();let gets=0;
 const bucket={async get(key:string,max:number){gets++;const bytes=objects.get(key);assert.ok(!bytes||bytes.length<=max);return bytes??null;},async put(key:string,bytes:Uint8Array){objects.set(key,bytes);},async delete(key:string){objects.delete(key);}};
 async function insert(kind:HistoryRecordKind,value:unknown,owner='owner',logicalId=(value as {id:string}).id){const record=parseHistoryRecord({kind,id:await historyRecordId(kind,logicalId),value}),payload=canonical(record),hash=await contentHash(payload);f.sqlite.prepare('INSERT INTO project_history(user_id,id,row_revision,payload_json,content_hash,stream_sequence) VALUES(?,?,1,?,?,0)').run(owner,record.id,payload,hash);return {record,hash};}
 for(const id of (withOther?['s','other']:['s']))await insert('source',{id,epoch:'e',scopeRevision:1,executionEpoch:0,paused:false,removedAt:null,configuration:{codecVersion:1,sourceId:id,kind:'codex_local',epoch:'e',scopeRevision:1,roots:[],accountId:null,deviceId:null,includeArchived:true,exclusions:[],parserVersion:'v1',normalizationVersion:'unicode-v1'},capability:{sourceId:id,kind:'codex_local',scopeLabel:'Synthetic source',inventory:'unverified',contentRead:'unverified',unattendedRead:false,verifiedAt:null,proofRef:null,limitation:'Synthetic only'}});
 for(const [id,sourceId]of [['c','s']])await insert('conversation',{id,sourceId,nativeThreadId:id,sessionTreeId:null,parentConversationId:null,title:'Project title does not grant association',projectId:'project',repositoryIdentity:'github.com/example/app',branch:null,createdAt:null,sourceUpdatedAt:null,archived:false,availability:'complete'});
 for(const [id,conversationId,sourceId]of [['m1','c','s'],['m2','c','s']]){const bytes=new TextEncoder().encode(id+' normalized immutable text'),sha256=await contentHash(bytes),object=await stageHistoryObject({db:f.db,bucket,authorize:async()=>true,now:()=>now},{ownerId:'owner',sourceId,epoch:'e',scopeRevision:1,bytes,sha256});await insert('message',{id,conversationId,nativeMessageId:id==='m2'?'m1':id,revisionDigest:sha256,normalizationVersion:'unicode-v1',parentNativeMessageId:null,sequence:0,role:id==='m1'?'tool':'user',occurredAt:null,observedAt:now,bodyObjectKey:object.key,contentBytes:bytes.length,availability:'complete'});}
 const rule={id:'rule',projectId:'project',areaId:'app',scope:'conversation',targetIds:[associationTarget('s','c')],reason:'Synthetic owner rule',provenanceRef:'owner-mutation:synthetic',rowRevision:1};const inserted=await insert('association_rule',rule);
 return {...f,bucket,objects,insert,ruleRecord:inserted,gets:()=>gets};
}

import {readNativeHistoryClaims} from '../lib/history/native-claims.ts';
import {validateClaim} from '../lib/history/claims.ts';
import {describeHistoryAnalysisScope,reserveHistoryAnalysis,prepareHistoryAnalysisCompletion} from '../lib/history/analysis-journal.ts';
import {ownerReader} from '../lib/workspace-modules.ts';
async function completed(attested=true,kind:'intent'|'implementation'='intent',withOther=false){
 const f=await fixture(withOther);f.sqlite.prepare('INSERT INTO acceptance_owner_grants(user_id,record_id,content_hash) VALUES(?,?,?)').run('owner',f.ruleRecord.record.id,f.ruleRecord.hash);
 const pinned=await loadHistoryAnalysisInput(f.db,'owner',{sourceIds:['s'],bucket:f.bucket,now}),body=pinned.snapshot.messages.find(body=>body.message.id==='m1')!,context=pinned.snapshot.contexts.find(context=>context.messageRevisionId==='m1')!;
 const raw={id:'native-claim',projectId:'project',areaId:'app',kind,basis:'observed',text:'Please implement scoped work.',context,citations:[{messageRevisionId:body.message.id,revisionDigest:body.message.revisionDigest,start:0,end:2}],supportingEvidence:[],extractorVersion:'extractor-v1',supersedesClaimId:null};
 const claim=await validateClaim(raw,pinned.snapshot,async()=>({supported:true,requestsWork:kind==='intent',completesScope:kind==='implementation',contradictions:[]}));
 const inputDigest=await contentHash('native claim input'),checkpoint={id:'analysis:'+inputDigest,sourceWatermark:pinned.historyInputWatermark,inputDigest,normalizationVersion:'unicode-v1',extractorVersion:'extractor-v1',processedMessageRevisionIds:[body.message.id],processedSegmentIds:[],affectedAreaIds:['app'],state:'complete'};
 await f.insert('claim',claim.claim);await f.insert('analysis_checkpoint',checkpoint);
 const policy={id:'analysis',enabled:true,provider:'synthetic',model:'synthetic-v1',maxCostDollars:1,maxInputBytes:4096,maxOutputTokens:1000,timeoutMs:1000},payload=canonical(policy);
 f.sqlite.prepare("INSERT INTO review_settings(user_id,id,row_revision,payload_json,content_hash,setting_kind) VALUES('owner','analysis',1,?,?,'analysis')").run(payload,await contentHash(payload));const scope=await describeHistoryAnalysisScope(ownerReader(f.db,'owner'),['s'],0);
 f.sqlite.prepare("INSERT INTO review_analysis_consents(user_id,policy_hash,provider,model,max_cost_micros,created_at,expires_at,revoked_at) VALUES('owner',?,?,?,1000000,?,'2027-01-01T00:00:00.000Z',NULL)").run(scope.scopeHash,policy.provider,policy.model,now);
 const reservation=await reserveHistoryAnalysis(f.db,'owner',{sourceIds:['s'],privateSnapshotHash:await contentHash('private snapshot'),inputDigest,sourceWatermarkHash:await contentHash(pinned.historyInputWatermark),chunkHash:inputDigest,inputBytes:50,provider:policy.provider,model:policy.model,quoteUpperBoundDollars:0.1,now});if(reservation.status!=='admitted')throw Error('fixture reservation denied');
 const port=await prepareHistoryAnalysisCompletion(f.db,'owner',{requestId:reservation.requestId,inputDigest,claimHashes:[await contentHash(canonical(claim.claim))],checkpointDigest:await contentHash(canonical(checkpoint)),usage:{inputTokens:1,outputTokens:1,costDollars:0.01},now},attested?{validatedClaims:[claim]}:{});await f.db.batch([port.statement(f.db,'1',[])]);
 return {...f,claim,loaded:await loadHistoryAnalysisInput(f.db,'owner',{sourceIds:['s'],bucket:f.bucket,now})};
}
test('native completed output restores exact sealed request verdict without inference; legacy flags remain false',async()=>{
 for(const attested of [true,false]){const f=await completed(attested);try{const claims=await readNativeHistoryClaims(f.db,'owner',f.loaded);assert.equal(claims.length,1);assert.equal(claims[0].requestSupported,attested);assert.equal(claims[0].completionSupported,false);const {requireValidatedClaim}=await import('../lib/history/claims.ts');requireValidatedClaim(claims[0],'owner',f.loaded.historyInputWatermark);}finally{f.sqlite.close();}}
});
test('imported flags and altered claim text cannot borrow a native completion hash',async()=>{
 const f=await completed();try{const altered=structuredClone(f.loaded);altered.retainedClaims[0].text='Everything is completed';assert.deepEqual(await readNativeHistoryClaims(f.db,'owner',altered),[]);altered.retainedClaims=f.loaded.retainedClaims;altered.checkpointProofs=[];assert.deepEqual(await readNativeHistoryClaims(f.db,'owner',altered),[]);}finally{f.sqlite.close();}
});
test('foreign owner, changed body/context and source row race never restore semantic verdicts',async()=>{
 const f=await completed();try{await assert.rejects(readNativeHistoryClaims(f.db,'foreign',f.loaded),/owner/);const bytes=structuredClone(f.loaded);bytes.snapshot.messages.find(body=>body.message.id==='m1')!.text='corrupt';assert.deepEqual(await readNativeHistoryClaims(f.db,'owner',bytes),[]);const context=structuredClone(f.loaded);context.snapshot.contexts.find(context=>context.messageRevisionId==='m1')!.branch='forged';assert.deepEqual(await readNativeHistoryClaims(f.db,'owner',context),[]);f.sqlite.prepare("UPDATE project_history SET row_revision=row_revision+1 WHERE user_id='owner' AND json_extract(payload_json,'$.kind')='source'").run();await assert.rejects(readNativeHistoryClaims(f.db,'owner',f.loaded),/changed/);}finally{f.sqlite.close();}
});

test('native association grant removal and private object revocation suppress retained semantic flags',async()=>{
 for(const boundary of ['grant','object']){const f=await completed();try{if(boundary==='grant')f.sqlite.prepare("DELETE FROM acceptance_owner_grants WHERE user_id='owner'").run();else f.sqlite.prepare("UPDATE history_object_ledger SET status='abandoned' WHERE user_id='owner'").run();assert.deepEqual(await readNativeHistoryClaims(f.db,'owner',f.loaded),[]);}finally{f.sqlite.close();}}
});

test('native observed implementation completion rehydrates only its attested completion flag',async()=>{
 const f=await completed(true,'implementation');try{const claims=await readNativeHistoryClaims(f.db,'owner',f.loaded);assert.equal(claims.length,1);assert.equal(claims[0].completionSupported,true);assert.equal(claims[0].requestSupported,false);}finally{f.sqlite.close();}
});

test('actual overview GET restores native observed finished count without granting owner acceptance',async()=>{
 const {readHistoryOverview}=await import('../lib/history/overview.ts');
 for(const boundary of ['native','legacy','grant'] as const){const f=await completed(boundary!=='legacy','implementation',true);try{
  await f.insert('roadmap_scope',{id:'scope',projectId:'project',areaId:'app',revision:1,agreedAt:null,checkpoints:[]},'owner','scope@1');await f.insert('roadmap_head',{id:'scope',projectId:'project',areaId:'app',scopeRevision:1,agreedAt:null});
  await f.insert('work_item',{id:'observed-work',projectId:'project',areaId:'app',workType:'implementation',title:'Scoped harness',state:'observed_finished',disposition:'requested',taskId:null,claimIds:[f.claim.claim.id],supersededById:null,rowRevision:1});
  if(boundary==='grant')f.sqlite.prepare("DELETE FROM acceptance_owner_grants WHERE user_id='owner'").run();
  const overview=await readHistoryOverview(f.db,'owner',now,f.bucket);assert.equal(overview.progress.length,1);assert.equal(overview.progress[0].observedFinishedWorkItemIds.length,boundary==='native'?1:0);assert.equal(overview.progress[0].acceptedTaskIds.length,0);assert.equal(overview.progress[0].roadmap?.ownerAccepted??0,0);
 }finally{f.sqlite.close();}}
});

test('new unrelated chat preserves historical native request at current watermark; authority and context changes deny it',async()=>{
 for(const boundary of ['new-chat','grant','source-epoch','context'] as const){const f=await completed();try{
  await f.insert('conversation',{id:'later-chat',sourceId:'s',nativeThreadId:'later-chat',sessionTreeId:null,parentConversationId:null,title:'Unrelated new retained chat',projectId:null,repositoryIdentity:null,branch:null,createdAt:null,sourceUpdatedAt:null,archived:false,availability:'complete'});
  if(boundary==='grant')f.sqlite.prepare("DELETE FROM acceptance_owner_grants WHERE user_id='owner'").run();
  if(boundary==='source-epoch'||boundary==='context'){const row=f.sqlite.prepare("SELECT id,payload_json FROM project_history WHERE user_id='owner' AND json_extract(payload_json,'$.kind')=? AND json_extract(payload_json,'$.value.id')=?").get(boundary==='source-epoch'?'source':'conversation',boundary==='source-epoch'?'s':'c')!,record=parseHistoryRecord(JSON.parse(String(row.payload_json)));if(record.kind==='source'){record.value.epoch='new-epoch';record.value.configuration.epoch='new-epoch';}if(record.kind==='conversation')record.value.branch='changed-branch';const payload=canonical(record);f.sqlite.prepare("UPDATE project_history SET payload_json=?,content_hash=?,row_revision=row_revision+1 WHERE user_id='owner' AND id=?").run(payload,await contentHash(payload),row.id);}
  const current=await loadHistoryAnalysisInput(f.db,'owner',{sourceIds:['s'],bucket:f.bucket,now});assert.notEqual(current.historyInputWatermark,f.loaded.historyInputWatermark);const claims=await readNativeHistoryClaims(f.db,'owner',current);assert.equal(claims.length,boundary==='new-chat'?1:0);if(claims.length){assert.equal(claims[0].requestSupported,true);assert.equal(claims[0].sourceWatermark,current.historyInputWatermark);assert.equal(claims[0].completionSupported,false);}
 }finally{f.sqlite.close();}}
});

import {prepareHistoryCapabilityEvidence,publishHistorySourceCapability} from '../lib/history/capability-publication.ts';
import {readHistoryRecord} from '../lib/history/store.ts';
import {planAnalysis} from '../lib/history/analysis.ts';
import type {HistoryRunnerAuthority} from '../lib/history/job-store.ts';
test('native capability publication preserves semantic watermark, extraction and historical observed claims',async()=>{for(const boundary of ['capability','config','legacy','restore'] as const){const f=await completed(true,'implementation');try{
 const before=await planAnalysis(f.loaded.snapshot,f.loaded.segments,[],'unicode-v1','extractor-v1'),source=(await readHistoryRecord(f.db,'owner','source','s'))!;assert.ok(before.chunks.length>0);
 if(boundary==='legacy'){const row=f.sqlite.prepare("SELECT id,payload_json FROM review_analysis_requests WHERE user_id='owner'").get()!,journal=JSON.parse(String(row.payload_json));for(const ref of journal.sources)delete ref.semanticDigest;f.sqlite.prepare('UPDATE review_analysis_requests SET payload_json=? WHERE user_id=? AND id=?').run(canonical(journal),'owner',row.id);}
 f.sqlite.prepare('INSERT INTO integration_service_principals VALUES(?,?,?,?,?,?,?)').run('owner','capability-principal','e'.repeat(64),'["history:read"]','2026-10-23T12:00:00.000Z',null,now);
 const authority:HistoryRunnerAuthority={ownerId:'owner',sourceId:'s',epoch:'e',scopeRevision:1,principalRef:'capability-principal',verifiedAt:now,expiresAt:'2026-10-23T12:00:00.000Z',renewable:true,freshProcessReadVerified:true,renewalAndRevocationVerified:true,async guardAt(at){return {sql:'EXISTS(SELECT 1 FROM integration_service_principals WHERE user_id=? AND id=? AND revoked_at IS NULL AND julianday(expires_at)>julianday(?))',bindings:['owner','capability-principal',at]};}};
 const evidence=await prepareHistoryCapabilityEvidence(f.db,{ownerId:'owner',sourceId:'s',now:()=>now,authority,verifier:{async verify(input){return {capability:{...input.source.capability,inventory:'verified',contentRead:'verified',unattendedRead:true,verifiedAt:now,proofRef:'synthetic-independent-capability-proof',limitation:null},expiresAt:authority.expiresAt,freshProcessReadVerified:true,renewalAndRevocationVerified:true};}}});assert.ok(evidence);assert.equal(await publishHistorySourceCapability(f.db,evidence,()=>now),'committed');await assert.rejects(readNativeHistoryClaims(f.db,'owner',f.loaded),/changed/);
 if(boundary==='restore'){f.sqlite.prepare('INSERT INTO workspace_execution_state VALUES(?,1,?)').run('owner',now);await assert.rejects(loadHistoryAnalysisInput(f.db,'owner',{sourceIds:['s'],bucket:f.bucket,now}),/execution epoch/);continue;}
 if(boundary==='config'){const current=(await readHistoryRecord(f.db,'owner','source','s'))!.record;current.value.configuration.roots=['changed-scope-without-epoch'];const text=canonical(current);f.sqlite.prepare('UPDATE project_history SET payload_json=?,content_hash=?,row_revision=row_revision+1 WHERE user_id=? AND id=?').run(text,await contentHash(text),'owner',current.id);}
 const loaded=await loadHistoryAnalysisInput(f.db,'owner',{sourceIds:['s'],bucket:f.bucket,now}),claims=await readNativeHistoryClaims(f.db,'owner',loaded);assert.equal(claims.length,boundary==='capability'?1:0);if(boundary==='capability'){assert.equal(loaded.historyInputWatermark,f.loaded.historyInputWatermark);assert.notDeepEqual(loaded.sourceRefs,f.loaded.sourceRefs);assert.equal(loaded.sourceRefs[0].semanticDigest,f.loaded.sourceRefs[0].semanticDigest);assert.equal(loaded.sourceRefs[0].rowRevision,source.rowRevision+1);assert.equal(claims[0].completionSupported,true);assert.equal(claims[0].requestSupported,false);const after=await planAnalysis(loaded.snapshot,loaded.segments,[],'unicode-v1','extractor-v1');assert.deepEqual(after.chunks.map(c=>c.extractionDigest),before.chunks.map(c=>c.extractionDigest));}
 }finally{f.sqlite.close();}}});
