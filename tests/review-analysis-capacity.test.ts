import {test} from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {createDurableAnalysisGate} from '../lib/reviews/analysis-store.ts';
import {analyzeReview,buildReviewAnalysisInput} from '../lib/reviews/analysis-policy.ts';
import {canonical,contentHash} from '../lib/canonical-json.ts';
import {moduleProjection,moduleColumnNames} from '../lib/module-columns.ts';
import type {AnalysisPolicy,ReviewSnapshot,ReviewAnalysis} from '../lib/reviews/contracts.ts';
import type {RegisteredOwnerTable} from '../lib/workspace-modules.ts';
import type {JsonValue} from '../lib/workspace-protocol.ts';
import type {SqlDatabase} from '../lib/workspace-store.ts';
import type {ReviewModelAdapter} from '../lib/reviews/adapters/model.ts';
const now='2026-10-18T12:00:00.000Z',future='2026-10-19T12:00:00.000Z',hash='a'.repeat(64);
async function fixture(){const f=database();let clock=now;const policy:AnalysisPolicy={id:'analysis',enabled:true,provider:'fixture-provider',model:'exact-fixture-model',maxCostDollars:1,maxInputBytes:262144,maxOutputTokens:100,timeoutMs:15000},snapshot:ReviewSnapshot={id:'snapshot-a',scope:{projectIds:[],filterDigest:hash},workspaceRevision:1,operationalWatermarks:{sources:0},sourceWatermark:await contentHash(canonical([])),sourceSet:[],generatedAt:now,facts:[],unknowns:[],decisionVersions:[],planningRecords:[],auditRecords:[],coverage:{complete:true,remainingFacts:0,includedFactIds:[],includedEventIds:[]},modelRunId:null};
async function put(table:RegisteredOwnerTable,value:unknown){const payload=value as JsonValue,id=(value as {id:string}).id,columns=moduleColumnNames(table),projection=await moduleProjection(table,id,payload);f.sqlite.prepare(`INSERT INTO ${table}(user_id,id,row_revision,payload_json,content_hash${columns.map(column=>','+column).join('')}) VALUES('owner',?,1,?,?${columns.map(()=>',?').join('')})`).run(id,canonical(value),await contentHash(canonical(value)),...columns.map(column=>projection[column]));}
await put('review_settings',policy);await put('review_snapshots',snapshot);const policyHash=await contentHash(canonical(policy));f.sqlite.prepare('INSERT INTO review_analysis_consents(user_id,policy_hash,provider,model,max_cost_micros,created_at,expires_at) VALUES(?,?,?,?,?,?,?)').run('owner',policyHash,policy.provider!,policy.model!,1000000,now,future);
async function request(value=snapshot,cost=0.6){const snapshotHash=await contentHash(canonical(value));return {ownerId:'owner',requestId:await contentHash(canonical(['review-analysis-v1','owner',snapshotHash,policyHash])),snapshotHash,policyHash,reservedCostDollars:cost};}
async function analysis(value=snapshot,cost:number|null=null):Promise<ReviewAnalysis>{const r=await request(value);return {id:r.requestId,snapshotId:value.id,snapshotHash:r.snapshotHash,provider:policy.provider!,model:policy.model!,inputDigest:(await buildReviewAnalysisInput(value)).inputDigest,status:'completed',startedAt:now,finishedAt:now,usage:{inputTokens:10,outputTokens:2,costDollars:cost},suggestions:[],diagnostic:null};}
const gate=(value=snapshot,db:SqlDatabase=f.db)=>createDurableAnalysisGate(db,'owner',{snapshot:value,policy,now:()=>clock});return {...f,snapshot,policy,policyHash,put,request,analysis,gate,setNow:(value:string)=>{clock=value;}};}
function requests(f:Awaited<ReturnType<typeof fixture>>){return f.sqlite.prepare('SELECT * FROM review_analysis_requests ORDER BY id').all();}
function beforeWrite(db:SqlDatabase,starts:string,callback:()=>Promise<void>|void):SqlDatabase{let once=false;return {...db,prepare(sql){const statement=db.prepare(sql),run=statement.run.bind(statement);if(sql.startsWith(starts))statement.run=async()=>{if(!once){once=true;await callback();}return run();};return statement;}};}
function pressure(f:Awaited<ReturnType<typeof fixture>>,owner='owner'){
 const insert=f.sqlite.prepare('INSERT INTO workspace_drafts(user_id,id,row_revision,payload_json,expires_at) VALUES(?,?,1,?,?)'),payload='x'.repeat(1024*1024);for(let index=0;index<64;index++)insert.run(owner,'synthetic-analysis-pressure-'+index,payload,future);
}
test('private capacity blocks analysis reservation before any provider call and late insertion pressure leaves no ledger row',async t=>{
 const f=await fixture();t.after(()=>f.sqlite.close());let calls=0;pressure(f);
 const adapter:ReviewModelAdapter={async capabilities({provider,model}){return {provider,model,available:true,supportsIdempotency:true,supportsReconcile:true,enforcesOutputTokenLimit:true};},async quote(value){return {requestId:value.requestId,provider:value.provider,model:value.model,inputDigest:value.inputDigest,maxOutputTokens:value.maxOutputTokens,upperBoundCostDollars:0.6,guaranteed:true,expiresAt:future};},async reconcile(){return {state:'not_found'};},async analyze(){calls++;throw new Error('Synthetic provider must not be called');}};
 const result=await analyzeReview({ownerId:'owner',snapshot:f.snapshot,policy:f.policy,now,clock:()=>now,adapter,durableAnalysisRequestGate:f.gate()});assert.notEqual(result.status,'completed');assert.equal(calls,0);assert.equal(requests(f).length,0);
 const late=await fixture();t.after(()=>late.sqlite.close());const racing=beforeWrite(late.db,'INSERT INTO review_analysis_requests',()=>pressure(late));assert.equal(await late.gate(late.snapshot,racing).admit(await late.request()),'blocked');assert.equal(requests(late).length,0);
});
test('capacity refusal preserves the exact unknown paid reservation; foreign-owner pressure does not consume this owner budget',async t=>{
 const f=await fixture();t.after(()=>f.sqlite.close());pressure(f,'foreign');assert.equal(await f.gate().admit(await f.request()),'admitted');const before=requests(f)[0];pressure(f);
 await assert.rejects(async()=>f.gate().persist('owner',await f.analysis()));
 assert.deepEqual(requests(f)[0],before);assert.equal(requests(f)[0].reserved_micros,600000);assert.equal(requests(f)[0].measured_cost_micros,null);assert.equal(requests(f)[0].state,'uncertain');assert.equal(await f.gate().admit(await f.request()),'existing');
});
