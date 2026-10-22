import {validateClaim} from '../lib/history/claims.ts';
import {body,claim,snapshot} from './fixtures/history-understanding.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {loadWorkspace,readCurrent} from '../lib/workspace-store.ts';
import {createSeedWorkspace} from '../lib/seed.ts';
import {ownerReader} from '../lib/workspace-modules.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {historyRecordId,parseHistoryRecord} from '../lib/history/record.ts';
import {requirePrivateCapacity} from '../lib/private-capacity.ts';
import {readCompletedHistoryAnalysis,describeHistoryAnalysisScope,prepareHistoryAnalysisAuthorization,reserveHistoryAnalysis,prepareHistoryAnalysisCompletion,requirePreparedHistoryAnalysisCompletion,type HistoryAnalysisReservation,type PreparedHistoryAnalysisCompletion} from '../lib/history/analysis-journal.ts';
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
function rows(f:Awaited<ReturnType<typeof fixture>>,owner='owner'){return f.sqlite.prepare('SELECT * FROM review_analysis_requests WHERE user_id=? ORDER BY id').all(owner);}
async function finalize(f:Awaited<ReturnType<typeof fixture>>,port:PreparedHistoryAnalysisCompletion,extraFailure=false){
 const cap=await requirePrivateCapacity(f.db,port.ownerId,{growth:port.growth}),assert=(sql:string,bindings:(string|number|null)[])=>f.db.prepare('INSERT INTO workspace_assertions(user_id,mutation_id,valid) SELECT ?,?,CASE WHEN '+sql+' THEN 1 ELSE 0 END').bind(port.ownerId,'synthetic-journal-finalization',...bindings);
 const statements=[assert('('+port.condition.sql+') AND ('+cap.sql+')',[...port.condition.bindings,...cap.bindings]),port.statement(f.db,'1',[]),assert(port.postcondition.sql,port.postcondition.bindings)];
 if(extraFailure)statements.push(assert('0',[]));statements.push(f.db.prepare('DELETE FROM workspace_assertions WHERE user_id=? AND mutation_id=?').bind(port.ownerId,'synthetic-journal-finalization'));return f.db.batch(statements);
}

test('history consent is distinct selected-source native control material and ordinary review consent cannot admit transcripts',async()=>{
 const f=await fixture();try{
  const value=await f.scope(),before=f.sqlite.prepare('SELECT COUNT(*) n FROM review_analysis_consents').get()!.n;
  const command={type:'history.analysis.authorize',privacyScope:'selected_history',sourceIds:['source-a'],policyHash:value.policyHash,scopeHash:value.scopeHash,expiresAt:expires};
  const prepared=await prepareHistoryAnalysisAuthorization({userId:'owner',before:await readCurrent(f.db,'owner'),command,now,mutationId:'native-history-consent-0001',query:ownerReader(f.db,'owner'),readImport:async()=>{throw Error('No staged import in this fixture');},historyRuntime:{executionEpoch:async()=>0}});
  assert.notEqual(value.scopeHash,value.policyHash);assert.equal(prepared.consent.policy_hash,value.scopeHash);assert.equal(prepared.consent.provider,f.policy.provider);assert.equal(prepared.preconditions.length,2);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM review_analysis_consents').get()!.n,before);
  await assert.rejects(prepareHistoryAnalysisAuthorization({userId:'owner',before:await readCurrent(f.db,'owner'),command:{...command,scopeHash:hash('f')},now,mutationId:'native-history-consent-0002',query:ownerReader(f.db,'owner'),readImport:async()=>{throw Error('No staged import in this fixture');},historyRuntime:{executionEpoch:async()=>0}}),/current exact/);
  await f.consent('owner','reviews');assert.equal((await reserveHistoryAnalysis(f.db,'owner',f.request)).status,'budget_exhausted');await f.consent();assert.equal((await reserveHistoryAnalysis(f.db,'owner',f.request)).status,'admitted');assert.equal(rows(f).length,1);assert.ok(String(rows(f)[0].id).startsWith('history-analysis-v1:'));assert.ok(!String(rows(f)[0].payload_json).includes('selected-private-root'));
 }finally{f.sqlite.close();}
});
test('competing real SQLite reservations share the existing owner budget and uncertain retries never authorize a second paid attempt',async()=>{
 const f=await fixture();try{await f.consent();const results=await Promise.all([reserveHistoryAnalysis(f.db,'owner',f.request),reserveHistoryAnalysis(f.db,'owner',{...f.request,chunkHash:hash('e')})]);assert.equal(results.filter(row=>row.status==='admitted').length,1);assert.equal(results.filter(row=>row.status==='budget_exhausted').length,1);const admitted=results.find(row=>row.status==='admitted')!;assert.equal(admitted.status,'admitted');if(admitted.status!=='admitted')return;
  const request=admitted.journal.chunkHash===f.request.chunkHash?f.request:{...f.request,chunkHash:hash('e')};const retry=await reserveHistoryAnalysis(f.db,'owner',request);assert.equal(retry.status,'uncertain');assert.equal(rows(f).length,1);
  await f.consent('other');assert.equal((await reserveHistoryAnalysis(f.db,'other',f.request)).status,'admitted');assert.equal(rows(f,'other').length,1);
 }finally{f.sqlite.close();}
});
test('both ordinary review rows and unknown outcomes remain charged across history admissions',async()=>{
 for(const state of ['uncertain','completed','cancelled']){const f=await fixture();try{await f.consent();
  f.sqlite.prepare("INSERT INTO review_analysis_requests(user_id,id,snapshot_id,snapshot_hash,policy_hash,provider,model,input_digest,state,reserved_micros,measured_cost_micros,created_at,updated_at,payload_json) VALUES('owner','ordinary-review','snapshot',?,?,?,?,?,?,600000,NULL,?,?,'{}')").run(hash('a'),hash('b'),f.policy.provider,f.policy.model,hash('c'),state,now,now);
  assert.equal((await reserveHistoryAnalysis(f.db,'owner',{...f.request,quoteUpperBoundDollars:0.5})).status,'budget_exhausted');assert.equal(rows(f).length,1);
  if(state==='uncertain'){f.sqlite.prepare("UPDATE review_analysis_requests SET measured_cost_micros=0 WHERE id='ordinary-review'").run();assert.equal((await reserveHistoryAnalysis(f.db,'owner',{...f.request,quoteUpperBoundDollars:0.5})).status,'budget_exhausted');}
  f.sqlite.prepare("UPDATE review_analysis_requests SET state='completed',measured_cost_micros=100000 WHERE id='ordinary-review'").run();assert.equal((await reserveHistoryAnalysis(f.db,'owner',{...f.request,quoteUpperBoundDollars:0.5})).status,'admitted');
 }finally{f.sqlite.close();}}
});
test('wrong model, missing sources, revocation, expiry, policy/source/global epoch changes deny new spending',async()=>{
 const f=await fixture();try{const scoped=await f.consent();
  for(const patch of [{provider:'another-provider'},{model:'another-model'},{sourceIds:['foreign-source']},{quoteUpperBoundDollars:1.01},{inputBytes:4097}])assert.equal((await reserveHistoryAnalysis(f.db,'owner',{...f.request,...patch})).status,'budget_exhausted');
  await assert.rejects(reserveHistoryAnalysis(f.db,'owner',{...f.request,sourceIds:undefined} as never));await assert.rejects(reserveHistoryAnalysis(f.db,'owner',{...f.request,quoteUpperBoundDollars:NaN}));
  for(const change of ["revoked_at='2026-10-22T12:00:00.000Z'","expires_at='2026-10-22T11:59:00.000Z'","created_at='2026-10-22T12:01:00.000Z'"]){f.sqlite.prepare('UPDATE review_analysis_consents SET '+change+" WHERE user_id='owner' AND policy_hash=?").run(scoped.scopeHash);assert.equal((await reserveHistoryAnalysis(f.db,'owner',f.request)).status,'budget_exhausted');await f.consent();}
  f.sqlite.prepare("INSERT INTO workspace_execution_state(user_id,epoch,restored_at) VALUES('owner',1,'2026-10-22T12:00:00.000Z')").run();assert.equal((await reserveHistoryAnalysis(f.db,'owner',f.request)).status,'budget_exhausted');assert.equal(rows(f).length,0);
 }finally{f.sqlite.close();}
});
test('completion is a branded sealed same-transaction port, binds output hashes and retains unknown cost reservations',async()=>{
 const f=await fixture();try{await f.consent();const admitted=await reserveHistoryAnalysis(f.db,'owner',f.request);assert.equal(admitted.status,'admitted');if(admitted.status!=='admitted')return;
  const input={requestId:admitted.requestId,inputDigest:f.request.inputDigest,claimHashes:[hash('e')],checkpointDigest:hash('f'),usage:{inputTokens:10,outputTokens:20,costDollars:null},now};
  const port=await prepareHistoryAnalysisCompletion(f.db,'owner',input);assert.equal(Object.hasOwn(port,'attestations'),false);assert.equal(rows(f)[0].state,'uncertain');assert.equal(requirePreparedHistoryAnalysisCompletion(port,'owner',input.inputDigest),port);assert.throws(()=>requirePreparedHistoryAnalysisCompletion({...port},'owner',input.inputDigest),/native prepared/);assert.throws(()=>requirePreparedHistoryAnalysisCompletion(port,'other',input.inputDigest),/owner/);assert.throws(()=>requirePreparedHistoryAnalysisCompletion(port,'owner',hash('a')),/immutable/);
  assert.ok(port.growth[0].bytes>0);assert.equal(port.growth[0].rows,0);await assert.rejects(finalize(f,port,true));assert.equal(rows(f)[0].state,'uncertain');await finalize(f,port);assert.equal(Object.hasOwn(JSON.parse(String(rows(f)[0].payload_json)).completion,'attestations'),false);assert.equal(rows(f)[0].state,'completed');assert.equal(rows(f)[0].measured_cost_micros,null);assert.equal(rows(f)[0].result_id,input.checkpointDigest);assert.equal((await reserveHistoryAnalysis(f.db,'owner',f.request)).status,'replayed');
  assert.equal((await reserveHistoryAnalysis(f.db,'owner',{...f.request,chunkHash:hash('e'),quoteUpperBoundDollars:0.5})).status,'budget_exhausted');assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM acceptance_owner_grants').get()!.n,0);
  await assert.rejects(prepareHistoryAnalysisCompletion(f.db,'owner',{...input,claimHashes:[hash('a')]}),/immutable/);
 }finally{f.sqlite.close();}
});
test('completion rejects foreign inputs, overrun costs and revoked consent, with guards surviving preparation races',async()=>{
 const f=await fixture();try{await f.consent();const admitted=await reserveHistoryAnalysis(f.db,'owner',f.request);assert.equal(admitted.status,'admitted');if(admitted.status!=='admitted')return;
  const input={requestId:admitted.requestId,inputDigest:f.request.inputDigest,claimHashes:[],checkpointDigest:hash('f'),usage:{inputTokens:10,outputTokens:20,costDollars:0.2},now};
  await assert.rejects(prepareHistoryAnalysisCompletion(f.db,'other',input),/reserved/);await assert.rejects(prepareHistoryAnalysisCompletion(f.db,'owner',{...input,inputDigest:hash('a')}),/input/);await assert.rejects(prepareHistoryAnalysisCompletion(f.db,'owner',{...input,usage:{...input.usage,costDollars:0.61}}),/reservation/);await assert.rejects(prepareHistoryAnalysisCompletion(f.db,'owner',{...input,usage:{...input.usage,outputTokens:1001}}),/token/);
  const port=await prepareHistoryAnalysisCompletion(f.db,'owner',input);f.sqlite.prepare("UPDATE review_analysis_consents SET revoked_at=? WHERE user_id='owner'").run(now);await assert.rejects(finalize(f,port));assert.equal(rows(f)[0].state,'uncertain');assert.equal(rows(f)[0].measured_cost_micros,null);
  await f.consent();const valid=await prepareHistoryAnalysisCompletion(f.db,'owner',input);await finalize(f,valid);assert.equal(rows(f)[0].measured_cost_micros,200000);
 }finally{f.sqlite.close();}
});
test('lost reservation response stays uncertain and replay never refunds or invokes a second provider call',async()=>{
 const f=await fixture();try{await f.consent();let lost=false;const db={...f.db,prepare(sql:string){const statement=f.db.prepare(sql);if(!sql.startsWith('INSERT INTO review_analysis_requests'))return statement;return {...statement,bind(...values:(string|number|null)[]){statement.bind(...values);return this;},async run(){const value=await statement.run();if(!lost){lost=true;throw Error('Synthetic response lost after commit');}return value;}};}};
  assert.equal((await reserveHistoryAnalysis(db,'owner',f.request)).status,'uncertain');assert.equal(rows(f).length,1);assert.equal((await reserveHistoryAnalysis(f.db,'owner',f.request)).status,'uncertain');assert.equal(rows(f)[0].reserved_micros,600000);assert.equal(rows(f)[0].measured_cost_micros,null);
 }finally{f.sqlite.close();}
});
test('one hundred selected sources use a fixed bounded SQL proof and changed native scopes require new consent',async()=>{
 const f=await fixture();try{
  const sourceIds=['source-a'],baseId=await historyRecordId('source','source-a'),base=JSON.parse(String(f.sqlite.prepare('SELECT payload_json FROM project_history WHERE user_id=? AND id=?').get('owner',baseId)!.payload_json));
  for(let index=1;index<100;index++){
   const sourceId=`source-${index}`,physical=await historyRecordId('source',sourceId),record=structuredClone(base);record.id=physical;record.value.id=sourceId;record.value.configuration.sourceId=sourceId;record.value.capability.sourceId=sourceId;const text=canonical(record);f.sqlite.prepare('INSERT INTO project_history(user_id,id,row_revision,payload_json,content_hash) VALUES(?,?,1,?,?)').run('owner',physical,text,await contentHash(text));sourceIds.push(sourceId);
  }
  const scope=await describeHistoryAnalysisScope(ownerReader(f.db,'owner'),sourceIds,0),reversed=await describeHistoryAnalysisScope(ownerReader(f.db,'owner'),[...sourceIds].reverse(),0);assert.equal(scope.scopeHash,reversed.scopeHash);
  f.sqlite.prepare('INSERT INTO review_analysis_consents(user_id,policy_hash,provider,model,max_cost_micros,created_at,expires_at) VALUES(?,?,?,?,1000000,?,?)').run('owner',scope.scopeHash,f.policy.provider,f.policy.model,now,expires);
  let admissionBindings=0;const db={...f.db,prepare(sql:string){const statement=f.db.prepare(sql);if(!sql.startsWith('INSERT INTO review_analysis_requests'))return statement;return {...statement,bind(...values:(string|number|null)[]){admissionBindings=values.length;assert.ok(values.length<=100);statement.bind(...values);return this;}};}};
  assert.equal((await reserveHistoryAnalysis(db,'owner',{...f.request,sourceIds})).status,'admitted');assert.ok(admissionBindings>0);
  const changed=structuredClone(base);changed.value.epoch='changed-scope-epoch';changed.value.scopeRevision=2;changed.value.configuration.epoch=changed.value.epoch;changed.value.configuration.scopeRevision=2;const text=canonical(changed);f.sqlite.prepare('UPDATE project_history SET row_revision=2,payload_json=?,content_hash=? WHERE user_id=? AND id=?').run(text,await contentHash(text),'owner',baseId);
  assert.equal((await reserveHistoryAnalysis(f.db,'owner',{...f.request,chunkHash:hash('e')})).status,'budget_exhausted');assert.equal(rows(f).length,1);
 }finally{f.sqlite.close();}
});
test('policy changes and a source-row race after quoting cannot spend under stale history authorization',async()=>{
 const f=await fixture();try{await f.consent();const sourceId=await historyRecordId('source','source-a');let raced=false;const db={...f.db,prepare(sql:string){const statement=f.db.prepare(sql);if(!sql.startsWith('INSERT INTO review_analysis_requests'))return statement;return {...statement,bind(...values:(string|number|null)[]){statement.bind(...values);return this;},async run(){if(!raced){raced=true;f.sqlite.prepare('UPDATE project_history SET row_revision=row_revision+1 WHERE user_id=? AND id=?').run('owner',sourceId);}return statement.run();}};}};
  assert.equal((await reserveHistoryAnalysis(db,'owner',f.request)).status,'budget_exhausted');assert.equal(rows(f).length,0);
  const policy={...f.policy,model:'changed-exact-model'},text=canonical(policy);f.sqlite.prepare("UPDATE review_settings SET row_revision=2,payload_json=?,content_hash=? WHERE user_id='owner' AND id='analysis'").run(text,await contentHash(text));
  assert.equal((await reserveHistoryAnalysis(f.db,'owner',{...f.request,model:policy.model})).status,'budget_exhausted');assert.equal(rows(f).length,0);
 }finally{f.sqlite.close();}
});

test('completed checkpoint trust requires native owner journal and exact current selected-source scope',async()=>{
 const f=await fixture();try{await f.consent();const admitted=await reserveHistoryAnalysis(f.db,'owner',f.request);assert.equal(admitted.status,'admitted');if(admitted.status!=='admitted')return;
  const lookup={requestId:admitted.requestId,inputDigest:f.request.inputDigest,checkpointDigest:hash('f'),sourceIds:['source-a']};assert.equal(await readCompletedHistoryAnalysis(f.db,'owner',lookup),null);
  const port=await prepareHistoryAnalysisCompletion(f.db,'owner',{requestId:admitted.requestId,inputDigest:f.request.inputDigest,claimHashes:[],checkpointDigest:hash('f'),usage:{inputTokens:1,outputTokens:1,costDollars:null},now});await finalize(f,port);
  assert.equal((await readCompletedHistoryAnalysis(f.db,'owner',lookup))!.state,'completed');assert.equal(await readCompletedHistoryAnalysis(f.db,'other',lookup),null);assert.equal(await readCompletedHistoryAnalysis(f.db,'owner',{...lookup,checkpointDigest:hash('e')}),null);assert.equal(await readCompletedHistoryAnalysis(f.db,'owner',{...lookup,sourceIds:['foreign']}),null);
  f.sqlite.prepare("UPDATE review_analysis_consents SET revoked_at=? WHERE user_id='owner'").run(now);assert.ok(await readCompletedHistoryAnalysis(f.db,'owner',lookup));assert.equal((await reserveHistoryAnalysis(f.db,'owner',{...f.request,chunkHash:hash('e')})).status,'budget_exhausted');
  f.sqlite.prepare("DELETE FROM review_settings WHERE user_id='owner'").run();assert.ok(await readCompletedHistoryAnalysis(f.db,'owner',lookup));
  const original=String(rows(f)[0].payload_json);f.sqlite.prepare('UPDATE review_analysis_requests SET payload_json=? WHERE user_id=? AND id=?').run(JSON.stringify(JSON.parse(original),null,2),'owner',lookup.requestId);assert.equal(await readCompletedHistoryAnalysis(f.db,'owner',lookup),null);f.sqlite.prepare('UPDATE review_analysis_requests SET payload_json=? WHERE user_id=? AND id=?').run(original,'owner',lookup.requestId);
  f.sqlite.prepare("UPDATE project_history SET row_revision=row_revision+1 WHERE user_id='owner'").run();assert.ok(await readCompletedHistoryAnalysis(f.db,'owner',lookup));
  const source=f.sqlite.prepare("SELECT id,payload_json FROM project_history WHERE user_id='owner' AND json_extract(payload_json,'$.kind')='source'").get()!,changed=parseHistoryRecord(JSON.parse(String(source.payload_json)));assert.equal(changed.kind,'source');if(changed.kind!=='source')return;changed.value.configuration.roots=['different-selected-root'];const text=canonical(changed);f.sqlite.prepare('UPDATE project_history SET row_revision=row_revision+1,payload_json=?,content_hash=? WHERE user_id=? AND id=?').run(text,await contentHash(text),'owner',source.id);assert.equal(await readCompletedHistoryAnalysis(f.db,'owner',lookup),null);
 }finally{f.sqlite.close();}
});

test('semantic completion attestations require exact native validated claims at reserved input and preserve legacy hashes',async()=>{
 const f=await fixture();try{await f.consent();const message=await body('native-completion','Tool observed completion','tool');message.ownerId='owner';const rawWatermark='history-input:synthetic-native-attestation',pinned={...snapshot([message]),ownerId:'owner',sourceWatermark:rawWatermark},wrapper=await validateClaim(claim(message,'implementation',{basis:'observed'}),pinned,async()=>({supported:true,contradictions:[],completesScope:true,requestsWork:false}));
  const reservation={...f.request,sourceWatermarkHash:await contentHash(rawWatermark)},admitted=await reserveHistoryAnalysis(f.db,'owner',reservation);assert.equal(admitted.status,'admitted');if(admitted.status!=='admitted')return;
  const claimHash=await contentHash(canonical(wrapper.claim)),input={requestId:admitted.requestId,inputDigest:f.request.inputDigest,claimHashes:[claimHash],checkpointDigest:hash('f'),usage:{inputTokens:1,outputTokens:1,costDollars:null},now};
  await assert.rejects(prepareHistoryAnalysisCompletion(f.db,'owner',input,{validatedClaims:[structuredClone(wrapper)]}),/not validated/);await assert.rejects(prepareHistoryAnalysisCompletion(f.db,'owner',{...input,claimHashes:[]},{validatedClaims:[wrapper]}),/exact completion/);
  const wrongWatermark=await validateClaim(claim(message,'implementation',{basis:'observed'}),{...pinned,sourceWatermark:'different-native-input'},async()=>({supported:true,contradictions:[],completesScope:true}));await assert.rejects(prepareHistoryAnalysisCompletion(f.db,'owner',input,{validatedClaims:[wrongWatermark]}),/watermark/);
  const port=await prepareHistoryAnalysisCompletion(f.db,'owner',input,{validatedClaims:[wrapper]});assert.deepEqual(port.attestations,[{claimHash,completionSupported:true,requestSupported:false,unknownsDigest:await contentHash(canonical(wrapper.unknowns))}]);await finalize(f,port);
  const retained=await readCompletedHistoryAnalysis(f.db,'owner',{requestId:admitted.requestId,inputDigest:input.inputDigest,checkpointDigest:input.checkpointDigest,sourceIds:['source-a']});assert.deepEqual(retained!.completion!.attestations,port.attestations);assert.equal(rows(f)[0].result_hash,await contentHash(canonical(retained!.completion)));
  const altered={...wrapper,completionSupported:false};await assert.rejects(prepareHistoryAnalysisCompletion(f.db,'owner',input,{validatedClaims:[altered]}),/not validated/);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM acceptance_owner_grants').get()!.n,0);
 }finally{f.sqlite.close();}
});

test('an uncertain extraction blocks changed global watermark, snapshot and prior-work input without a second paid admission',async()=>{
 const f=await fixture();try{await f.consent();const first=await reserveHistoryAnalysis(f.db,'owner',f.request);assert.equal(first.status,'admitted');if(first.status!=='admitted')return;
  const second=await reserveHistoryAnalysis(f.db,'owner',{...f.request,sourceWatermarkHash:hash('e'),inputDigest:hash('f'),privateSnapshotHash:hash('e')});assert.equal(second.status,'uncertain');if(second.status!=='uncertain')return;assert.equal(second.requestId,first.requestId);assert.deepEqual(second.journal,first.journal);assert.equal(rows(f).length,1);assert.equal(rows(f)[0].reserved_micros,600000);
  const distinct=await reserveHistoryAnalysis(f.db,'owner',{...f.request,chunkHash:hash('e'),quoteUpperBoundDollars:0.5});assert.equal(distinct.status,'budget_exhausted');assert.equal(rows(f).length,1);
 }finally{f.sqlite.close();}
});
test('atomic extraction exclusion admits one competing distinct request and returns its original uncertain identity to the loser',async()=>{
 const f=await fixture();try{await f.consent();const inputA={...f.request,quoteUpperBoundDollars:0.2},inputB={...inputA,sourceWatermarkHash:hash('e'),inputDigest:hash('f')};const results=await Promise.all([reserveHistoryAnalysis(f.db,'owner',inputA),reserveHistoryAnalysis(f.db,'owner',inputB)]);assert.equal(results.filter(result=>result.status==='admitted').length,1);assert.equal(results.filter(result=>result.status==='uncertain').length,1);assert.equal(rows(f).length,1);
  const admitted=results.find(result=>result.status==='admitted')!,uncertain=results.find(result=>result.status==='uncertain')!;assert.equal(uncertain.requestId,admitted.requestId);if(admitted.status==='admitted'&&uncertain.status==='uncertain')assert.deepEqual(uncertain.journal,admitted.journal);assert.equal(rows(f)[0].reserved_micros,200000);
 }finally{f.sqlite.close();}
});
test('a new selected source generation needs fresh consent and retains the old uncertain spending charge',async()=>{
 const f=await fixture();try{await f.consent();const first=await reserveHistoryAnalysis(f.db,'owner',{...f.request,quoteUpperBoundDollars:0.4});assert.equal(first.status,'admitted');
  const physical=await historyRecordId('source','source-a'),row=f.sqlite.prepare('SELECT payload_json FROM project_history WHERE user_id=? AND id=?').get('owner',physical)!,record=JSON.parse(String(row.payload_json));record.value.epoch='new-source-epoch';record.value.scopeRevision=2;record.value.configuration.epoch=record.value.epoch;record.value.configuration.scopeRevision=2;const text=canonical(record);f.sqlite.prepare('UPDATE project_history SET row_revision=2,payload_json=?,content_hash=? WHERE user_id=? AND id=?').run(text,await contentHash(text),'owner',physical);
  const next={...f.request,inputDigest:hash('e'),sourceWatermarkHash:hash('f'),quoteUpperBoundDollars:0.5};assert.equal((await reserveHistoryAnalysis(f.db,'owner',next)).status,'budget_exhausted');await f.consent();assert.equal((await reserveHistoryAnalysis(f.db,'owner',{...next,quoteUpperBoundDollars:0.7})).status,'budget_exhausted');const admitted=await reserveHistoryAnalysis(f.db,'owner',next);assert.equal(admitted.status,'admitted');assert.notEqual(admitted.requestId,first.requestId);assert.equal(rows(f).length,2);assert.equal(rows(f).reduce((sum,row)=>sum+Number(row.reserved_micros),0),900000);
 }finally{f.sqlite.close();}
});
test('corrupted uncertain native extraction journals fail closed even when a new request ID would otherwise fit budget',async()=>{
 for(const corrupt of ['invalid-json','invalid-schema','invalid-digest']){const f=await fixture();try{await f.consent();const admitted=await reserveHistoryAnalysis(f.db,'owner',{...f.request,quoteUpperBoundDollars:0.1});assert.equal(admitted.status,'admitted');if(admitted.status!=='admitted')return;
  const original=JSON.parse(String(rows(f)[0].payload_json));if(corrupt==='invalid-schema')original.executionEpoch='0';if(corrupt==='invalid-digest')original.inputDigest=hash('f');f.sqlite.prepare('UPDATE review_analysis_requests SET payload_json=? WHERE user_id=? AND id=?').run(corrupt==='invalid-json'?'{':canonical(original),'owner',admitted.requestId);
  assert.equal((await reserveHistoryAnalysis(f.db,'owner',{...f.request,inputDigest:hash('e'),sourceWatermarkHash:hash('f'),quoteUpperBoundDollars:0.1})).status,'budget_exhausted');assert.equal(rows(f).length,1);assert.equal(rows(f)[0].reserved_micros,100000);
 }finally{f.sqlite.close();}}
});
test('completed extraction does not act as an uncertain-call fence for a genuinely different request',async()=>{
 const f=await fixture();try{await f.consent();const first=await reserveHistoryAnalysis(f.db,'owner',{...f.request,quoteUpperBoundDollars:0.2});assert.equal(first.status,'admitted');if(first.status!=='admitted')return;const port=await prepareHistoryAnalysisCompletion(f.db,'owner',{requestId:first.requestId,inputDigest:f.request.inputDigest,claimHashes:[],checkpointDigest:hash('f'),usage:{inputTokens:1,outputTokens:1,costDollars:0.1},now});await finalize(f,port);
  const second=await reserveHistoryAnalysis(f.db,'owner',{...f.request,inputDigest:hash('e'),sourceWatermarkHash:hash('f'),quoteUpperBoundDollars:0.2});assert.equal(second.status,'admitted');assert.notEqual(second.requestId,first.requestId);assert.equal(rows(f).length,2);assert.equal(rows(f).find(row=>row.id===first.requestId)!.measured_cost_micros,100000);
 }finally{f.sqlite.close();}
});

test('capability refresh keeps uncertain extraction charged and never relaxes live completion row CAS',async()=>{const f=await fixture();try{
 await f.consent();const first=await reserveHistoryAnalysis(f.db,'owner',f.request);assert.equal(first.status,'admitted');if(first.status!=='admitted')return;let paidCalls=0;const syntheticProvider=async()=>{paidCalls++;return {synthetic:true};};await syntheticProvider();
 const port=await prepareHistoryAnalysisCompletion(f.db,'owner',{requestId:first.requestId,inputDigest:f.request.inputDigest,claimHashes:[],checkpointDigest:hash('f'),usage:{inputTokens:1,outputTokens:1,costDollars:0.1},now});
 const row=f.sqlite.prepare("SELECT id,payload_json FROM project_history WHERE user_id='owner' AND json_extract(payload_json,'$.kind')='source'").get()!,record=parseHistoryRecord(JSON.parse(String(row.payload_json)));assert.equal(record.kind,'source');if(record.kind!=='source')return;record.value.capability={...record.value.capability,verifiedAt:now,proofRef:'synthetic-operational-capability-proof'};const text=canonical(record);f.sqlite.prepare('UPDATE project_history SET payload_json=?,content_hash=?,row_revision=row_revision+1 WHERE user_id=? AND id=?').run(text,await contentHash(text),'owner',row.id);
 await assert.rejects(finalize(f,port));assert.equal(rows(f)[0].state,'uncertain');const retried=await reserveHistoryAnalysis(f.db,'owner',{...f.request,inputDigest:hash('e'),sourceWatermarkHash:hash('f')});if(retried.status==='admitted')await syntheticProvider();assert.equal(retried.status,'uncertain');assert.equal(retried.requestId,first.requestId);assert.equal(paidCalls,1);assert.equal(rows(f).length,1);assert.equal(rows(f)[0].reserved_micros,600000);assert.equal(rows(f)[0].measured_cost_micros,null);
 }finally{f.sqlite.close();}});
test('legacy completed source refs replay unchanged only while exact physical source rows remain',async()=>{const f=await fixture();try{await f.consent();const reservation=await reserveHistoryAnalysis(f.db,'owner',f.request);assert.equal(reservation.status,'admitted');if(reservation.status!=='admitted')return;const completion={requestId:reservation.requestId,inputDigest:f.request.inputDigest,claimHashes:[],checkpointDigest:hash('f'),usage:{inputTokens:1,outputTokens:1,costDollars:null},now};await finalize(f,await prepareHistoryAnalysisCompletion(f.db,'owner',completion));const journal=JSON.parse(String(rows(f)[0].payload_json));for(const ref of journal.sources)delete ref.semanticDigest;const legacy=canonical(journal);f.sqlite.prepare('UPDATE review_analysis_requests SET payload_json=? WHERE user_id=? AND id=?').run(legacy,'owner',reservation.requestId);assert.ok(await readCompletedHistoryAnalysis(f.db,'owner',{requestId:reservation.requestId,inputDigest:f.request.inputDigest,checkpointDigest:completion.checkpointDigest,sourceIds:f.request.sourceIds}));assert.equal((await reserveHistoryAnalysis(f.db,'owner',f.request)).status,'replayed');assert.equal(rows(f)[0].payload_json,legacy);f.sqlite.prepare("UPDATE project_history SET row_revision=row_revision+1 WHERE user_id='owner' AND json_extract(payload_json,'$.kind')='source'").run();assert.equal(await readCompletedHistoryAnalysis(f.db,'owner',{requestId:reservation.requestId,inputDigest:f.request.inputDigest,checkpointDigest:completion.checkpointDigest,sourceIds:f.request.sourceIds}),null);}finally{f.sqlite.close();}});
