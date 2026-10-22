import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {createSeedWorkspace} from '../lib/seed.ts';
import {loadWorkspace,readCurrent} from '../lib/workspace-store.ts';
import {ownerReader} from '../lib/workspace-modules.ts';
import {exportWorkspaceBundle} from '../lib/workspace-export.ts';
import {prepareNormalizedMerge} from '../lib/normalized-merge.ts';
import {historyRecordId} from '../lib/history/record.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
const now='2026-10-22T00:00:00.000Z';
async function fixture(){const {db,sqlite}=database(),workspace=createSeedWorkspace(now);workspace.areas=[{id:'area',projectId:workspace.projects[0].id,name:'Map',aliases:[],order:0,archivedAt:null}];await loadWorkspace(db,'owner',()=>workspace,now);await loadWorkspace(db,'source',()=>workspace,now);return {db,sqlite};}
test('empty history module keeps legacy normalized merge working',async()=>{
 const f=await fixture();try{const bundle=await exportWorkspaceBundle(f.db,'source',{now:()=>now}),current=await readCurrent(f.db,'owner');const prepared=await prepareNormalizedMerge({query:ownerReader(f.db,'owner'),userId:'owner',workspaceRevision:current.revision,planningAfter:current.workspace,bundle,importHash:await contentHash(canonical(bundle)),importedAt:now});assert.deepEqual(prepared.review.conflicts,[]);assert.deepEqual(prepared.writes,[]);}finally{f.sqlite.close();}
});
import {historyExportAdapter} from '../lib/history/module.ts';
import {ExportRegistry} from '../lib/workspace-export.ts';
import {stageImport} from '../lib/import-staging.ts';
import {executeWorkspaceCommand} from '../lib/workspace-transaction.ts';
import {workspaceHandlers} from '../lib/workspace-handlers.ts';
import {getRoadmapState} from '../lib/history/roadmap-store.ts';
async function put(f:Awaited<ReturnType<typeof fixture>>,user:string,kind:Parameters<typeof historyRecordId>[0],logical:string,value:unknown){const id=await historyRecordId(kind,logical),record={id,kind,value};f.sqlite.prepare('INSERT INTO project_history(user_id,id,row_revision,payload_json,content_hash) VALUES(?,?,1,?,?)').run(user,id,canonical(record),await contentHash(canonical(record)));return record;}
async function populate(f:Awaited<ReturnType<typeof fixture>>,user='source'){
 const projectId=(await readCurrent(f.db,user)).workspace.projects[0].id,objectKey='history/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222';
 const source={id:'history-source',configuration:{codecVersion:1,sourceId:'history-source',kind:'codex_local',epoch:'old-epoch',scopeRevision:1,roots:['private-root'],accountId:'private-account',deviceId:'private-device',includeArchived:true,exclusions:[],parserVersion:'1',normalizationVersion:'1'},capability:{sourceId:'history-source',kind:'codex_local',scopeLabel:'Synthetic',inventory:'unverified',contentRead:'unverified',unattendedRead:false,verifiedAt:null,proofRef:null,limitation:null},epoch:'old-epoch',scopeRevision:1,executionEpoch:0,paused:false,removedAt:null};
 const records=[];records.push(await put(f,user,'source','history-source',source));
 records.push(await put(f,user,'conversation','chat',{id:'chat',sourceId:'history-source',nativeThreadId:'native',sessionTreeId:null,parentConversationId:null,title:'Synthetic',projectId,repositoryIdentity:null,branch:null,createdAt:null,sourceUpdatedAt:null,archived:false,availability:'complete'}));
 records.push(await put(f,user,'message','message',{id:'message',conversationId:'chat',nativeMessageId:'native-message',revisionDigest:'a'.repeat(64),normalizationVersion:'1',parentNativeMessageId:null,sequence:0,role:'user',occurredAt:null,observedAt:now,bodyObjectKey:objectKey,contentBytes:5,availability:'complete'}));
 records.push(await put(f,user,'segment','segment',{id:'segment',sourceId:'history-source',conversationId:'chat',nativeSegmentId:'native-segment',inheritedFromSegmentId:null,inheritedRange:null,sha256:'a'.repeat(64),bytes:5,objectKey,availability:'complete',unavailableReason:null}));
 records.push(await put(f,user,'attachment','attachment',{id:'attachment',messageRevisionId:'message',nativeAttachmentId:null,name:'synthetic.txt',mediaType:'text/plain',sha256:'a'.repeat(64),bytes:5,objectKey,availability:'complete',unavailableReason:null}));
 records.push(await put(f,user,'repository_evidence','snapshot',{id:'snapshot',repositoryIdentity:'example/repository',kind:'check',sourceUrl:'https://example.invalid/check',nativeRecordId:'check',candidate:null,environment:null,conclusion:null,observedAt:now,contentDigest:'a'.repeat(64),bodyObjectKey:objectKey,availability:'complete'}));
 records.push(await put(f,user,'claim','claim',{id:'claim',projectId,areaId:'area',kind:'intent',text:'Synthetic requested work',basis:'observed',citations:[{messageRevisionId:'message',revisionDigest:'a'.repeat(64),start:0,end:1}],supportingEvidence:[{kind:'repository',snapshotId:'snapshot',digest:'a'.repeat(64)}],context:{sourceId:'history-source',conversationId:'chat',messageRevisionId:'message',repositoryIdentity:null,branch:null,commit:null,basis:'provider_metadata'},supersedesClaimId:null,extractorVersion:'1'}));
 const checkpoint={id:'checkpoint',label:'Review',acceptance:'Owner reviews',mandatory:true,milestoneId:null,taskIds:[]};
 records.push(await put(f,user,'roadmap_scope','scope@1',{id:'scope',projectId,areaId:'area',revision:1,agreedAt:now,checkpoints:[checkpoint]}));
 records.push(await put(f,user,'roadmap_head','scope',{id:'scope',projectId,areaId:'area',scopeRevision:1,agreedAt:now}));
 records.push(await put(f,user,'checkpoint_assessment','assessment',{id:'assessment',scopeId:'scope',scopeRevision:1,checkpointId:'checkpoint',verdict:'accepted',reason:'Historical source claim',claimIds:['claim'],recordedAt:now}));
 return {records,objectKey};
}
async function review(f:Awaited<ReturnType<typeof fixture>>){const bundle=await exportWorkspaceBundle(f.db,'source',{now:()=>now}),current=await readCurrent(f.db,'owner');return {bundle,prepared:await prepareNormalizedMerge({query:ownerReader(f.db,'owner'),userId:'owner',workspaceRevision:current.revision,planningAfter:current.workspace,bundle,importHash:await contentHash(canonical(bundle)),importedAt:now})};}
test('disjoint reviewed history merge keeps IDs and citations while quarantining namespaces and owner authority',async()=>{
 const f=await fixture();try{
  const {records,objectKey}=await populate(f),{bundle,prepared}=await review(f);assert.deepEqual(prepared.review.conflicts,[]);assert.equal(prepared.writes.length,records.length);assert.deepEqual(new Set(prepared.writes.map(w=>w.id)),new Set(records.map(r=>r.id)));
  const byKind=new Map(prepared.writes.map(w=>{const record=w.value as unknown as {kind:string;value:Record<string,unknown>};return [record.kind,record.value];}));
  assert.equal(byKind.get('source')!.paused,true);assert.deepEqual((byKind.get('source')!.configuration as {roots:string[]}).roots,[]);assert.equal((byKind.get('source')!.capability as {unattendedRead:boolean}).unattendedRead,false);
  assert.equal(byKind.get('message')!.availability,'unavailable');assert.notEqual(byKind.get('message')!.bodyObjectKey,objectKey);assert.equal(byKind.get('message')!.revisionDigest,'a'.repeat(64));
  for(const kind of ['segment','attachment']){assert.equal(byKind.get(kind)!.objectKey,null);assert.equal(byKind.get(kind)!.availability,'unavailable');}
  assert.equal(byKind.get('repository_evidence')!.availability,'unavailable');assert.equal(byKind.get('roadmap_head')!.agreedAt,null);
  assert.deepEqual(byKind.get('claim')!.citations,[{messageRevisionId:'message',revisionDigest:'a'.repeat(64),start:0,end:1}]);assert.ok(prepared.historyClaims.some(r=>JSON.stringify(r.sourceValue).includes(objectKey)));assert.ok(prepared.review.warnings.some(w=>/private object namespaces/.test(w)));
  const staged=await stageImport(f.db,'owner',new TextEncoder().encode(canonical(bundle)),now),current=await readCurrent(f.db,'owner');assert.deepEqual(staged.diagnostics,[]);
  const committed=await executeWorkspaceCommand('owner',{protocolVersion:1,expectedRevision:current.revision,mutationId:'history-normalized-reviewed-merge-0001',command:{type:'workspace.import.commit',importId:staged.id,hash:staged.hash,targetRevision:current.revision,mode:'merge',selection:{projects:[],areas:[],milestones:[],tasks:[],captures:[],activity:[]},normalizedReviewHash:prepared.review.reviewHash}},{db:f.db,handlers:workspaceHandlers,now:()=>now});assert.equal(committed.status,'committed');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM acceptance_owner_grants WHERE user_id=?').get('owner')!.n,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM history_ingest_credentials WHERE user_id=?').get('owner')!.n,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM history_object_ledger WHERE user_id=?').get('owner')!.n,0);
  const state=await getRoadmapState(ownerReader(f.db,'owner'),'scope');assert.equal(state.agreed,false);assert.equal(state.assessments.length,0);assert.equal(state.historicalAssessments.length,1);
 }finally{f.sqlite.close();}
});
test('exact immutable history duplicates preserve existing private owner records and revisions',async()=>{
 const f=await fixture();try{await populate(f,'source');await populate(f,'owner');const before=f.sqlite.prepare('SELECT * FROM project_history WHERE user_id=? ORDER BY id').all('owner'),{prepared}=await review(f);assert.deepEqual(prepared.review.conflicts,[]);assert.deepEqual(prepared.writes,[]);assert.equal(prepared.review.rows.filter(r=>r.disposition==='deduplicate').length,10);assert.deepEqual(f.sqlite.prepare('SELECT * FROM project_history WHERE user_id=? ORDER BY id').all('owner'),before);}finally{f.sqlite.close();}
});
test('changed immutable history bodies are review conflicts and cannot overwrite owner records',async()=>{
 const f=await fixture();try{await populate(f,'source');await populate(f,'owner');const id=await historyRecordId('message','message'),row=f.sqlite.prepare('SELECT payload_json FROM project_history WHERE user_id=? AND id=?').get('source',id)!,value=JSON.parse(String(row.payload_json));value.value.nativeMessageId='different-native';f.sqlite.prepare('UPDATE project_history SET payload_json=?,content_hash=? WHERE user_id=? AND id=?').run(canonical(value),await contentHash(canonical(value)),'source',id);const before=f.sqlite.prepare('SELECT * FROM project_history WHERE user_id=? ORDER BY id').all('owner'),{prepared}=await review(f);assert.ok(prepared.review.conflicts.some(c=>c.module==='project_history'&&c.id===id&&c.reason==='different-body'));assert.deepEqual(prepared.writes,[]);assert.deepEqual(f.sqlite.prepare('SELECT * FROM project_history WHERE user_id=? ORDER BY id').all('owner'),before);}finally{f.sqlite.close();}
});
test('unknown modules still lack an inert merge contract',async()=>{
 const f=await fixture();try{const bundle=await exportWorkspaceBundle(f.db,'source',{now:()=>now}),current=await readCurrent(f.db,'owner'),registry=new ExportRegistry();registry.register({...historyExportAdapter,key:'future_history'});await assert.rejects(prepareNormalizedMerge({query:ownerReader(f.db,'owner'),userId:'owner',workspaceRevision:1,planningAfter:current.workspace,bundle:{...bundle,modules:{future_history:{schemaVersion:1,records:[]}}},importHash:await contentHash(canonical(bundle)),importedAt:now},registry),/explicit inert merge contract/);}finally{f.sqlite.close();}
});
