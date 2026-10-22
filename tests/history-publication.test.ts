import {test} from 'node:test';
import * as analysisJobs from '../lib/history/analysis-job-store.ts';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {loadWorkspace,readCurrent} from '../lib/workspace-store.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {historyRecordId,parseHistoryRecord,type HistoryRecord,type HistoryRecordKind} from '../lib/history/record.ts';
import {historyInputWatermark} from '../lib/history/input-watermark.ts';
import {stageHistoryObject} from '../lib/history/object-store.ts';
import {validateClaim} from '../lib/history/claims.ts';
import {reconcileWorkItems} from '../lib/history/work-items.ts';
import {buildAreaStory} from '../lib/history/story.ts';
import {publishHistoryProjection,type HistoryPublicationInput} from '../lib/history/publication.ts';
import {ownerReader} from '../lib/workspace-modules.ts';
import {describeHistoryAnalysisScope,reserveHistoryAnalysis,prepareHistoryAnalysisCompletion} from '../lib/history/analysis-journal.ts';
import {executeWorkspaceCommand} from '../lib/workspace-transaction.ts';
import {workspaceHandlers} from '../lib/workspace-handlers.ts';
import {roadmapScopeId,getRoadmapState} from '../lib/history/roadmap-store.ts';
import {owner,now,workspace,body,claim,snapshot,item} from './fixtures/history-understanding.ts';

async function fixture(withJob=false){
 const f=database();await loadWorkspace(f.db,owner,()=>structuredClone(workspace),now);await loadWorkspace(f.db,'other-owner',()=>structuredClone(workspace),now);
 const objects=new Map<string,Uint8Array>(),objectDeps={db:f.db,authorize:async()=>true,now:()=>now,bucket:{async put(key:string,bytes:Uint8Array){objects.set(key,bytes.slice());},async get(key:string,max:number){const bytes=objects.get(key);assert.ok(!bytes||bytes.length<=max);return bytes??null;},async delete(key:string){objects.delete(key);}}};
 async function insert(kind:HistoryRecordKind,value:unknown,logicalId=(value as {id:string}).id){const record=parseHistoryRecord({id:await historyRecordId(kind,logicalId),kind,value}),payload=canonical(record);await f.db.prepare('INSERT INTO project_history(user_id,id,row_revision,payload_json,content_hash,stream_sequence) VALUES(?,?,1,?,?,0)').bind(owner,record.id,payload,await contentHash(payload)).run();return record;}
 await insert('source',{id:'source',configuration:{codecVersion:1,sourceId:'source',kind:'codex_local',epoch:'epoch',scopeRevision:1,roots:[],accountId:null,deviceId:null,includeArchived:true,exclusions:[],parserVersion:'parser-v1',normalizationVersion:'unicode-v1'},capability:{sourceId:'source',kind:'codex_local',scopeLabel:'Synthetic retained input',inventory:'unverified',contentRead:'unverified',unattendedRead:false,verifiedAt:null,proofRef:null,limitation:'Synthetic fixture is not live coverage.'},epoch:'epoch',scopeRevision:1,executionEpoch:0,paused:false,removedAt:null});
 const request=await body('request','Please implement the scoped harness.','user','chat-a'),implemented=await body('implemented','The scoped harness implementation succeeded.','tool','chat-b');
 for(const message of [request,implemented]){
  const object=await stageHistoryObject(objectDeps,{ownerId:owner,sourceId:'source',epoch:'epoch',scopeRevision:1,bytes:new TextEncoder().encode(message.text),sha256:message.message.revisionDigest});message.message.bodyObjectKey=object.key;
  await insert('conversation',{id:message.message.conversationId,sourceId:'source',nativeThreadId:message.message.conversationId,sessionTreeId:null,parentConversationId:null,title:'Synthetic chat',projectId:null,repositoryIdentity:'github.com/example/app',branch:'main',createdAt:null,sourceUpdatedAt:null,archived:false,availability:'complete'});
  await insert('message',message.message);
 }
 if(withJob)await insert('association_rule',{id:'job-rule',projectId:'project',areaId:'app',scope:'conversation',targetIds:[canonical(['source','chat-a'])],reason:'Synthetic native job scope',provenanceRef:'owner-mutation:synthetic-job',rowRevision:1});
 const records=f.sqlite.prepare('SELECT payload_json FROM project_history WHERE user_id=?').all(owner).map(row=>parseHistoryRecord(JSON.parse(String(row.payload_json)))),watermark=await historyInputWatermark(records),pinned={...snapshot([request,implemented]),sourceWatermark:watermark};
 const requestClaim=await validateClaim(claim(request),pinned,async()=>({supported:true,requestsWork:true,contradictions:[]})),implementationClaim=await validateClaim(claim(implemented,'implementation',{basis:'observed'}),pinned,async()=>({supported:true,completesScope:true,contradictions:[]})),claims=[requestClaim,implementationClaim],inputDigest=await contentHash('synthetic exact analysis input');
 const work=await reconcileWorkItems({ownerId:owner,sourceWatermark:watermark,now,items:[],events:[],claims,scopeMatches:()=>true,operations:[{operationId:'create-software',inputDigest,workItemId:'software',kind:'create',claimIds:[requestClaim.claim.id],newItem:item('software',[requestClaim.claim.id],{title:'Scoped harness'})},{operationId:'finish-software',inputDigest,workItemId:'software',kind:'observe-finished',claimIds:[implementationClaim.claim.id]}]});
 const story=await buildAreaStory({ownerId:owner,projectId:'project',areaId:'app',planningRevision:1,sourceWatermark:watermark,associationVersion:'rules-v1',extractorVersion:'extractor-v1',generatedAt:now,workspace,items:work.items,claims,unknowns:[],contradictions:[],trustAcceptance:async()=>false});
 const input:HistoryPublicationInput={planningRevision:1,historyHead:null,historyInputWatermark:watermark,target:{projectId:'project',areaId:'app'},analysisInput:{inputDigest,normalizationVersion:'unicode-v1',extractorVersion:'extractor-v1',associationVersion:'rules-v1',messageRevisionIds:[request.message.id,implemented.message.id],segmentIds:[],repositorySnapshotIds:[]},checkpoint:{id:'analysis:'+inputDigest,inputDigest,sourceWatermark:watermark,normalizationVersion:'unicode-v1',extractorVersion:'extractor-v1',processedMessageRevisionIds:[request.message.id,implemented.message.id],processedSegmentIds:[],affectedAreaIds:['app'],state:'complete'},validatedClaims:claims,workItems:work,story,expectedRows:[{kind:'work_item',logicalId:'software',rowRevision:null,contentHash:null}]};
 return {...f,input,insert,objects,records};
}
function projections(f:Awaited<ReturnType<typeof fixture>>){return f.sqlite.prepare("SELECT id,row_revision,payload_json,content_hash,stream_sequence FROM project_history WHERE user_id=? AND json_extract(payload_json,'$.kind') IN ('claim','work_item','work_item_event','story','analysis_checkpoint') ORDER BY id").all(owner);}
function assertClean(f:Awaited<ReturnType<typeof fixture>>){assert.equal(projections(f).length,0);assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM operational_stream_heads WHERE user_id=? AND stream_id='history'").get(owner)!.n,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_job_intents WHERE user_id=?').get(owner)!.n,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_assertions').get()!.n,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_command_guards').get()!.n,0);}
async function journal(f:Awaited<ReturnType<typeof fixture>>,claimHashes?:string[]){
 const policy={id:'analysis',enabled:true,provider:'synthetic-exact-provider',model:'synthetic-exact-model',maxCostDollars:1,maxInputBytes:4096,maxOutputTokens:1000,timeoutMs:1000},payload=canonical(policy);
 f.sqlite.prepare("INSERT INTO review_settings(user_id,id,row_revision,payload_json,content_hash,setting_kind) VALUES(?,'analysis',1,?,?,'analysis')").run(owner,payload,await contentHash(payload));
 const scope=await describeHistoryAnalysisScope(ownerReader(f.db,owner),['source'],0);
 f.sqlite.prepare('INSERT INTO review_analysis_consents(user_id,policy_hash,provider,model,max_cost_micros,created_at,expires_at,revoked_at) VALUES(?,?,?,?,1000000,?,?,NULL)').run(owner,scope.scopeHash,policy.provider,policy.model,now,'2027-01-01T00:00:00.000Z');
 const reserved=await reserveHistoryAnalysis(f.db,owner,{sourceIds:['source'],privateSnapshotHash:await contentHash('synthetic private snapshot'),inputDigest:f.input.analysisInput.inputDigest,sourceWatermarkHash:await contentHash(f.input.historyInputWatermark),chunkHash:f.input.analysisInput.inputDigest,inputBytes:100,provider:policy.provider,model:policy.model,quoteUpperBoundDollars:0.5,now});assert.equal(reserved.status,'admitted');if(reserved.status!=='admitted')throw Error('Synthetic journal fixture admission failed.');
 const port=await prepareHistoryAnalysisCompletion(f.db,owner,{requestId:reserved.requestId,inputDigest:f.input.analysisInput.inputDigest,claimHashes:claimHashes??await Promise.all(f.input.validatedClaims.map(c=>contentHash(canonical(c.claim)))),checkpointDigest:await contentHash(canonical(f.input.checkpoint)),usage:{inputTokens:1,outputTokens:1,costDollars:0.1},now},claimHashes?{}:{validatedClaims:f.input.validatedClaims});
 return {port,scope};
}
async function nativeAcceptance(f:Awaited<ReturnType<typeof fixture>>){
 let serial=0;const scopeId=await roadmapScopeId('project','app'),criterion={id:'harness',label:'Harness acceptance',acceptance:'The owner checks the scoped harness.',mandatory:true,milestoneId:null,taskIds:[]};
 const command=async(value:unknown)=>{const current=await readCurrent(f.db,owner);assert.equal((await executeWorkspaceCommand(owner,{protocolVersion:1,expectedRevision:current.revision,mutationId:'publication-native-owner-'+String(++serial).padStart(4,'0'),command:value},{db:f.db,handlers:workspaceHandlers,now:()=>now})).status,'committed');};
 await command({type:'roadmap.set',projectId:'project',areaId:'app',expectedScopeRevision:null,checkpoints:[criterion]});await command({type:'roadmap.agree',scopeId,expectedScopeRevision:1});await command({type:'checkpoint.assess',scopeId,expectedScopeRevision:1,checkpointId:'harness',verdict:'accepted',reason:'Owner checked the named criterion.',claimIds:[]});
 const state=await getRoadmapState(ownerReader(f.db,owner),scopeId,async(id,hash)=>!!await f.db.prepare('SELECT 1 FROM acceptance_owner_grants WHERE user_id=? AND record_id=? AND content_hash=?').bind(owner,id,hash).first()),assessment=state.assessments[0],current=await readCurrent(f.db,owner);assert.ok(assessment);
 const story=await buildAreaStory({ownerId:owner,projectId:'project',areaId:'app',planningRevision:current.revision,sourceWatermark:f.input.historyInputWatermark,associationVersion:'rules-v1',extractorVersion:'extractor-v1',generatedAt:now,workspace:current.workspace,items:f.input.workItems!.items,claims:f.input.validatedClaims,unknowns:[],contradictions:[],acceptedEntries:[{text:criterion.label,claimIds:[],acceptanceRef:assessment.id}],trustAcceptance:async()=>true});
 return {...f.input,planningRevision:current.revision,story};
}

test('validated publication commits claims, work transitions, story and true checkpoint atomically; exact replay preserves input watermark',async()=>{
 const f=await fixture();try{
  const before=await readCurrent(f.db,owner),result=await publishHistoryProjection(f.db,owner,f.input,{now});assert.equal(result.status,'committed');if(result.status!=='committed')return;
  assert.equal((await readCurrent(f.db,owner)).revision,before.revision);assert.deepEqual((await readCurrent(f.db,owner)).workspace,before.workspace);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM acceptance_owner_grants').get()!.n,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_job_intents').get()!.n,0);
  const after=projections(f);assert.equal(after.length,8);assert.deepEqual(Object.fromEntries(['claim','work_item','work_item_event','story','analysis_checkpoint'].map(kind=>[kind,after.filter(row=>JSON.parse(String(row.payload_json)).kind===kind).length])),{claim:2,work_item:1,work_item_event:2,story:1,analysis_checkpoint:2});assert.equal(f.sqlite.prepare("SELECT last_sequence n FROM operational_stream_heads WHERE user_id=? AND stream_id='history'").get(owner)!.n,1);
 const records=f.sqlite.prepare('SELECT payload_json FROM project_history WHERE user_id=?').all(owner).map(row=>parseHistoryRecord(JSON.parse(String(row.payload_json))));assert.equal(await historyInputWatermark(records),f.input.historyInputWatermark);
  const markers=records.filter((r):r is HistoryRecord<'analysis_checkpoint'>=>r.kind==='analysis_checkpoint');const marker=markers.find(r=>r.value.id.startsWith('publication:'))!;assert.deepEqual(marker.value.processedMessageRevisionIds,[]);assert.deepEqual(marker.value.processedSegmentIds,[]);assert.equal(markers.find(r=>r.value.id===f.input.checkpoint.id)!.value.inputDigest,f.input.analysisInput.inputDigest);
  const replay=await publishHistoryProjection(f.db,owner,f.input,{now});assert.equal(replay.status,'replayed');if(replay.status==='replayed')assert.deepEqual(replay.receipt,result.receipt);assert.deepEqual(projections(f),after);
  await assert.rejects(publishHistoryProjection(f.db,owner,{...f.input,story:{...f.input.story!,story:{...f.input.story!.story,unknowns:['Changed proposal']}}},{now}),/already used/);assert.deepEqual(projections(f),after);
 }finally{f.sqlite.close();}
});

for(const race of ['editor','source','head','object'] as const)test(`publication ${race} race leaves no claim, event, story, checkpoint or job effects`,async()=>{
 const f=await fixture();try{
  const result=await publishHistoryProjection(f.db,owner,f.input,{now,beforeCommit:async()=>{
   if(race==='editor')f.sqlite.prepare('UPDATE workspaces SET revision=revision+1 WHERE user_id=?').run(owner);
   else if(race==='head')f.sqlite.prepare("INSERT INTO operational_stream_heads(user_id,stream_id,revision,last_sequence) VALUES(?,'history',1,99)").run(owner);
   else if(race==='object')f.sqlite.prepare("UPDATE history_object_ledger SET status='abandoned' WHERE user_id=?").run(owner);
   else{const id=await historyRecordId('source','source'),row=f.sqlite.prepare('SELECT payload_json FROM project_history WHERE user_id=? AND id=?').get(owner,id)!,record=parseHistoryRecord(JSON.parse(String(row.payload_json)));assert.equal(record.kind,'source');if(record.kind!=='source')return;record.value.epoch='changed';record.value.configuration.epoch='changed';const payload=canonical(record);f.sqlite.prepare('UPDATE project_history SET row_revision=row_revision+1,payload_json=?,content_hash=? WHERE user_id=? AND id=?').run(payload,await contentHash(payload),owner,id);}
  }});assert.equal(result.status,'conflict');assert.equal(projections(f).length,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_job_intents').get()!.n,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_assertions').get()!.n,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_command_guards').get()!.n,0);if(race!=='head')assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM operational_stream_heads WHERE user_id=? AND stream_id='history'").get(owner)!.n,0);
 }finally{f.sqlite.close();}
});

test('foreign/forged claim wrappers, invented completion, ungranted acceptance and pending raw claims cannot publish',async()=>{
 const f=await fixture();try{
  await assert.rejects(publishHistoryProjection(f.db,'other-owner',f.input,{now}),/not validated/);assertClean(f);
  await assert.rejects(publishHistoryProjection(f.db,owner,{...f.input,validatedClaims:structuredClone(f.input.validatedClaims)},{now}),/not validated/);assertClean(f);
  const pending={...f.input,checkpoint:{...f.input.checkpoint,state:'unavailable' as const}};assert.equal((await publishHistoryProjection(f.db,owner,pending,{now})).status,'unavailable');assertClean(f);
  await assert.rejects(publishHistoryProjection(f.db,owner,{...f.input,pendingClaims:[f.input.validatedClaims[0].claim]} as HistoryPublicationInput,{now}),/Unknown/);assertClean(f);
  const accepted={...f.input.story!.story,finished:[{text:'Everything is accepted.',basis:'accepted' as const,acceptanceRef:'invented-native-grant',claimIds:[],citations:[]}]};await assert.rejects(publishHistoryProjection(f.db,owner,{...f.input,story:{...f.input.story!,story:accepted}},{now}),/native owner grant/);assertClean(f);
  const unsupported={...f.input.story!.story,finished:[{text:f.input.validatedClaims[0].claim.text,basis:'inferred' as const,acceptanceRef:null,claimIds:[f.input.validatedClaims[0].claim.id],citations:f.input.validatedClaims[0].claim.citations}]};await assert.rejects(publishHistoryProjection(f.db,owner,{...f.input,story:{...f.input.story!,story:unsupported}},{now}),/exceeds/);assertClean(f);
 }finally{f.sqlite.close();}
});

test('supporting claims must already be exact retained records and update logical work revisions under physical row CAS',async()=>{
 const f=await fixture();try{
  assert.equal((await publishHistoryProjection(f.db,owner,f.input,{now})).status,'committed');
  const physical=await historyRecordId('work_item','software'),row=f.sqlite.prepare('SELECT row_revision,content_hash FROM project_history WHERE user_id=? AND id=?').get(owner,physical)!,inputDigest=await contentHash('next deterministic projection input');
  const work=await reconcileWorkItems({ownerId:owner,sourceWatermark:f.input.historyInputWatermark,now,items:f.input.workItems!.items,events:f.input.workItems!.events,claims:f.input.validatedClaims,scopeMatches:()=>true,operations:[{operationId:'link-retained-scope',inputDigest,workItemId:'software',kind:'link',claimIds:[f.input.validatedClaims[1].claim.id]}]});
  const input:HistoryPublicationInput={...f.input,historyHead:{revision:1,lastSequence:1},analysisInput:{...f.input.analysisInput,inputDigest},checkpoint:{...f.input.checkpoint,id:'analysis:'+inputDigest,inputDigest},validatedClaims:[],supportingClaims:f.input.validatedClaims,workItems:work,story:undefined,expectedRows:[{kind:'work_item',logicalId:'software',rowRevision:Number(row.row_revision),contentHash:String(row.content_hash)}]};
  assert.equal((await publishHistoryProjection(f.db,owner,input,{now})).status,'committed');const updated=f.sqlite.prepare('SELECT row_revision,payload_json FROM project_history WHERE user_id=? AND id=?').get(owner,physical)!;assert.equal(updated.row_revision,2);assert.equal(JSON.parse(String(updated.payload_json)).value.rowRevision,3);assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM project_history WHERE user_id=? AND json_extract(payload_json,'$.kind')='claim'").get(owner)!.n,2);
 }finally{f.sqlite.close();}
});

test('a native branded journal completes only with exact output in the same publication transaction and replays once',async()=>{
 const f=await fixture();try{
  const {port}=await journal(f);
  await assert.rejects(publishHistoryProjection(f.db,owner,f.input,{now,journal:{...port}}),/native prepared/);assertClean(f);
  const result=await publishHistoryProjection(f.db,owner,f.input,{now,journal:port});assert.equal(result.status,'committed');
  const ledger=f.sqlite.prepare('SELECT state,result_id,result_hash,measured_cost_micros FROM review_analysis_requests WHERE user_id=? AND id=?').get(owner,port.requestId)!;assert.equal(ledger.state,'completed');assert.equal(ledger.result_id,port.checkpointDigest);assert.equal(ledger.result_hash,port.completionDigest);assert.equal(ledger.measured_cost_micros,100000);
  const replay=await publishHistoryProjection(f.db,owner,f.input,{now,journal:port});assert.equal(replay.status,'replayed');if(result.status==='committed'&&replay.status==='replayed')assert.deepEqual(replay.receipt,result.receipt);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM review_analysis_requests WHERE user_id=?').get(owner)!.n,1);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_job_intents WHERE user_id=?').get(owner)!.n,0);assert.equal((await readCurrent(f.db,owner)).revision,1);
 }finally{f.sqlite.close();}
});

for(const race of ['consent','journal-postcondition'] as const)test(`native analysis ${race} failure rolls back journal and every projection effect together`,async()=>{
 const f=await fixture();try{
  const {port}=await journal(f);
  const result=await publishHistoryProjection(f.db,owner,f.input,{now,journal:port,beforeCommit:async()=>{
   if(race==='consent')f.sqlite.prepare('UPDATE review_analysis_consents SET revoked_at=? WHERE user_id=?').run(now,owner);
   else f.sqlite.exec("CREATE TEMP TRIGGER synthetic_deny_journal_completion BEFORE UPDATE ON review_analysis_requests BEGIN SELECT RAISE(IGNORE); END");
  }});assert.equal(result.status,'conflict');assertClean(f);assert.equal(f.sqlite.prepare('SELECT state FROM review_analysis_requests WHERE user_id=? AND id=?').get(owner,port.requestId)!.state,'uncertain');
 }finally{f.sqlite.close();}
});

test('prepared journal hashes cannot finalize a different validated output',async()=>{
 const f=await fixture();try{const {port}=await journal(f,[]);await assert.rejects(publishHistoryProjection(f.db,owner,f.input,{now,journal:port}),/exact native output/);assertClean(f);assert.equal(f.sqlite.prepare('SELECT state FROM review_analysis_requests WHERE user_id=?').get(owner)!.state,'uncertain');}finally{f.sqlite.close();}
});

test('current native checkpoint grants authorize only the named criterion and are fenced against revocation',async()=>{
 const f=await fixture();try{
  const input=await nativeAcceptance(f),accepted=input.story!.story.finished.find(entry=>entry.basis==='accepted')!;
  await assert.rejects(publishHistoryProjection(f.db,owner,{...input,story:{...input.story!,story:{...input.story!.story,finished:[{...accepted,text:'The entire project is accepted.'}]}}},{now}),/overstates/);assertClean(f);
  const grant=await historyRecordId('roadmap_head',await roadmapScopeId('project','app'));
  const raced=await publishHistoryProjection(f.db,owner,input,{now,beforeCommit:async()=>{f.sqlite.prepare('DELETE FROM acceptance_owner_grants WHERE user_id=? AND record_id=?').run(owner,grant);}});assert.equal(raced.status,'conflict');assertClean(f);
 }finally{f.sqlite.close();}
 const good=await fixture();try{const input=await nativeAcceptance(good);assert.equal((await publishHistoryProjection(good.db,owner,input,{now})).status,'committed');assert.ok(projections(good).some(row=>JSON.parse(String(row.payload_json)).kind==='story'));assert.equal((await readCurrent(good.db,owner)).revision,input.planningRevision);}finally{good.sqlite.close();}
});

test('legacy native completion membership cannot grant omitted semantic completion or request flags',async()=>{
 const f=await fixture();try{const hashes=await Promise.all(f.input.validatedClaims.map(c=>contentHash(canonical(c.claim)))),{port}=await journal(f,hashes);await assert.rejects(publishHistoryProjection(f.db,owner,f.input,{now,journal:port}),/semantic attestations/);assertClean(f);}finally{f.sqlite.close();}
});

async function preparedJob(f:Awaited<ReturnType<typeof fixture>>,outcome:'complete'|'continue'='complete',reservedRequestIds:string[]=[]){
 const intentId='synthetic-publication-job',pin={watermark:f.input.historyInputWatermark,inputDigest:await contentHash('whole plan pin')},original={ruleId:'job-rule',ruleRevision:1,projectId:'project',areaId:'app',sourceIds:['source'],affectedDestinations:[{projectId:'project',areaId:'app'}]};
 f.sqlite.prepare('INSERT INTO workspace_job_intents VALUES(?,?,?,?,?,?,?,?,?)').run(owner,intentId,'area_analysis',intentId,canonical(original),now,'pending',0,0);
 f.sqlite.prepare('INSERT INTO integration_service_principals VALUES(?,?,?,?,?,?,?)').run(owner,'publication-principal','a'.repeat(64),'["history:analysis-control"]','2027-01-01T00:00:00.000Z',null,now);
 const authority:analysisJobs.AreaAnalysisAuthority={ownerId:owner,principalRef:'publication-principal',verifiedAt:now,expiresAt:'2027-01-01T00:00:00.000Z',async guardAt(){return {sql:'EXISTS(SELECT 1 FROM integration_service_principals WHERE user_id=? AND id=? AND revoked_at IS NULL)',bindings:[owner,'publication-principal']};},async pinGuardAt(value){assert.deepEqual(value,pin);return {sql:'NOT EXISTS(SELECT 1 FROM operational_stream_heads WHERE user_id=? AND stream_id=?)',bindings:[owner,'history']};}};
 assert.ok(await analysisJobs.adoptAreaAnalysisJob(f.db,owner,intentId,{authority,pin,now}));let job=(await analysisJobs.claimAreaAnalysisJob(f.db,owner,intentId,{authority,now}))!;assert.ok(job);for(const requestId of reservedRequestIds){job=(await analysisJobs.appendAreaAnalysisReservation(f.db,job,authority,now,requestId))!;assert.ok(job);}
 const port=await analysisJobs.prepareAreaAnalysisProgress(f.db,job,{authority,now,inputDigest:f.input.analysisInput.inputDigest,outcome,cursor:outcome==='complete'?null:'next-exact-chunk',reservedRequestIds});assert.ok(port);return {port:port!,job,intentId,authority};
}
for(const race of [false,true])test(`native job cursor completion shares publication transaction and cancellation fencing (cancel=${race})`,async()=>{
 const f=await fixture(true);try{const {port,intentId,authority}=await preparedJob(f);await assert.rejects(publishHistoryProjection(f.db,owner,f.input,{now,jobProgress:structuredClone(port)}),/native|prepared/i);
 const result=await publishHistoryProjection(f.db,owner,f.input,{now,jobProgress:port,beforeCommit:race?async()=>{assert.ok(await analysisJobs.cancelAreaAnalysisJob(f.db,owner,intentId,authority,now));}:undefined});
 const job=await analysisJobs.readAreaAnalysisJob(f.db,owner,intentId);if(race){assert.equal(result.status,'conflict');assert.equal(projections(f).length,0);assert.equal(job!.status,'cancelled');assert.equal(job!.control!.cursor,null);}else{assert.equal(result.status,'committed');assert.equal(job!.status,'succeeded');assert.equal(job!.control!.cursor,null);assert.equal((await publishHistoryProjection(f.db,owner,f.input,{now,jobProgress:port})).status,'replayed');}assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_command_guards').get()!.n,0);
 }finally{f.sqlite.close();}
});

test('publication and native job finish both roll back when reserved private capacity fills after preparation',async()=>{
 const f=await fixture(true);try{const {port,job,intentId}=await preparedJob(f);const result=await publishHistoryProjection(f.db,owner,f.input,{now,jobProgress:port,beforeCommit:async()=>{
  // Eight live native attempt reservations consume >64 MiB without buffering
  // any large fixture payload; this models a concurrent admitted private writer.
  for(let n=0;n<8;n++)f.sqlite.prepare('INSERT INTO job_attempts(user_id,id,job_id,device_id,approval_id,execution_epoch,journal_nonce_hash,lease_token_hash,lease_expires_at,deadline_at,created_at,operational_revision,identity_json) VALUES(?,?,?,?,?,0,?,?,?,?,?,1,?)').run(owner,'capacity-attempt-'+n,'synthetic-job-'+n,'synthetic-device-'+n,'synthetic-approval','a'.repeat(64),'b'.repeat(64),'2027-01-01T00:00:00.000Z','2027-01-02T00:00:00.000Z',now,'{}');
 }});assert.equal(result.status,'conflict');assert.equal(projections(f).length,0);assert.equal((await analysisJobs.readAreaAnalysisJob(f.db,owner,intentId))!.serialized,job.serialized);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_assertions').get()!.n,0);
 }finally{f.sqlite.close();}
});

test('native continuation cursor advances atomically while queue returns to pending',async()=>{
 const f=await fixture(true);try{const {port:completion}=await journal(f),{port,intentId}=await preparedJob(f,'continue',[completion.requestId]);assert.equal((await publishHistoryProjection(f.db,owner,f.input,{now,jobProgress:port,journal:completion})).status,'committed');const job=await analysisJobs.readAreaAnalysisJob(f.db,owner,intentId);assert.equal(job!.status,'pending');assert.equal(job!.control!.cursor,'next-exact-chunk');assert.equal(job!.control!.lease,null);}finally{f.sqlite.close();}
});
