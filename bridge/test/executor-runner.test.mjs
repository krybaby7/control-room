import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openExecutionJournal} from '../executor/journal.mjs';
import {openExecutionArtifacts} from '../executor/artifacts.mjs';
import {createBoundedAttemptRunner} from '../executor/runner.mjs';
const NOW='2026-10-19T12:00:00.000Z';
async function fixture(t){
 const directory=await mkdtemp(join(tmpdir(),'runner-fixture-'));
 const identity={jobId:'job-fixture',attemptId:'attempt-fixture',deviceId:'device-fixture',epoch:1,specSha256:'a'.repeat(64)},journal=await openExecutionJournal({directory:join(directory,'attempt'),identity});
 t.after(async()=>{await journal.close();await rm(directory,{recursive:true,force:true});});
 await journal.append({kind:'phase',value:{phase:'claimed',workspaceKey:null,processIdentity:null,nextEventSequence:1}});
 const pin={version:'fixture',packageSha256:'b'.repeat(64),toolPolicySha256:'c'.repeat(64)},state={calls:0,prepares:0,launches:0,mayLaunch:true};
 const lease={identity,binding:{provider:'codex',runtime:pin,modelIdentityPolicy:'require-observed'},spec:{operation:'project.inspect',baseCommit:'d'.repeat(40),requestedModel:'exact-fixture',effort:'medium',timeoutSeconds:30,outputBytesLimit:4096},taskInput:{title:'Synthetic'},get mayLaunch(){return state.mayLaunch;},assertCurrent(){},needsRenew(){return false;},consumeLaunch(){assert.equal(journal.snapshot().phase,'launch_intent');assert.equal(state.mayLaunch,true);state.mayLaunch=false;state.launches++;}};
 const workspaceManager={async prepare({workspaceKey}){state.prepares++;return {workspaceKey,root:directory,files:[],async verify(){},async checkPatch(){}};}};
 state.output={status:'completed',completed:true,exitCode:0,error:null,terminationUnconfirmed:false,processExitConfirmed:true,observedModel:'exact-fixture',observedModels:['exact-fixture'],stdout:'',stderr:'',finalText:JSON.stringify({summary:'Synthetic report.',findings:[],limitations:[]})};
 const runtime={identity:pin,async executeOwned(request,{onStarted}){state.calls++;assert.equal(request.requestedModel,'exact-fixture');await onStarted({pid:123,startedAt:NOW,supervisorId:'supervisor-fixture',ownershipSha256:'e'.repeat(64)});assert.equal(journal.snapshot().phase,'process_started');if(state.throw)throw Error('PRIVATE_ERROR');return state.output;}};
 const artifacts=await openExecutionArtifacts({directory:join(directory,'artifacts')}),config={enabled:true,provider:'codex',executable:process.execPath,subscriptionOnly:true,extraUsageOffAttested:true};
 const runner=createBoundedAttemptRunner({lease,journal,workspaceManager,runtime,artifacts,config,now:()=>NOW});return {runner,state,journal,runtime,lease,workspaceManager,artifacts,config};
}
test('closed coordinator journals intent and owned start before accepting terminal report; second call never launches',async t=>{const f=await fixture(t),result=await f.runner.run();assert.equal(result.result.disposition,'succeeded');assert.equal(result.result.modelVerified,true);assert.equal(f.journal.snapshot().phase,'process_exited');assert.equal(f.journal.snapshot().pending.filter(row=>row.entry.kind==='artifact').length,1);assert.equal((await f.runner.run()).mode,'upload_only');assert.equal(f.state.calls,1);assert.equal(f.state.launches,1);});
test('unknown launch outcome retains durable reconciliation and never relaunches',async t=>{const f=await fixture(t);f.state.throw=true;assert.equal((await f.runner.run()).mode,'reconcile_required');assert.equal(f.journal.snapshot().phase,'reconcile_required');assert.equal(JSON.stringify(f.journal.snapshot()).includes('PRIVATE_ERROR'),false);assert.equal((await f.runner.run()).mode,'reconcile_required');assert.equal(f.state.calls,1);});
test('unconfirmed tree exit cannot claim cancellation or terminal result',async t=>{const f=await fixture(t);f.state.output={...f.state.output,status:'cancelled',completed:false,terminationUnconfirmed:true,processExitConfirmed:false};const result=await f.runner.run();assert.equal(result.mode,'reconcile_required');assert.equal(result.mayClaimCancellation,false);assert.equal(f.journal.snapshot().pending.some(row=>row.entry.kind==='result'),false);});
test('different model and invalid artifacts block despite zero exit',async t=>{for(const patch of [{observedModel:'other'}, {finalText:'not JSON'}]){await t.test(JSON.stringify(patch),async t=>{const f=await fixture(t);Object.assign(f.state.output,patch);const result=await f.runner.run();assert.equal(result.result.disposition,'blocked');assert.equal(result.result.artifactIds.length,0);});}});
test('prelaunch cancellation causes no workspace or process and production execute interface is insufficient',async t=>{const f=await fixture(t),controller=new AbortController();controller.abort();assert.equal((await f.runner.run({signal:controller.signal})).mode,'owner_review_required');assert.equal(f.state.calls,0);assert.equal(f.state.prepares,0);assert.throws(()=>createBoundedAttemptRunner({...f,runtime:{identity:f.runtime.identity,execute(){}},monotonic:()=>0}),/owned_runtime_unavailable/);});
test('adapter completion after cancellation cannot become success, and aggregate UTF8 cap blocks artifacts',async t=>{
 await t.test('cancelled while owned runtime active',async t=>{const f=await fixture(t),controller=new AbortController(),original=f.runtime.executeOwned;f.runtime.executeOwned=async(...args)=>{const result=await original(...args);controller.abort();return result;};const result=await f.runner.run({signal:controller.signal});assert.notEqual(result.result.disposition,'succeeded');assert.equal(result.result.artifactIds.length,0);});
 await t.test('aggregate multibyte output',async t=>{const f=await fixture(t);f.state.output.stdout='界'.repeat(1400);const result=await f.runner.run();assert.equal(result.result.diagnostic,'artifact_invalid');assert.equal(result.result.artifactIds.length,0);});
});
test('runtime returning without owned-start callback requires reconciliation',async t=>{const f=await fixture(t);f.runtime.executeOwned=async()=>f.state.output;const result=await f.runner.run();assert.equal(result.mode,'reconcile_required');assert.equal(f.journal.snapshot().phase,'reconcile_required');assert.equal(f.journal.snapshot().processIdentity,null);});
