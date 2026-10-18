import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {workspaceFixture,taskFixture} from './helpers/workspace.ts';
import {loadWorkspace,readCurrent,type SqlDatabase} from '../lib/workspace-store.ts';
import {workspaceHandlers} from '../lib/workspace-handlers.ts';
import {executeWorkspaceCommand} from '../lib/workspace-transaction.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {exportWorkspaceBundle} from '../lib/workspace-export.ts';
import {stageImport} from '../lib/import-staging.ts';
import {previewPlanningMerge} from '../lib/workspace-merge.ts';
import {prepareNormalizedMerge} from '../lib/normalized-merge.ts';
import {ownerReader,OWNER_TABLES,type RegisteredOwnerTable} from '../lib/workspace-modules.ts';
import {moduleColumnNames,moduleProjection} from '../lib/module-columns.ts';
import {versionRowId} from '../lib/version-identity.ts';
import {criteriaHash} from '../lib/evidence-requirements.ts';
import type {AttachmentRecord} from '../lib/evidence-contract.ts';
import type {JsonValue} from '../lib/workspace-protocol.ts';
const now='2026-10-18T12:00:00.000Z',owner='merge-owner',source='merge-source',foreign='merge-foreign',taskId='task-current',evidenceId='incoming-evidence',attachmentId='11111111-1111-4111-8111-111111111111';
const none={projects:[],milestones:[],tasks:[],captures:[],activity:[]};
async function fixture(collision=false){
 const f=database();for(const userId of [owner,source,foreign])await loadWorkspace(f.db,userId,()=>workspaceFixture({tasks:[taskFixture(taskId)]}),now);
 async function put(userId:string,table:RegisteredOwnerTable,id:string,value:unknown,revision=1){
  const columns=moduleColumnNames(table),projection=await moduleProjection(table,id,value as JsonValue),payload=canonical(value);
  f.sqlite.prepare('INSERT INTO '+table+'(user_id,id,row_revision,payload_json,content_hash'+(columns.length?','+columns.join(','):'')+') VALUES(?,?,?,?,?'+columns.map(()=>',?').join('')+')').run(userId,id,revision,payload,await contentHash(payload),...columns.map(column=>projection[column]));
 }
 const existingId=collision?evidenceId:'existing-evidence',head={id:existingId,currentVersion:1,archivedAt:null},version={id:existingId,version:1,basis:'owner-statement',scope:'implementation',title:'Existing owner evidence',statement:'Original owner body must remain byte exact.',observedAt:null,recordedAt:now,candidate:null,environment:null,sourceUrl:null,sourceRevision:null,sourceRecordId:null,attachmentIds:[],supersedesVersion:null};
 await put(owner,'evidence_records',existingId,head,7);await put(owner,'evidence_versions',await versionRowId(existingId,1),version,4);await put(owner,'attachment_usage','quota',{bytes:0,files:0},3);
 const assessment={id:'existing-assessment',subject:{type:'task',id:taskId},decision:'accepted',statement:'Existing explicit owner assessment',candidate:null,criteriaHash:await criteriaHash({type:'task',id:taskId},[]),evidenceRefs:[],recordedAt:now,supersedesId:null,exceptions:[]};
 await put(owner,'acceptance_records',assessment.id,assessment,5);
 f.sqlite.prepare('INSERT INTO acceptance_owner_grants(user_id,record_id,content_hash) VALUES(?,?,?)').run(owner,assessment.id,await contentHash(canonical(assessment)));
 await put(source,'source_connections','incoming-connection',{id:'incoming-connection',provider:'github',label:'Imported selected repository',accessMode:'unattended',enabled:true,archivedAt:null});
 await put(source,'source_targets','incoming-source',{id:'incoming-source',connectionId:'incoming-connection',projectId:'p1',kind:'github_repository',providerResourceId:'synthetic/repository',canonicalUrl:'https://github.com/synthetic/repository',selectedPaths:[],staleAfterSeconds:3600,selectionVersion:1,archivedAt:null});
 const payload={sha:'a'.repeat(40),checks:'historical source claim'},contentDigest=await contentHash(canonical(payload));
 await put(source,'source_observations','incoming-observation',{id:'incoming-observation',sourceId:'incoming-source',externalId:'commit-a',sourceRevision:'a'.repeat(40),sourceUpdatedAt:now,observedAt:now,title:'Imported repository observation',canonicalUrl:'https://github.com/synthetic/repository',contentDigest,payload,origin:'provider-read'});
 await put(source,'attachments',attachmentId,{id:attachmentId,status:'ready',filename:'result.txt',mimeType:'text/plain',expectedBytes:3,actualBytes:3,sha256:await contentHash('abc'),storageKey:'attachments/22222222-2222-4222-8222-222222222222/'+attachmentId,createdAt:now,expiresAt:'2026-10-18T13:00:00.000Z',readyAt:now,uploadMutationId:'source-upload-0001',quarantineReason:null});
 await put(source,'attachment_usage','quota',{bytes:3,files:1});
 await put(source,'evidence_records',evidenceId,{id:evidenceId,currentVersion:1,archivedAt:null});
 await put(source,'evidence_versions',await versionRowId(evidenceId,1),{...version,id:evidenceId,title:'Imported version',statement:'Historical imported source body.',basis:'documented-result',attachmentIds:[attachmentId],sourceObservationRef:{id:'incoming-observation',contentDigest}});
 const requirement={id:'incoming-requirement',subject:{type:'task' as const,id:taskId},label:'Imported criterion remains inactive',scope:'implementation',required:true,maxAgeDays:null,candidate:null,requireAttachment:false,archivedAt:null};
 await put(source,'evidence_requirements',requirement.id,requirement);
 await put(source,'evidence_links','incoming-link',{id:'incoming-link',evidenceId,evidenceVersion:1,subject:requirement.subject,requirementId:requirement.id,relation:'supports'});
 await put(source,'acceptance_records','incoming-assessment',{...assessment,id:'incoming-assessment',statement:'Source acceptance is not an owner grant.',criteriaHash:await criteriaHash(requirement.subject,[requirement]),evidenceRefs:[{id:evidenceId,version:1,requirementId:requirement.id,relation:'supports',historical:false}]});
 const decisionId='incoming-decision';await put(source,'decision_records',decisionId,{id:decisionId,currentVersion:1,archivedAt:null});
 await put(source,'decision_versions',await versionRowId(decisionId,1),{id:decisionId,version:1,title:'Historical decided source claim',question:'What was reviewed?',options:[{id:'yes',label:'Proceed',description:''}],selectedOptionId:'yes',rationale:'Source rationale',status:'decided',decidedAt:now,reviewOn:null,subjects:[requirement.subject],evidenceRefs:[{id:evidenceId,version:1}],sourceCaptureId:null,sourceUrl:null,supersedesDecisionId:null,supersedesVersion:null,recordedAt:now,exception:null});
 await put(source,'weekly_plans','2026-10-19',{weekStart:'2026-10-19',capacityMinutes:120,taskIds:[taskId],revision:1});
 await put(source,'automation_schedules','incoming-schedule',{id:'incoming-schedule',kind:'daily_review',timezone:'Africa/Cairo',enabled:true,configurationVersion:1,recurrence:{frequency:'daily',localTime:'09:00'},sourceId:null,projectIds:['p1'],catchUp:'latest_only',createdAt:now,updatedAt:now,archivedAt:null});
 await put(source,'devices','incoming-device',{id:'incoming-device',label:'Historical imported PC',createdAt:now,archivedAt:null});
 const bundle=await exportWorkspaceBundle(f.db,source,{now:()=>now}),stage=await stageImport(f.db,owner,new TextEncoder().encode(JSON.stringify(bundle)),now);assert.deepEqual(stage.diagnostics,[]);
 async function review(){
  const before=await readCurrent(f.db,owner,now),planning=previewPlanningMerge(before.workspace,stage.bundle!.planning,none);
  return prepareNormalizedMerge({query:ownerReader(f.db,owner),userId:owner,workspaceRevision:before.revision,planningAfter:planning.workspace,bundle:stage.bundle!,importHash:stage.hash,importedAt:new Date(stage.createdAt).toISOString()});
 }
 async function commit(db=f.db,reviewHash?:string,mutationId=crypto.randomUUID()){
  const before=await readCurrent(db,owner,now);
  return executeWorkspaceCommand(owner,{protocolVersion:1,expectedRevision:before.revision,mutationId,command:{type:'workspace.import.commit',importId:stage.id,hash:stage.hash,targetRevision:before.revision,mode:'merge',selection:none,...(reviewHash?{normalizedReviewHash:reviewHash}:{})}},{db,handlers:workspaceHandlers,now:()=>now});
 }
 function retained(userId=owner){return Object.fromEntries([...OWNER_TABLES,'acceptance_owner_grants','decision_owner_grants','workspace_job_intents','device_credentials','automation_runtime'].map(table=>[table,f.sqlite.prepare('SELECT * FROM '+table+' WHERE user_id=? ORDER BY 1,2').all(userId)]));}
 return {...f,put,stage,review,commit,retained,existingId};
}
test('reviewed disjoint normalized merge preserves owner rows/revisions/grants and imports inert cross-module history atomically',async()=>{
 const f=await fixture();try{
  const original=f.retained(),other=f.retained(foreign),planning=canonical((await readCurrent(f.db,owner,now)).workspace),review=await f.review();assert.deepEqual(review.review.conflicts,[]);assert.ok(review.writes.length>10);assert.ok(review.review.warnings.length);
  assert.equal(review.review.rows.filter(row=>row.disposition==='derived-quota').length,1);
  assert.deepEqual(await f.review(),review,'fixed stage time makes the entire review deterministic');
  await assert.rejects(f.commit(),/Review the exact normalized merge/);
  const mutationId=crypto.randomUUID(),revision=(await readCurrent(f.db,owner,now)).revision,result=await f.commit(f.db,review.review.reviewHash,mutationId);assert.equal(result.status,'committed');
  assert.equal(canonical((await readCurrent(f.db,owner,now)).workspace),planning);
  for(const [table,rows]of Object.entries(original))for(const row of rows){const id=String(row.id??row.record_id??row.decision_id);if(table==='attachment_usage')continue;const current=f.sqlite.prepare('SELECT * FROM '+table+' WHERE user_id=? AND '+(table==='acceptance_owner_grants'?'record_id':table==='decision_owner_grants'?'decision_id':'id')+'=?').get(owner,id);assert.deepEqual({...current},{...row},table+' retained row');}
  assert.deepEqual(f.retained(foreign),other);
  assert.equal(JSON.parse(String(f.sqlite.prepare('SELECT payload_json FROM source_connections WHERE user_id=?').get(owner)!.payload_json)).enabled,false);
  assert.equal(JSON.parse(String(f.sqlite.prepare('SELECT payload_json FROM source_observations WHERE user_id=?').get(owner)!.payload_json)).origin,'provider-read');
  assert.ok(JSON.parse(String(f.sqlite.prepare('SELECT payload_json FROM evidence_requirements WHERE user_id=?').get(owner)!.payload_json)).archivedAt);
  assert.ok(JSON.parse(String(f.sqlite.prepare('SELECT payload_json FROM devices WHERE user_id=?').get(owner)!.payload_json)).archivedAt);
  const week=JSON.parse(String(f.sqlite.prepare('SELECT payload_json FROM weekly_plans WHERE user_id=?').get(owner)!.payload_json));assert.deepEqual(week.taskIds,[]);assert.equal(week.capacityMinutes,null);
  assert.equal(JSON.parse(String(f.sqlite.prepare('SELECT payload_json FROM automation_schedules WHERE user_id=?').get(owner)!.payload_json)).enabled,false);
  assert.equal(JSON.parse(String(f.sqlite.prepare('SELECT payload_json FROM attachments WHERE user_id=?').get(owner)!.payload_json)).status,'quarantined');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM acceptance_owner_grants WHERE user_id=?').get(owner)!.n,1);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM decision_owner_grants WHERE user_id=?').get(owner)!.n,0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM source_sync_state WHERE user_id=?').get(owner)!.n,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM source_access_grants WHERE user_id=?').get(owner)!.n,0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_job_intents WHERE user_id=?').get(owner)!.n,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM automation_runtime WHERE user_id=?').get(owner)!.n,0);
  assert.deepEqual(JSON.parse(String(f.sqlite.prepare("SELECT payload_json FROM attachment_usage WHERE user_id=? AND id='quota'").get(owner)!.payload_json)),{bytes:3,files:1});
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_backups WHERE user_id=?').get(owner)!.n,1);
  const replay=await executeWorkspaceCommand(owner,{protocolVersion:1,expectedRevision:revision,mutationId,command:{type:'workspace.import.commit',importId:f.stage.id,hash:f.stage.hash,targetRevision:revision,mode:'merge',selection:none,normalizedReviewHash:review.review.reviewHash}},{db:f.db,handlers:workspaceHandlers,now:()=>now});assert.equal(replay.status,'replayed');
  assert.equal((await exportWorkspaceBundle(f.db,owner,{now:()=>now})).modules.source_observations.records.length,1);
 }finally{f.sqlite.close();}
});
test('same physical identity with changed immutable body is a review conflict, never overwrite or silent skip',async()=>{
 const f=await fixture(true);try{
  const before=f.retained(),review=await f.review();assert.ok(review.review.conflicts.some(row=>row.module==='evidence'&&row.reason==='different-body'));assert.deepEqual(review.writes,[]);
  await assert.rejects(f.commit(f.db,review.review.reviewHash),/identity conflict/);
  assert.deepEqual(f.retained(),before);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_mutations WHERE user_id=?').get(owner)!.n,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_backups WHERE user_id=?').get(owner)!.n,0);
 }finally{f.sqlite.close();}
});
test('full owner row-set race after normalized review aborts all additions, backup, receipt and planning effects',async()=>{
 const f=await fixture();try{
  const review=await f.review(),before=await readCurrent(f.db,owner,now);let fired=false;
  const raced:SqlDatabase={...f.db,batch:async statements=>{if(!fired){fired=true;await f.put(owner,'evidence_records','late-legacy',{text:'Separate committed concurrent metadata'},2);}return f.db.batch(statements);}};
  await assert.rejects(f.commit(raced,review.review.reviewHash));
  assert.equal((await readCurrent(f.db,owner,now)).revision,before.revision);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM source_connections WHERE user_id=?').get(owner)!.n,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_backups WHERE user_id=?').get(owner)!.n,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_mutations WHERE user_id=?').get(owner)!.n,0);
  assert.ok(await ownerReader(f.db,owner).get('evidence_records','late-legacy'));
 }finally{f.sqlite.close();}
});
test('identical portable bodies deduplicate existing physical rows without changing their revision',async()=>{
 const f=await fixture();try{
  const bundle=await exportWorkspaceBundle(f.db,owner,{now:()=>now}),before=await readCurrent(f.db,owner,now),rows=f.retained();
  const review=await prepareNormalizedMerge({query:ownerReader(f.db,owner),userId:owner,workspaceRevision:before.revision,planningAfter:before.workspace,bundle,importHash:await contentHash(JSON.stringify(bundle)),importedAt:now});
  assert.deepEqual(review.review.conflicts,[]);assert.deepEqual(review.writes,[]);assert.ok(review.review.rows.some(row=>row.disposition==='deduplicate'));assert.deepEqual(f.retained(),rows);
 }finally{f.sqlite.close();}
});
test('combined-reference validation rejects selected planning omissions and a changed review token grants no merge authority',async()=>{
 const f=await fixture();try{
  const before=await readCurrent(f.db,owner,now),review=await f.review();
  await assert.rejects(prepareNormalizedMerge({query:ownerReader(f.db,owner),userId:owner,workspaceRevision:before.revision,planningAfter:{...before.workspace,tasks:[]},bundle:f.stage.bundle!,importHash:f.stage.hash,importedAt:now}),/missing|reference|task/i);
  await assert.rejects(f.commit(f.db,'f'.repeat(64)),/Review the exact normalized merge|stale/);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_backups WHERE user_id=?').get(owner)!.n,0);
  assert.equal((await readCurrent(f.db,owner,now)).revision,before.revision);assert.ok(review.review.reviewHash);
 }finally{f.sqlite.close();}
});

test('a ready-file callback cannot manufacture private owner generation authority',async()=>{
 const f=await fixture();try{
  const before=await readCurrent(f.db,owner,now),verifyAttachment=async(record:AttachmentRecord)=>({record,verifiedBytes:record.expectedBytes,verifiedSha256:record.sha256!,signatureVerified:true as const});
  const review=await prepareNormalizedMerge({query:ownerReader(f.db,owner),userId:owner,workspaceRevision:before.revision,planningAfter:before.workspace,bundle:f.stage.bundle!,importHash:f.stage.hash,importedAt:new Date(f.stage.createdAt).toISOString(),verifyAttachment});
  assert.equal(review.verifiedAttachments.length,1,'synthetic trusted test callback supplies a proposed proof only');
  await assert.rejects(executeWorkspaceCommand(owner,{protocolVersion:1,expectedRevision:before.revision,mutationId:crypto.randomUUID(),command:{type:'workspace.import.commit',importId:f.stage.id,hash:f.stage.hash,targetRevision:before.revision,mode:'merge',selection:none,normalizedReviewHash:review.review.reviewHash}},{db:f.db,handlers:workspaceHandlers,now:()=>now,verifyAttachment}));
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM attachments WHERE user_id=?').get(owner)!.n,0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_backups WHERE user_id=?').get(owner)!.n,0);
  assert.equal((await readCurrent(f.db,owner,now)).revision,before.revision);
 }finally{f.sqlite.close();}
});
test('unavailable private file verifier has one bounded deadline and returns explicit quarantined metadata',async()=>{
 const f=await fixture();try{
  const before=await readCurrent(f.db,owner,now),review=await prepareNormalizedMerge({query:ownerReader(f.db,owner),userId:owner,workspaceRevision:before.revision,planningAfter:before.workspace,bundle:f.stage.bundle!,importHash:f.stage.hash,importedAt:now,verificationMs:5,verifyAttachment:async()=>new Promise(()=>{})});
  assert.deepEqual(review.verifiedAttachments,[]);
  assert.equal((review.writes.find(row=>row.table==='attachments')!.value as {status:string}).status,'quarantined');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM attachments WHERE user_id=?').get(owner)!.n,0);
 }finally{f.sqlite.close();}
});

test('new occurrence source claims cannot suppress generation under a retained owner rule',async()=>{
 const f=await fixture();try{
  const task=(await readCurrent(f.db,owner,now)).workspace.tasks[0],{id:ignoredId,createdAt:ignoredCreated,updatedAt:ignoredUpdated,completedAt:ignoredCompleted,weeklyWeek:ignoredWeek,archivedFromStatus:ignoredArchive,status:ignoredStatus,weekly:ignoredWeekly,dueDate:ignoredDue,dependsOn:ignoredDepends,evidence:ignoredEvidence,...template}=task;
  void ignoredId;void ignoredCreated;void ignoredUpdated;void ignoredCompleted;void ignoredWeek;void ignoredArchive;void ignoredStatus;void ignoredWeekly;void ignoredDue;void ignoredDepends;void ignoredEvidence;
  const rule={id:'retained-active-rule',startDate:'2026-10-18',endDate:null,enabled:true,pattern:{frequency:'daily',interval:1},template};
  await f.put(owner,'recurrence_rules',rule.id,rule);await f.put(source,'recurrence_rules',rule.id,rule);
  await f.put(source,'recurrence_occurrences',rule.id+':2026-10-19',{ruleId:rule.id,occurrenceDate:'2026-10-19',taskId:null,generatedAt:now,disposition:'skipped'});
  const bundle=await exportWorkspaceBundle(f.db,source,{now:()=>now}),before=await readCurrent(f.db,owner,now);
  await assert.rejects(prepareNormalizedMerge({query:ownerReader(f.db,owner),userId:owner,workspaceRevision:before.revision,planningAfter:before.workspace,bundle,importHash:await contentHash(JSON.stringify(bundle)),importedAt:now}),/retained owner occurrence semantics/);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM recurrence_occurrences WHERE user_id=?').get(owner)!.n,0);
  assert.equal(JSON.parse(String(f.sqlite.prepare('SELECT payload_json FROM recurrence_rules WHERE user_id=?').get(owner)!.payload_json)).enabled,true);
 }finally{f.sqlite.close();}
});
