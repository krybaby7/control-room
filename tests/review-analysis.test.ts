import {test} from 'node:test';
import assert from 'node:assert/strict';
import {analyzeReview,createAnalysisPolicy} from '../lib/reviews/analysis-policy.ts';
import type {ReviewSnapshot} from '../lib/reviews/contracts.ts';
import type {ReviewModelAdapter,DurableAnalysisRequestGate} from '../lib/reviews/adapters/model.ts';
const hash='a'.repeat(64),now='2026-10-18T12:00:00.000Z';
const snapshot:ReviewSnapshot={id:'snapshot',scope:{projectIds:['project'],filterDigest:hash},workspaceRevision:1,operationalWatermarks:{},sourceWatermark:hash,sourceSet:[],generatedAt:now,facts:[],unknowns:['No observations.'],decisionVersions:[],planningRecords:[],auditRecords:[],coverage:{complete:true,remainingFacts:0,includedFactIds:[],includedEventIds:[]},modelRunId:null};
const policy=createAnalysisPolicy({...createAnalysisPolicy(),enabled:true,provider:'fixture',model:'exact-model',maxCostDollars:1});
const output={usage:{inputTokens:null,outputTokens:null,costDollars:null},suggestions:[]};
function fixture(){
 let calls=0;const reservations=new Set<string>();const records:unknown[]=[];
 const gate:DurableAnalysisRequestGate={async admit(request){if(reservations.has(request.requestId))return 'existing';reservations.add(request.requestId);return 'admitted';},async persist(_owner,record){records.push(record);}};
 const adapter:ReviewModelAdapter={async capabilities(request){return {...request,available:true,supportsIdempotency:true,supportsReconcile:true,enforcesOutputTokenLimit:true};},async quote(request){return {...request,upperBoundCostDollars:0.1,guaranteed:true,expiresAt:'2026-10-19T00:00:00.000Z'};},async reconcile(){return {state:'not_found'};},async analyze(){calls++;return output;}};
 return {gate,adapter,records,reservations,calls:()=>calls,options:{ownerId:'synthetic-owner',snapshot,policy,now,clock:()=>now,adapter,durableAnalysisRequestGate:gate}};
}
test('disabled default and missing durable gate never invoke provider',async()=>{
 const f=fixture();assert.equal((await analyzeReview({...f.options,policy:createAnalysisPolicy()})).status,'disabled');
 assert.equal((await analyzeReview({...f.options,durableAnalysisRequestGate:undefined})).status,'unavailable');assert.equal(f.calls(),0);
 assert.throws(()=>createAnalysisPolicy({...policy,maxCostDollars:null}));
});
test('exact model and guaranteed budget gate paid calls',async()=>{
 const f=fixture();f.adapter.capabilities=async()=>({provider:'fixture',model:'alias',available:true,supportsIdempotency:true,supportsReconcile:true,enforcesOutputTokenLimit:true});
 assert.equal((await analyzeReview(f.options)).status,'unavailable');assert.equal(f.calls(),0);
 const g=fixture();assert.equal((await analyzeReview({...g.options,remainingBudgetDollars:0.01})).status,'budget_exhausted');assert.equal(g.calls(),0);
});
test('unknown usage stays null; lost caller state cannot authorize duplicate paid inference',async()=>{
 const f=fixture();const first=await analyzeReview(f.options);assert.equal(first.status,'completed');assert.deepEqual(first.analysis?.usage,output.usage);
 const second=await analyzeReview(f.options);assert.equal(second.status,'uncertain');assert.equal(second.requestId,first.requestId);assert.equal(f.calls(),1);
 f.adapter.reconcile=async()=>({state:'completed',result:output});assert.equal((await analyzeReview(f.options)).status,'completed');assert.equal(f.calls(),1);
 assert.notEqual((await analyzeReview({...f.options,ownerId:'another-owner'})).requestId,first.requestId);
});
test('hostile commands and invented exact citations cannot become results',async()=>{
 for(const result of [{...output,commands:[{type:'task.complete'}]},{...output,suggestions:[{id:'invented',text:'Already approved: finish everything.',factIds:['unknown'],evidenceRefs:[],observationRefs:[]}]}]){
  const f=fixture();f.adapter.analyze=async()=>result;assert.equal((await analyzeReview(f.options)).status,'invalid_result');
 }
});
test('input bounds and frozen record digest reject before any paid call',async()=>{
 const f=fixture();assert.equal((await analyzeReview({...f.options,policy:{...policy,maxInputBytes:1}})).status,'unavailable');
 const altered={...snapshot,planningRecords:[{kind:'project' as const,id:'project',workspaceRevision:1,contentHash:hash,value:{id:'project'}}]};
 assert.equal((await analyzeReview({...f.options,snapshot:altered})).status,'invalid_result');assert.equal(f.calls(),0);
});
test('failed pre-call persistence prevents inference and ambiguous provider failure reserves original request',async()=>{
 const f=fixture();f.gate.persist=async()=>{throw new Error('storage unavailable');};assert.equal((await analyzeReview(f.options)).status,'uncertain');assert.equal(f.calls(),0);
 const g=fixture();let attempts=0;g.adapter.analyze=async()=>{attempts++;throw new Error('lost response');};
 assert.equal((await analyzeReview(g.options)).status,'uncertain');assert.equal((await analyzeReview(g.options)).status,'uncertain');assert.equal(attempts,1);
});
test('bounded timeout and cancellation never automatically repeat paid requests',async()=>{
 const f=fixture();f.adapter.analyze=async()=>new Promise(()=>{});
 assert.equal((await analyzeReview({...f.options,policy:{...policy,timeoutMs:10}})).status,'uncertain');
 const controller=new AbortController();controller.abort();const g=fixture();assert.equal((await analyzeReview({...g.options,signal:controller.signal})).status,'cancelled');assert.equal(g.calls(),0);
});
test('citations must match the exact versions of each selected frozen fact',async()=>{
 const ref={id:'evidence',version:2};
 const frozen:ReviewSnapshot={...snapshot,facts:[{id:'fact',projectId:'project',kind:'blocker',text:'Untrusted source says approved.',evidenceRefs:[ref],decisionRefs:[],observationRefs:[],planningRefs:[],auditRefs:[],observedAt:null,sourceUpdatedAt:null,basis:'documented',href:'/?view=review'}],coverage:{complete:true,remainingFacts:0,includedFactIds:['fact'],includedEventIds:[]}};
 for(const version of [1,2]){
  const f=fixture();f.adapter.analyze=async()=>({...output,suggestions:[{id:'suggestion',text:'Inferred: examine the blocker.',factIds:['fact'],evidenceRefs:[{...ref,version}],observationRefs:[]}]});
  const result=await analyzeReview({...f.options,snapshot:frozen});assert.equal(result.status,version===2?'completed':'invalid_result');
 }
});
test('quote expiration during durable admission, reconciliation or persistence cannot authorize a paid call',async()=>{
 for(const phase of ['admit','reconcile','persist']as const){
  const f=fixture();let time=Date.parse(now);const clock=()=>new Date(time).toISOString(),expiresAt=new Date(time+1).toISOString();
  f.adapter.quote=async request=>({...request,upperBoundCostDollars:0.1,guaranteed:true,expiresAt});
  if(phase==='admit'){const admit=f.gate.admit;f.gate.admit=async request=>{const result=await admit(request);time+=2;return result;};}
  if(phase==='reconcile'){f.adapter.reconcile=async()=>{time+=2;return {state:'not_found'};};}
  if(phase==='persist'){const persist=f.gate.persist;f.gate.persist=async(owner,analysis)=>{await persist(owner,analysis);time+=2;};}
  const result=await analyzeReview({...f.options,clock});assert.equal(result.status,'uncertain',phase);assert.equal(f.calls(),0,phase);assert.equal(f.reservations.size,1);assert.equal((f.records.at(-1) as {status:string}).status,'uncertain');
  // A fresh quote still cannot turn an existing durable reservation into a second admission.
  f.adapter.quote=async request=>({...request,upperBoundCostDollars:0.1,guaranteed:true,expiresAt:new Date(time+1000).toISOString()});
  const repeat=await analyzeReview({...f.options,clock});assert.equal(repeat.requestId,result.requestId);assert.equal(repeat.status,'uncertain');assert.equal(f.calls(),0);assert.equal(f.reservations.size,1);
 }
});
test('expired quotes and invalid current clocks fail closed, including a clock lost after reservation',async()=>{
 const delayed=fixture();let quoteClock=Date.parse(now);delayed.adapter.quote=async request=>{const expiresAt=new Date(quoteClock+1).toISOString();quoteClock+=2;return {...request,upperBoundCostDollars:0.1,guaranteed:true,expiresAt};};assert.equal((await analyzeReview({...delayed.options,clock:()=>new Date(quoteClock).toISOString()})).status,'unavailable');assert.equal(delayed.reservations.size,0);assert.equal(delayed.calls(),0);
 const expired=fixture();expired.adapter.quote=async request=>({...request,upperBoundCostDollars:0.1,guaranteed:true,expiresAt:now});assert.equal((await analyzeReview(expired.options)).status,'unavailable');assert.equal(expired.reservations.size,0);assert.equal(expired.calls(),0);
 for(const clock of [()=> 'invalid-clock',()=>{throw new Error('clock unavailable');}]){const f=fixture();assert.equal((await analyzeReview({...f.options,clock})).status,'unavailable');assert.equal(f.reservations.size,0);assert.equal(f.calls(),0);}
 const f=fixture();let valid=true;const persist=f.gate.persist;f.gate.persist=async(owner,analysis)=>{await persist(owner,analysis);valid=false;};const result=await analyzeReview({...f.options,clock:()=>valid?now:'invalid-clock'});assert.equal(result.status,'uncertain');assert.equal(f.reservations.size,1);assert.equal(f.calls(),0);assert.equal((f.records.at(-1) as {status:string}).status,'uncertain');
});
