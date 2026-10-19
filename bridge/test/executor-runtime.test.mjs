import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createSubscriptionRuntime,createTestRuntimeHarness} from '../executor/runtime.mjs';
const NOW='2026-10-18T12:00:00.000Z';
function fixture(overrides={}){
 const identity={packageName:'synthetic-runtime',packageVersion:'0.0.0-fixture',sourceCommit:'a'.repeat(40),tarballSha256:'b'.repeat(64),runtimeVersion:'fixture-runtime',toolPolicy:'native-sandbox'};
 const config={provider:'codex',executable:'C:\\synthetic\\provider.exe',subscriptionOnly:true,extraUsageOffAttested:true};
 const policy={enabled:true,provider:'codex',executable:config.executable,workspace:'C:\\synthetic\\isolated-worktree',models:[{id:'exact-fixture-model',efforts:['medium']}],pin:identity,allowUnverifiedModel:false,mode:'response',timeoutMs:60000,outputBytesLimit:4096,...overrides};
 const state={probes:0,executions:0,probe:{ready:true,runtimeVersion:identity.runtimeVersion,issues:[],checkedAt:NOW,toolPolicy:identity.toolPolicy},result:{status:'completed',finalText:'Synthetic report only.',stdout:'',stderr:'',observedModel:'exact-fixture-model',observedModels:['exact-fixture-model'],completed:true,exitCode:0,terminationUnconfirmed:false,usage:null,error:null},execute:null};
 const adapter={async probe(){state.probes++;return state.probe;},async execute(request){state.executions++;if(state.execute)return state.execute(request);return state.result;}};
 const runtime=createTestRuntimeHarness({adapter,identity,policy,now:()=>NOW}),request={config,workspace:policy.workspace,prompt:'Synthetic untrusted task text; never shell instructions.',requestedModel:'exact-fixture-model',effort:'medium',mode:'response',timeoutMs:60000,outputBytesLimit:4096,signal:new AbortController().signal};
 return {identity,config,policy,state,adapter,runtime,request};
}
test('production runtime has no installed identity/dependencies and no JSON path/name can select a fake or CLI fallback',async()=>{
 const runtime=createSubscriptionRuntime({now:()=>NOW});
 assert.deepEqual(runtime.installation,{status:'not_installed',enabled:false,provider:null,packageName:null,packageVersion:null,sourceCommit:null,tarballSha256:null,runtimeVersion:null,toolPolicy:null});
 assert.deepEqual(await runtime.probeLocalExecution({provider:'codex'}),{ready:false,runtimeVersion:null,issues:['not_installed'],checkedAt:NOW,toolPolicy:'not_installed'});
 const result=await runtime.execute({command:'not-executed',provider:'api-key',fallback:'fixture'});assert.equal(result.status,'blocked');assert.equal(result.error,'not_installed');assert.equal(result.observedModel,null);assert.deepEqual(result.observedModels,[]);assert.equal(result.completed,false);assert.equal(result.usage,null);assert.equal(result.exitCode,null);
 for(const value of [{adapter:'fake'},{registry:{}},{packageName:'synthetic-runtime'},{executable:'C:\\synthetic\\provider.exe'},{enabled:true},{provider:'claude'},{model:'fallback'}])assert.throws(()=>createSubscriptionRuntime(value));
 const source=await readFile(new URL('../executor/runtime.mjs',import.meta.url),'utf8');assert.doesNotMatch(source,/from ['"]node:(?:child_process|http|https)['"]|import\s*\(|\b(?:spawn|execFile|fetch)\s*\(/u);
});
test('explicit in-memory test harness preserves exact interface without claiming package/model/Windows verification',async()=>{
 const f=fixture(),probe=await f.runtime.probeLocalExecution(f.config),result=await f.runtime.execute(f.request);
 assert.equal(f.runtime.testOnly,true);assert.equal(f.runtime.installation.status,'synthetic-test-only');assert.equal(probe.ready,true);assert.deepEqual(result,f.state.result);assert.equal(f.state.executions,1);assert.equal(f.state.probes,2);
 assert.equal(Object.hasOwn(result,'dollarsSaved'),false);assert.equal(Object.hasOwn(result,'modelVerified'),false);
});
test('source/tarball/package/runtime/tool policy pin mismatch blocks before any fake provider probe or execution',async()=>{
 for(const field of ['packageName','packageVersion','sourceCommit','tarballSha256','runtimeVersion','toolPolicy']){
  const f=fixture(),replacement=field==='sourceCommit'?'c'.repeat(40):field==='tarballSha256'?'d'.repeat(64):'other-fixture',runtime=createTestRuntimeHarness({adapter:f.adapter,identity:f.identity,policy:{...f.policy,pin:{...f.identity,[field]:replacement}},now:()=>NOW});
  assert.equal((await runtime.execute(f.request)).error,'pin_identity_mismatch',field);assert.equal(f.state.executions,0);assert.equal(f.state.probes,0);
 }
});
test('exact provider/executable/model/effort/mode and subscription policy admit no API, fallback or arbitrary environment',async()=>{
 const f=fixture();
 for(const [patch,error]of [[{config:{...f.config,provider:'claude'}},'provider_identity_mismatch'],[{config:{...f.config,provider:'api-key'}},'provider_identity_mismatch'],[{config:{...f.config,executable:'C:\\synthetic\\other.exe'}},'invalid_configuration'],[{config:{...f.config,subscriptionOnly:false}},'subscription_required'],[{config:{...f.config,extraUsageOffAttested:false}},'extra_usage_attestation_required'],[{config:{...f.config,apiKey:'SYNTHETIC_NOT_REAL'}},'invalid_configuration'],[{requestedModel:'fallback-model'},'model_unavailable'],[{effort:'ultra'},'effort_unavailable'],[{mode:'edit'},'policy_blocked'],[{env:{}},'invalid_configuration'],[{workspace:'C:\\synthetic\\original-checkout'},'invalid_request']]){
  const result=await f.runtime.execute({...f.request,...patch});assert.equal(result.status,'blocked');assert.equal(result.error,error);
 }
 assert.equal(f.state.executions,0);assert.equal(f.state.probes,0);
});
test('fresh exact provider evidence required; wrong model/tool/runtime/auth/quota never retries or substitutes',async()=>{
 for(const [patch,error]of [[{runtimeVersion:'other-runtime'},'runtime_identity_mismatch'],[{toolPolicy:'other-policy'},'tool_policy_mismatch'],[{checkedAt:'2026-10-18T11:54:59.000Z'},'probe_stale'],[{checkedAt:'2026-10-18T12:00:01.000Z'},'probe_stale'],[{ready:false,issues:['authentication_required']},'authentication_required'],[{ready:false,issues:['quota_exceeded']},'quota_exceeded'],[{issues:['SYNTHETIC_PRIVATE_ERROR']},'probe_failed']]){
  const f=fixture();f.state.probe={...f.state.probe,...patch};const result=await f.runtime.execute(f.request);assert.equal(result.error,error);assert.equal(f.state.probes,1);assert.equal(f.state.executions,0);
 }
});
test('observed identity mismatch in any emitted model blocks; missing observed model remains null under explicit local policy',async()=>{
 for(const patch of [{observedModel:'unexpected-model'},{observedModels:['exact-fixture-model','unexpected-model']}]){
  const f=fixture();f.state.result={...f.state.result,...patch};const result=await f.runtime.execute(f.request);assert.equal(result.status,'blocked');assert.equal(result.error,'model_identity_mismatch');assert.equal(result.completed,false);assert.equal(f.state.executions,1);
 }
 const f=fixture();f.state.result={...f.state.result,observedModel:null,observedModels:[]};assert.equal((await f.runtime.execute(f.request)).error,'model_identity_unverified');
 const permitted=fixture({allowUnverifiedModel:true});permitted.state.result={...permitted.state.result,observedModel:null,observedModels:[]};const result=await permitted.runtime.execute(permitted.request);assert.equal(result.status,'completed');assert.equal(result.observedModel,null);assert.deepEqual(result.observedModels,[]);assert.equal(Object.hasOwn(result,'modelVerified'),false);
});
test('zero exit alone is insufficient, and uncertain termination never becomes completed or cancelled',async()=>{
 for(const patch of [{completed:false},{exitCode:1}]){const f=fixture();f.state.result={...f.state.result,...patch};assert.equal((await f.runtime.execute(f.request)).error,'terminal_protocol_unverified');}
 for(const status of ['completed','cancelled']){const f=fixture();f.state.result={...f.state.result,status,completed:status==='completed',terminationUnconfirmed:true};const result=await f.runtime.execute(f.request);assert.equal(result.status,'blocked');assert.equal(result.error,'termination_unconfirmed');assert.equal(result.terminationUnconfirmed,true);assert.equal(result.completed,false);}
});
test('request prompt/time/output bounds and combined UTF8 output cap are enforced without raw error disclosure',async()=>{
 const f=fixture();for(const patch of [{prompt:'界'.repeat(10923)},{timeoutMs:29999},{timeoutMs:60001},{outputBytesLimit:4097},{signal:{}},{command:'unsafe'}])assert.equal((await f.runtime.execute({...f.request,...patch})).status,'blocked');assert.equal(f.state.executions,0);
 f.state.result={...f.state.result,finalText:'界'.repeat(1366)};assert.equal((await f.runtime.execute(f.request)).error,'output_limit');
 const error=fixture();error.state.execute=async()=>{throw new Error('SYNTHETIC_PRIVATE_SECRET_AND_PATH');};const result=await error.runtime.execute(error.request);assert.equal(result.error,'runtime_failed');assert.equal(JSON.stringify(result).includes('SYNTHETIC_PRIVATE'),false);
});
test('cancellation before execute has no effect; during fake adapter work only actual returned result is used',async()=>{
 const f=fixture(),cancel=new AbortController();cancel.abort();assert.equal((await f.runtime.execute({...f.request,signal:cancel.signal})).error,'request_cancelled');assert.equal(f.state.probes,0);assert.equal(f.state.executions,0);
 const running=fixture(),controller=new AbortController();let markStarted;const started=new Promise(resolve=>{markStarted=resolve;});running.state.execute=request=>new Promise(resolve=>{request.signal.addEventListener('abort',()=>resolve({...running.state.result,status:'cancelled',completed:false,exitCode:null,terminationUnconfirmed:false,finalText:''}),{once:true});markStarted();});
 const pending=running.runtime.execute({...running.request,signal:controller.signal});await started;controller.abort();const result=await pending;assert.equal(result.status,'cancelled');assert.equal(result.completed,false);assert.equal(result.exitCode,null);assert.equal(running.state.executions,1);
});
test('contradictory completed authentication/quota/policy errors block rather than report success',async()=>{for(const error of ['authentication_required','quota_exceeded','policy_blocked']){const f=fixture();f.state.result={...f.state.result,error};const result=await f.runtime.execute(f.request);assert.equal(result.status,'blocked');assert.equal(result.completed,false);assert.equal(result.error,error);assert.equal(f.state.executions,1);}});
test('typed failure/quota status never retries, usage stays unknown/null and private error prose is classified',async()=>{
 for(const status of ['failed','timed_out','rate_limited','blocked']){const f=fixture();f.state.result={...f.state.result,status,completed:false,exitCode:null,finalText:'',error:'SYNTHETIC_PRIVATE_ERROR'};const result=await f.runtime.execute(f.request);assert.equal(result.status,status);assert.equal(result.error,'runtime_failed');assert.equal(result.usage,null);assert.equal(f.state.executions,1);}
 const f=fixture();f.state.result={...f.state.result,usage:{constructor:10}};assert.equal((await f.runtime.execute(f.request)).status,'blocked');
});
