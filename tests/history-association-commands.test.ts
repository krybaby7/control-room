import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {createSeedWorkspace} from '../lib/seed.ts';
import {loadWorkspace,readCurrent,type SqlDatabase} from '../lib/workspace-store.ts';
import {executeWorkspaceCommand} from '../lib/workspace-transaction.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {historyRecordId,parseHistoryRecord,type HistoryRecordKind} from '../lib/history/record.ts';
import {readHistoryRecord} from '../lib/history/store.ts';
import {associationTarget} from '../lib/history/association.ts';
import {historyAssociationCommandHandlers,historyAssociationCommandSchema,associationRuleId,type HistoryAssociationCommand} from '../lib/history/association-commands.ts';
const now='2026-10-22T12:00:00.000Z';
async function fixture(){
 const f=database(),workspace=createSeedWorkspace(now),projectId=workspace.projects[0].id,otherProjectId=workspace.projects[1].id;
 workspace.areas=[{id:'area-one',projectId,name:'Explicit owner area',aliases:[],order:0,archivedAt:null},{id:'area-two',projectId:otherProjectId,name:'Foreign project area',aliases:[],order:0,archivedAt:null},{id:'area-archived',projectId,name:'Archived area',aliases:[],order:1,archivedAt:now}];
 for(const owner of ['owner','other'])await loadWorkspace(f.db,owner,()=>workspace,now);
 async function put(kind:HistoryRecordKind,logical:string,value:unknown,owner='owner'){
  const id=await historyRecordId(kind,logical),record=parseHistoryRecord({id,kind,value}),text=canonical(record);
  f.sqlite.prepare('INSERT INTO project_history(user_id,id,row_revision,payload_json,content_hash) VALUES(?,?,1,?,?)').run(owner,id,text,await contentHash(text));return record;
 }
 const source=(id:string)=>({id,configuration:{codecVersion:1,sourceId:id,kind:'codex_local',epoch:'epoch',scopeRevision:1,roots:[],accountId:null,deviceId:null,includeArchived:true,exclusions:[],parserVersion:'p1',normalizationVersion:'n1'},capability:{sourceId:id,kind:'codex_local',scopeLabel:'Synthetic',inventory:'unverified',contentRead:'unverified',unattendedRead:false,verifiedAt:null,proofRef:null,limitation:'Fixture'},epoch:'epoch',scopeRevision:1,executionEpoch:0,paused:true,removedAt:null});
 await put('source','source-a',source('source-a'));await put('source','source-b',source('source-b'));await put('source','source-a',source('source-a'),'other');
 const conversation=(id:string,sourceId='source-a',repositoryIdentity:string|null='https://github.com/example/retained.git')=>({id,sourceId,nativeThreadId:id,sessionTreeId:null,parentConversationId:null,title:'A misleading owner project title is not identity',projectId:null,repositoryIdentity,branch:null,createdAt:null,sourceUpdatedAt:null,archived:null,availability:'complete'});
 await put('conversation','conversation-a',conversation('conversation-a'));await put('conversation','conversation-b',conversation('conversation-b'));await put('conversation','foreign-conversation',conversation('foreign-conversation'),'other');
 await put('message','message-a',{id:'message-a',conversationId:'conversation-a',nativeMessageId:'native-message',revisionDigest:'a'.repeat(64),normalizationVersion:'n1',parentNativeMessageId:null,sequence:0,role:'assistant',occurredAt:null,observedAt:now,bodyObjectKey:'history/synthetic/body',contentBytes:0,availability:'complete'});
 const command:HistoryAssociationCommand={type:'history.association.set',scope:'conversation',targetIds:[associationTarget('source-a','conversation-a')],projectId,areaId:'area-one',expectedRowRevision:null,reason:'Explicit owner review of retained context'};
 return {...f,workspace,projectId,otherProjectId,command,put};
}
const deps=(db:SqlDatabase)=>({db,handlers:historyAssociationCommandHandlers,now:()=>now});
const envelope=(command:unknown,mutationId='association-owner-mutation-0001',expectedRevision=1)=>({protocolVersion:1,expectedRevision,mutationId,command});
function records(sqlite:Awaited<ReturnType<typeof fixture>>['sqlite'],owner='owner'){return sqlite.prepare("SELECT * FROM project_history WHERE user_id=? AND json_extract(payload_json,'$.kind')<>'association_rule' ORDER BY id").all(owner);}

test('owner mapping uses the shared receipt/CAS boundary, advances rule revisions and preserves all source/task records',async()=>{
 const f=await fixture();try{
  const before=await readCurrent(f.db,'owner'),sourceRows=records(f.sqlite),foreign=records(f.sqlite,'other'),input=envelope(f.command),first=await executeWorkspaceCommand('owner',input,deps(f.db));assert.equal(first.status,'committed');
  const logical=await associationRuleId('conversation',f.command.targetIds),saved=await readHistoryRecord(f.db,'owner','association_rule',logical);assert.ok(saved);assert.equal(saved.rowRevision,1);assert.equal(saved.record.value.rowRevision,1);assert.equal(saved.record.value.provenanceRef,'owner-mutation:'+input.mutationId);assert.equal(saved.record.value.areaId,'area-one');assert.deepEqual((await readCurrent(f.db,'owner')).workspace,before.workspace);assert.deepEqual(records(f.sqlite),sourceRows);assert.deepEqual(records(f.sqlite,'other'),foreign);
  const snapshot=f.sqlite.prepare('SELECT * FROM workspace_job_intents').all();assert.equal(snapshot.length,1);assert.equal(snapshot[0].kind,'area_analysis');assert.equal((await executeWorkspaceCommand('owner',input,deps(f.db))).status,'replayed');assert.deepEqual(f.sqlite.prepare('SELECT * FROM workspace_job_intents').all(),snapshot);
  const changed=await executeWorkspaceCommand('owner',envelope({...f.command,areaId:null,expectedRowRevision:1,reason:'Keep the project but clear this area'},'association-owner-mutation-0002',2),deps(f.db));assert.equal(changed.status,'committed');const updated=await readHistoryRecord(f.db,'owner','association_rule',logical);assert.equal(updated!.rowRevision,2);assert.equal(updated!.record.value.rowRevision,2);assert.equal(updated!.record.value.areaId,null);
  await assert.rejects(executeWorkspaceCommand('owner',envelope({...f.command,expectedRowRevision:1},'association-owner-mutation-0003',3),deps(f.db)),/revision/);assert.deepEqual(records(f.sqlite),sourceRows);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM audit_events WHERE user_id=?').get('owner')!.n,2);
 }finally{f.sqlite.close();}
});
test('target sets have stable source-qualified identities and reject authority fields, duplicates and invalid bounds',async()=>{
 const targets=[associationTarget('source-a','conversation-b'),associationTarget('source-a','conversation-a')];assert.equal(await associationRuleId('conversation',targets),await associationRuleId('conversation',[...targets].reverse()));assert.notEqual(await associationRuleId('messages',targets),await associationRuleId('conversation',targets));assert.notEqual(await associationRuleId('conversation',targets),await associationRuleId('conversation',[associationTarget('other-source','conversation-a')]));
 const f=await fixture();try{for(const patch of [{ownerId:'other'},{provenanceRef:'forged'},{reason:' '},{reason:'x'.repeat(4001)},{targetIds:[]},{targetIds:Array(101).fill('target')},{expectedRowRevision:0}])assert.throws(()=>historyAssociationCommandSchema.parse({...f.command,...patch}));
  for(const targetIds of [[f.command.targetIds[0],f.command.targetIds[0]],['raw-conversation'],['["source-a","conversation-a","extra"]']])await assert.rejects(executeWorkspaceCommand('owner',envelope({...f.command,targetIds},crypto.randomUUID()),deps(f.db)));
  assert.equal((await readCurrent(f.db,'owner')).revision,1);
 }finally{f.sqlite.close();}
});
test('messages resolve through actual owned conversations and foreign owner/source/area lookups fail closed',async()=>{
 const f=await fixture();try{
  const invalid=[{targetIds:[associationTarget('source-a','foreign-conversation')]},{targetIds:[associationTarget('source-b','conversation-a')]},{areaId:'area-two'},{areaId:'area-archived'},{projectId:'missing'},{scope:'messages',targetIds:[associationTarget('source-b','message-a')]}];
  for(const patch of invalid)await assert.rejects(executeWorkspaceCommand('owner',envelope({...f.command,...patch},crypto.randomUUID()),deps(f.db)),/owner|source|area|project/i);
  const result=await executeWorkspaceCommand('owner',envelope({...f.command,scope:'messages',targetIds:[associationTarget('source-a','message-a')]},'association-message-mutation-0001'),deps(f.db));assert.equal(result.status,'committed');
  const logical=await associationRuleId('messages',[associationTarget('source-a','message-a')]);assert.equal((await readHistoryRecord(f.db,'owner','association_rule',logical))!.record.value.scope,'messages');assert.equal(await readHistoryRecord(f.db,'other','association_rule',logical),null);
 }finally{f.sqlite.close();}
});
test('repository mapping requires retained source context and canonicalizes only explicit source-qualified identities',async()=>{
 const f=await fixture();try{
  const command={...f.command,scope:'repository',targetIds:[associationTarget('source-a','git@github.com:EXAMPLE/Retained.git')]};const result=await executeWorkspaceCommand('owner',envelope(command),deps(f.db));assert.equal(result.status,'committed');
  const canonicalTarget=associationTarget('source-a','github.com/example/retained'),logical=await associationRuleId('repository',[canonicalTarget]),saved=(await readHistoryRecord(f.db,'owner','association_rule',logical))!;assert.deepEqual(saved.record.value.targetIds,[canonicalTarget]);
  for(const targetIds of [['github.com/example/retained'],[associationTarget('source-b','github.com/example/retained')],[associationTarget('source-a','github.com/guessed/from-title')]])await assert.rejects(executeWorkspaceCommand('owner',envelope({...command,targetIds},crypto.randomUUID(),2),deps(f.db)),/source-qualified|retained source context/);
 }finally{f.sqlite.close();}
});
test('lost workspace CAS and target-row races roll back the rule, receipt, audit and analysis intent together',async()=>{
 for(const race of ['workspace','target'] as const){const f=await fixture();try{
  const before=records(f.sqlite),sqlByStatement=new WeakMap<object,string>();let raced=false;const db:SqlDatabase={...f.db,prepare(sql){const statement=f.db.prepare(sql);sqlByStatement.set(statement,sql);return statement;},async batch(statements){if(!raced&&statements.some(statement=>sqlByStatement.get(statement)?.startsWith('INSERT INTO workspace_command_guards'))){raced=true;if(race==='workspace')f.sqlite.prepare('UPDATE workspaces SET revision=2 WHERE user_id=?').run('owner');else f.sqlite.prepare('UPDATE project_history SET row_revision=row_revision+1 WHERE user_id=? AND id=?').run('owner',await historyRecordId('conversation','conversation-a'));}return f.db.batch(statements);}};
  if(race==='workspace')assert.deepEqual(await executeWorkspaceCommand('owner',envelope(f.command),deps(db)),{status:'conflict',currentRevision:2});else await assert.rejects(executeWorkspaceCommand('owner',envelope(f.command),deps(db)));
  assert.equal(raced,true);for(const table of ['workspace_mutations','audit_events','workspace_job_intents'])assert.equal(f.sqlite.prepare(`SELECT COUNT(*) n FROM ${table} WHERE user_id=?`).get('owner')!.n,0,table);assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM project_history WHERE user_id=? AND json_extract(payload_json,'$.kind')='association_rule'").get('owner')!.n,0);
  if(race==='workspace')assert.deepEqual(records(f.sqlite),before);
 }finally{f.sqlite.close();}}
});
test('retained source context supports explicit repository rules while owner-override claims cannot manufacture identity evidence',async()=>{
 const f=await fixture();try{
  const claim=(id:string,basis:'provider_metadata'|'owner_override',repositoryIdentity:string)=>({id,projectId:f.projectId,areaId:null,kind:'intent',text:'Retained synthetic context',basis:'observed',citations:[],supportingEvidence:[],context:{sourceId:'source-a',conversationId:'conversation-a',messageRevisionId:'message-a',repositoryIdentity,branch:null,commit:null,basis},supersedesClaimId:null,extractorVersion:'fixture-v1'});
  await f.put('claim','owner-override',claim('owner-override','owner_override','github.com/example/override-only'));
  await assert.rejects(executeWorkspaceCommand('owner',envelope({...f.command,scope:'repository',targetIds:[associationTarget('source-a','github.com/example/override-only')]}),deps(f.db)),/retained source context/);
  await f.put('claim','source-context',claim('source-context','provider_metadata','github.com/example/context-source'));
  const result=await executeWorkspaceCommand('owner',envelope({...f.command,scope:'repository',targetIds:[associationTarget('source-a','github.com/example/context-source')]},'association-context-mutation-0001'),deps(f.db));assert.equal(result.status,'committed');
  const rows=records(f.sqlite),target=await historyRecordId('conversation','conversation-a');f.sqlite.prepare('UPDATE project_history SET content_hash=? WHERE user_id=? AND id=?').run('0'.repeat(64),'owner',target);
  await assert.rejects(executeWorkspaceCommand('owner',envelope(f.command,'association-corrupt-mutation-0001',2),deps(f.db)),/integrity/);assert.equal(records(f.sqlite).length,rows.length);
 }finally{f.sqlite.close();}
});
