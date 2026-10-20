import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

/** A separate process replaces only the native-owner brand module. This proves
 * wrapper contracts against synthetic bytes, NEVER Windows/helper provenance. */
export function checkSyntheticInstalledComposition(input){
 const script=`
 import assert from 'node:assert/strict';
 import {registerHooks} from 'node:module';
 import {readFileSync} from 'node:fs';
 import {writeFile} from 'node:fs/promises';
 const input=JSON.parse(readFileSync(0,'utf8'));
 let calls=0,confirmed=true;
 globalThis.syntheticOwner={async run(request){calls++;await request.onStarted({pid:123,startedAt:'2026-10-19T00:00:00Z',supervisorId:'fixture',ownershipSha256:'a'.repeat(64)});return {exitCode:0,processExitConfirmed:confirmed,terminationUnconfirmed:!confirmed};}};
 registerHooks({load(url,context,next){if(url.endsWith('/owned-process.mjs'))return {format:'module',shortCircuit:true,source:'export function assertWindowsOwnedProcessSupervisor(owner){if(owner!==globalThis.syntheticOwner)throw Error("synthetic_owner_required");return owner;}'};return next(url,context);}});
 const {installLocalRuntime}=await import(input.installModule);
 const {createInstalledSubscriptionRuntime,deriveInstalledToolPolicyEvidence}=await import(input.runtimeModule);
 const installation=await installLocalRuntime({...input.install,verifyPrivateState:async()=>{}});
 const derived=await deriveInstalledToolPolicyEvidence(installation,{provider:'codex',platform:process.platform});input.policy.runtime.toolPolicySha256=derived.sha256;
 const config={provider:'codex',executable:input.executable,subscriptionOnly:true,extraUsageOffAttested:true};
 const options={installation,owner:globalThis.syntheticOwner,policy:input.policy,providerConfiguration:config,executableEvidence:{sha256:input.policy.runtime.executableSha256,version:'fixture-cli'},now:()=>new Date().toISOString()};
 await assert.rejects(createInstalledSubscriptionRuntime({...options,policy:{...input.policy,runtime:{...input.policy.runtime,toolPolicySha256:'0'.repeat(64)}}}),/tool_policy_mismatch/);
 const runtime=await createInstalledSubscriptionRuntime(options);
 assert.deepEqual(runtime.identity,input.policy.runtime);
 const request={config,workspace:input.workspace,prompt:'Synthetic only',requestedModel:'exact-fixture-model',effort:'medium',mode:'response',timeoutMs:60000,outputBytesLimit:4096,signal:new AbortController().signal,allowUnverifiedModel:false};
 let starts=0;const ownership={async onStarted(){starts++;}};
 const output=await runtime.executeOwned(request,ownership);assert.equal(output.status,'completed');assert.equal(output.processExitConfirmed,true);assert.equal(calls,1);assert.equal(starts,1);
 for(const change of [{requestedModel:'different'},{allowUnverifiedModel:true},{mode:'edit'},{timeoutMs:60001},{outputBytesLimit:4097}])assert.equal((await runtime.executeOwned({...request,...change},ownership)).status,'blocked');assert.equal(calls,1);
 confirmed=false;const stopped=await runtime.executeOwned(request,ownership);assert.equal(stopped.status,'blocked');assert.equal(stopped.processExitConfirmed,false);assert.equal(stopped.error,'termination_unconfirmed');
 await assert.rejects(createInstalledSubscriptionRuntime({...options,installation:{...installation}}));
 await assert.rejects(createInstalledSubscriptionRuntime({...options,executableEvidence:{...options.executableEvidence,version:'wrong'}}));
 await writeFile(input.executable,'Changed synthetic executable');assert.equal((await runtime.executeOwned(request,ownership)).error,'provider_identity_mismatch');
 `;
 const child=spawnSync(process.execPath,['--input-type=module','-e',script],{input:JSON.stringify(input),encoding:'utf8',timeout:15000,maxBuffer:32768});
 assert.equal(child.status,0,child.stderr);assert.equal(child.error,undefined);
}
