import {workspaceHandlers} from '../lib/workspace-handlers.ts';
import {issueMutationId} from '../lib/idempotency-retention.ts';
import {exportWorkspaceBundle} from '../lib/workspace-export.ts';
import {stageImport} from '../lib/import-staging.ts';
import type {SqlDatabase} from '../lib/workspace-store.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {loadWorkspace,readCurrent} from '../lib/workspace-store.ts';
import {createSeedWorkspace} from '../lib/seed.ts';
import {ownerReader} from '../lib/workspace-modules.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {historyRecordId,parseHistoryRecord} from '../lib/history/record.ts';
import {executeWorkspaceCommand,type MutationPlan,type PrepareContext} from '../lib/workspace-transaction.ts';
import {reserveHistoryAnalysis,describeHistoryAnalysisScope,type HistoryAnalysisReservation} from '../lib/history/analysis-journal.ts';
import {historyAnalysisCommandHandler,historyAnalysisCommandSchema,compileHistoryAnalysisConsent,type HistoryAnalysisConsentControl} from '../lib/history/analysis-commands.ts';
const now='2026-10-22T12:00:00.000Z',expires='2026-10-23T12:00:00.000Z',hash=(letter:string)=>letter.repeat(64);
async function fixture(){
 const f=database(),policy={id:'analysis',enabled:true,provider:'synthetic-exact-provider',model:'synthetic-exact-model',maxCostDollars:1,maxInputBytes:4096,maxOutputTokens:1000,timeoutMs:1000};
 for(const owner of ['owner','other']){
  await loadWorkspace(f.db,owner,()=>createSeedWorkspace(now),now);const text=canonical(policy);
  f.sqlite.prepare("INSERT INTO review_settings(user_id,id,row_revision,payload_json,content_hash,setting_kind) VALUES(?,'analysis',1,?,?,'analysis')").run(owner,text,await contentHash(text));
  const logical='source-a',id=await historyRecordId('source',logical),value={id:logical,configuration:{codecVersion:1,sourceId:logical,kind:'codex_local',epoch:'scope-epoch',scopeRevision:1,roots:['selected-private-root'],accountId:null,deviceId:null,includeArchived:true,exclusions:[],parserVersion:'v1',normalizationVersion:'n1'},capability:{sourceId:logical,kind:'codex_local',scopeLabel:'Synthetic selected source',inventory:'unverified',contentRead:'unverified',unattendedRead:false,verifiedAt:null,proofRef:null,limitation:'Fixture'},epoch:'scope-epoch',scopeRevision:1,executionEpoch:0,paused:true,removedAt:null},record=parseHistoryRecord({id,kind:'source',value}),payload=canonical(record);
  f.sqlite.prepare('INSERT INTO project_history(user_id,id,row_revision,payload_json,content_hash) VALUES(?,?,1,?,?)').run(owner,id,payload,await contentHash(payload));
 }
 async function scope(owner='owner'){return describeHistoryAnalysisScope(ownerReader(f.db,owner),['source-a'],0);}
 async function consent(owner='owner',privacy:'history'|'reviews'='history'){
  const value=await scope(owner),key=privacy==='history'?value.scopeHash:value.policyHash;
  f.sqlite.prepare('INSERT OR REPLACE INTO review_analysis_consents(user_id,policy_hash,provider,model,max_cost_micros,created_at,expires_at,revoked_at) VALUES(?,?,?,?,1000000,?,?,NULL)').run(owner,key,policy.provider,policy.model,now,expires);return value;
 }
 const request:HistoryAnalysisReservation={sourceIds:['source-a'],privateSnapshotHash:hash('a'),inputDigest:hash('b'),sourceWatermarkHash:hash('c'),chunkHash:hash('d'),inputBytes:100,provider:policy.provider,model:policy.model,quoteUpperBoundDollars:0.6,now};
 return {...f,policy,scope,consent,request};
}

async function prepare(f:Awaited<ReturnType<typeof fixture>>,revoke=false,owner='owner'){
 const scope=await f.scope(owner),command=historyAnalysisCommandSchema.parse(revoke?{type:'history.analysis.revoke',scopeHash:scope.scopeHash,reason:'Owner withdrew selected transcript consent'}:{type:'history.analysis.authorize',privacyScope:'selected_history',sourceIds:['source-a'],policyHash:scope.policyHash,scopeHash:scope.scopeHash,expiresAt:expires});
 const context:PrepareContext={userId:owner,before:await readCurrent(f.db,owner),command,now,mutationId:'native-history-command-0001',query:ownerReader(f.db,owner),readImport:async()=>{throw Error('No staged import in this fixture');},historyRuntime:{executionEpoch:async()=>0}};
 const plan=await historyAnalysisCommandHandler.prepare(context) as MutationPlan&{historyAnalysisConsent:HistoryAnalysisConsentControl};return {plan,context};
}
async function execute(f:Awaited<ReturnType<typeof fixture>>,prepared:Awaited<ReturnType<typeof prepare>>,options:{guard?:boolean;fail?:boolean}={}){
 const {context,plan}=prepared,bindings=[context.userId,context.mutationId!,'synthetic-token'],claim='EXISTS(SELECT 1 FROM workspace_command_guards WHERE user_id=? AND mutation_id=? AND claim_token=?)';
 const statements=await compileHistoryAnalysisConsent(f.db,context.userId,plan.historyAnalysisConsent,context.command.type,claim,bindings,now);
 const guard=f.db.prepare('INSERT INTO workspace_command_guards(user_id,mutation_id,claim_token,valid) VALUES(?,?,?,1)').bind(...bindings),cleanup=f.db.prepare('DELETE FROM workspace_command_guards WHERE user_id=? AND mutation_id=? AND claim_token=?').bind(...bindings);
 if(options.fail)statements.push(f.db.prepare("INSERT INTO workspace_assertions(user_id,mutation_id,valid) VALUES('owner','synthetic-failure',0)"));
 return f.db.batch([...(options.guard===false?[]:[guard]),...statements,cleanup]);
}
test('native explicit selected-history authorization prepares no writes and compiles exact owner guarded consent',async()=>{
 const f=await fixture();try{const prepared=await prepare(f),scope=await f.scope();assert.equal(prepared.plan.writes.length,0);assert.equal(prepared.plan.jobs.length,0);assert.equal(prepared.plan.preconditions!.length,2);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM review_analysis_consents').get()!.n,0);
  assert.ok(scope.sources[0].semanticDigest,'Native historical refs carry the new semantic identity.');assert.equal(prepared.plan.historyAnalysisConsent.action,'authorize');if(prepared.plan.historyAnalysisConsent.action!=='authorize')return;assert.deepEqual(prepared.plan.historyAnalysisConsent.sources,scope.sources.map(({sourceId,epoch,scopeRevision,rowRevision,contentHash})=>({sourceId,epoch,scopeRevision,rowRevision,contentHash})));assert.equal(Object.hasOwn(prepared.plan.historyAnalysisConsent.sources[0],'semanticDigest'),false);assert.equal(historyAnalysisCommandSchema.safeParse({...prepared.context.command,semanticDigest:scope.sources[0].semanticDigest}).success,false);
  assert.equal(prepared.plan.planningAfter,prepared.context.before.workspace);assert.ok(!JSON.stringify(prepared.plan.events).includes('selected-private-root'));assert.equal(prepared.plan.events[0].entityId,scope.scopeHash);
  await execute(f,prepared,{guard:false});assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM review_analysis_consents').get()!.n,0);
  await execute(f,prepared);const row=f.sqlite.prepare('SELECT * FROM review_analysis_consents').get()!;assert.equal(row.user_id,'owner');assert.equal(row.policy_hash,scope.scopeHash);assert.notEqual(row.policy_hash,scope.policyHash);assert.equal(row.provider,f.policy.provider);assert.equal(row.max_cost_micros,1000000);assert.equal(row.revoked_at,null);
 }finally{f.sqlite.close();}
});
test('portable controls, foreign owners, mismatched commands and mutation claims cannot grant authority',async()=>{
 const f=await fixture();try{const {plan}=await prepare(f),control=plan.historyAnalysisConsent,claim='1',bindings=['owner','native-history-command-0001','synthetic-token'];
  for(const [owner,value,type,args] of [['owner',JSON.parse(JSON.stringify(control)),'history.analysis.authorize',bindings],['other',control,'history.analysis.authorize',bindings],['owner',control,'history.analysis.revoke',bindings],['owner',control,'history.analysis.authorize',['owner','wrong-mutation','token']]] as const)await assert.rejects(compileHistoryAnalysisConsent(f.db,owner,value,type,claim,args,now),/native|differs/);
  assert.equal(historyAnalysisCommandSchema.safeParse({type:'history.analysis.revoke',scopeHash:hash('a'),reason:'withdraw',provider:'injected'}).success,false);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM review_analysis_consents').get()!.n,0);
 }finally{f.sqlite.close();}
});
test('source policy and global-epoch races abort consent grant atomically and final failure rolls back upsert',async()=>{
 for(const race of ['source','policy','epoch','failure']){const f=await fixture();try{const prepared=await prepare(f);
  if(race==='source')f.sqlite.prepare("UPDATE project_history SET row_revision=row_revision+1 WHERE user_id='owner'").run();
  if(race==='policy')f.sqlite.prepare("UPDATE review_settings SET row_revision=row_revision+1 WHERE user_id='owner'").run();
  if(race==='epoch')f.sqlite.prepare("INSERT INTO workspace_execution_state(user_id,epoch,restored_at) VALUES('owner',1,?)").run(now);
  await assert.rejects(execute(f,prepared,{fail:race==='failure'}));assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM review_analysis_consents').get()!.n,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_command_guards').get()!.n,0);
 }finally{f.sqlite.close();}}
});
test('explicit revoke affects only exact owned scope, is guarded and retains original revocation time',async()=>{
 const f=await fixture();try{const own=await f.consent(),other=await f.consent('other');await f.consent('owner','reviews');const prepared=await prepare(f,true);
  await execute(f,prepared,{guard:false});assert.equal(f.sqlite.prepare('SELECT revoked_at FROM review_analysis_consents WHERE user_id=? AND policy_hash=?').get('owner',own.scopeHash)!.revoked_at,null);
  await execute(f,prepared);await execute(f,prepared);assert.equal(f.sqlite.prepare('SELECT revoked_at FROM review_analysis_consents WHERE user_id=? AND policy_hash=?').get('owner',own.scopeHash)!.revoked_at,now);assert.equal(f.sqlite.prepare('SELECT revoked_at FROM review_analysis_consents WHERE user_id=? AND policy_hash=?').get('other',other.scopeHash)!.revoked_at,null);assert.equal(f.sqlite.prepare('SELECT revoked_at FROM review_analysis_consents WHERE user_id=? AND policy_hash=?').get('owner',own.policyHash)!.revoked_at,null);
 }finally{f.sqlite.close();}
});

async function ownerEnvelope(f:Awaited<ReturnType<typeof fixture>>,command:unknown,owner='owner'){
 return {protocolVersion:1,expectedRevision:(await readCurrent(f.db,owner)).revision,mutationId:await issueMutationId(f.db,owner,now),command};
}
test('actual owner transaction authorizes distinct history scope, replays receipt and revokes spending without transferring recovery authority',async()=>{
 const f=await fixture();try{
  const prepared=await prepare(f),input=await ownerEnvelope(f,prepared.context.command),deps={db:f.db,handlers:workspaceHandlers,now:()=>now};
  assert.equal((await executeWorkspaceCommand('owner',input,deps)).status,'committed');assert.equal((await executeWorkspaceCommand('owner',input,deps)).status,'replayed');
  const scope=await f.scope(),consents=f.sqlite.prepare('SELECT * FROM review_analysis_consents WHERE user_id=?').all('owner');assert.equal(consents.length,1);assert.equal(consents[0].policy_hash,scope.scopeHash);assert.notEqual(consents[0].policy_hash,scope.policyHash);assert.equal((await reserveHistoryAnalysis(f.db,'other',f.request)).status,'budget_exhausted');assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM audit_events WHERE user_id=?').get('owner')!.n,1);
  const bundle=await exportWorkspaceBundle(f.db,'owner',{now:()=>now}),stage=await stageImport(f.db,'other',new TextEncoder().encode(JSON.stringify(bundle)),now);assert.deepEqual(stage.diagnostics,[]);
  const restore=await ownerEnvelope(f,{type:'workspace.import.commit',importId:stage.id,hash:stage.hash,targetRevision:1,mode:'replace'},'other');assert.equal((await executeWorkspaceCommand('other',restore,deps)).status,'committed');assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM review_analysis_consents WHERE user_id=?').get('other')!.n,0);assert.equal((await reserveHistoryAnalysis(f.db,'other',f.request)).status,'budget_exhausted');
  const revoke=await ownerEnvelope(f,{type:'history.analysis.revoke',scopeHash:scope.scopeHash,reason:'Withdraw selected history spending'});assert.equal((await executeWorkspaceCommand('owner',revoke,deps)).status,'committed');assert.equal((await reserveHistoryAnalysis(f.db,'owner',f.request)).status,'budget_exhausted');assert.equal(f.sqlite.prepare('SELECT revoked_at FROM review_analysis_consents WHERE user_id=? AND policy_hash=?').get('owner',scope.scopeHash)!.revoked_at,now);
 }finally{f.sqlite.close();}
});
test('actual shared CAS rejects stale policy previews and source or workspace races without consent audit or receipt',async()=>{
 for(const race of ['policy-preview','source','policy','workspace']){const f=await fixture();try{
  const prepared=await prepare(f),input=await ownerEnvelope(f,prepared.context.command);let raced=false;const sqlByStatement=new WeakMap<object,string>();
  if(race==='policy-preview'){const policy={...f.policy,model:'changed-model'},text=canonical(policy);f.sqlite.prepare("UPDATE review_settings SET row_revision=2,payload_json=?,content_hash=? WHERE user_id='owner'").run(text,await contentHash(text));}
  const db:SqlDatabase={...f.db,prepare(sql){const statement=f.db.prepare(sql);sqlByStatement.set(statement,sql);return statement;},async batch(statements){if(!raced&&race!=='policy-preview'&&statements.some(statement=>sqlByStatement.get(statement)?.startsWith('INSERT INTO workspace_command_guards'))){raced=true;if(race==='workspace')f.sqlite.prepare("UPDATE workspaces SET revision=2 WHERE user_id='owner'").run();else f.sqlite.prepare(`UPDATE ${race==='source'?'project_history':'review_settings'} SET row_revision=row_revision+1 WHERE user_id='owner'`).run();}return f.db.batch(statements);}};
  if(race==='workspace')assert.deepEqual(await executeWorkspaceCommand('owner',input,{db,handlers:workspaceHandlers,now:()=>now}),{status:'conflict',currentRevision:2});else await assert.rejects(executeWorkspaceCommand('owner',input,{db,handlers:workspaceHandlers,now:()=>now}));
  for(const table of ['review_analysis_consents','workspace_mutations','audit_events'])assert.equal(f.sqlite.prepare(`SELECT COUNT(*) n FROM ${table} WHERE user_id=?`).get('owner')!.n,0,table);
 }finally{f.sqlite.close();}}
});

test('finite consent authority pool counts ordinary scopes, rejects scope 101 and keeps exact revocation funded',async()=>{
 const f=await fixture();try{const scope=await f.scope();
  for(let index=0;index<100;index++)f.sqlite.prepare('INSERT INTO review_analysis_consents(user_id,policy_hash,provider,model,max_cost_micros,created_at,expires_at,revoked_at) VALUES(?,?,?,?,1000000,?,?,NULL)').run('owner',index.toString(16).padStart(64,'0'),f.policy.provider,f.policy.model,now,expires);
  const prepared=await prepare(f);await assert.rejects(execute(f,prepared));assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM review_analysis_consents WHERE user_id=?').get('owner')!.n,100);assert.equal(f.sqlite.prepare('SELECT 1 FROM review_analysis_consents WHERE user_id=? AND policy_hash=?').get('owner',scope.scopeHash),undefined);
  f.sqlite.prepare('UPDATE review_analysis_consents SET policy_hash=? WHERE user_id=? AND policy_hash=?').run(scope.scopeHash,'owner','0'.repeat(64));await execute(f,prepared);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM review_analysis_consents WHERE user_id=?').get('owner')!.n,100);await execute(f,await prepare(f,true));assert.equal(f.sqlite.prepare('SELECT revoked_at FROM review_analysis_consents WHERE user_id=? AND policy_hash=?').get('owner',scope.scopeHash)!.revoked_at,now);
 }finally{f.sqlite.close();}
});

test('authority pool measures Unicode encoded bytes and oversized historical rows cannot block revocation',async()=>{
 const f=await fixture();try{const value={...f.policy,provider:'界'.repeat(128),model:'界'.repeat(200)},text=canonical(value);f.sqlite.prepare("UPDATE review_settings SET payload_json=?,content_hash=? WHERE user_id='owner'").run(text,await contentHash(text));const prepared=await prepare(f);await assert.rejects(execute(f,prepared),/authority row/);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM review_analysis_consents').get()!.n,0);
  const scope=await f.scope();f.sqlite.prepare('INSERT INTO review_analysis_consents(user_id,policy_hash,provider,model,max_cost_micros,created_at,expires_at,revoked_at) VALUES(?,?,?,?,1000000,?,?,NULL)').run('owner',scope.scopeHash,'legacy-provider','界'.repeat(1000),now,expires);await execute(f,await prepare(f,true));assert.equal(f.sqlite.prepare('SELECT revoked_at FROM review_analysis_consents').get()!.revoked_at,now);
 }finally{f.sqlite.close();}
});
