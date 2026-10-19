import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
/** Isolated test-only module replacements: no native/provider/credential claims.
 * Actual private manifest reader, fixed transport/grant brand, durable claim,
 * budget/store/journal, finite runner and completion code run unchanged. */
export function checkSyntheticExecutorComposition(input){
 const script=`
 import assert from 'node:assert/strict';
 import {registerHooks} from 'node:module';
 import {readFileSync} from 'node:fs';
 import {readdir,readFile} from 'node:fs/promises';
 import {join} from 'node:path';
 const input=JSON.parse(readFileSync(0,'utf8')),RealDate=Date,NOW='2026-10-18T12:00:00.000Z';
 globalThis.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[NOW]));}static now(){return globalThis.syntheticRecoveryNow??RealDate.parse(NOW);}};
 let launches=0,claims=0,completions=0,reconciliations=0,firstNonce=null;
 globalThis.syntheticIngress={async getHeaders(){return {headers:{'x-synthetic-private-ingress':'test-only'},expiresAt:'2099-01-01T00:00:00.000Z'};}};
 globalThis.syntheticRuntime={identity:input.manifest.policy.runtime,async probeLocalExecution(){return {ready:true,issues:[]};},async executeOwned(request,{onStarted}){launches++;await onStarted({pid:123,startedAt:NOW,supervisorId:'fixture-owner',ownershipSha256:'a'.repeat(64)});return {status:'failed',finalText:'',stdout:'',stderr:'',observedModel:null,observedModels:[],completed:false,exitCode:1,terminationUnconfirmed:false,processExitConfirmed:true,usage:null,error:'runtime_failed'};}};
 const modules={
 'runtime.mjs':'export function createSubscriptionRuntime(){throw Error("unused");} export async function createInstalledSubscriptionRuntime(){return globalThis.syntheticRuntime;} export async function deriveInstalledToolPolicyEvidence(){throw Error("unused");}',
 'runtime-install.mjs':'export async function openLocalRuntimeInstallation(){if(globalThis.syntheticRuntimeUnavailable)throw Error("runtime must not be opened for recovery");return {};} export async function installLocalRuntime(){throw Error("unused");}',
 'owned-process.mjs':'export async function createWindowsOwnedProcessSupervisor(){if(globalThis.syntheticRuntimeUnavailable)throw Error("native helper must not be opened for recovery");return {};} export async function prepareWindowsOwnedHelperDirectory(){throw Error("unused");} export async function prepareWindowsExecutorStateDirectory(){throw Error("unused");} export async function verifyWindowsExecutorStateDirectory(){throw Error("unused");}',
 'credentials.mjs':'export function createCredentialStore(){return {async load(){return {deviceId:"device-fixture",credentialId:"credential-fixture",deviceCredential:"synthetic-private-device",expiresAt:"2099-01-01T00:00:00.000Z"};}};}',
 'connection.mjs':'export function resolveExecutionPrivateIngress(){return globalThis.syntheticIngress;}',
 'workspace.mjs':'export async function createWorkspaceManager(){return {async prepare({workspaceKey}){return {workspaceKey,root:"/synthetic/worktree",files:[],async verify(){},async checkPatch(){}};}};}'
 };
 registerHooks({load(url,context,next){const name=url.split('/').at(-1);if(modules[name])return {format:'module',shortCircuit:true,source:modules[name]};const result=next(url,context);if(name==='executor.mjs')return {...result,source:String(result.source).replace('}catch{const retained=journal?.snapshot()', '}catch(error){console.error("synthetic executor failure",error.code??error.message);const retained=journal?.snapshot()')};return result;}});
 const {wireFixture}=await import(input.wireModule),{sha}=await import(input.codecModule);
 globalThis.fetch=async(url,request)=>{const body=JSON.parse(request.body);assert.equal(request.credentials,'omit');assert.equal(request.headers.get('cookie'),null);
 if(url.endsWith('/capabilities')){assert.deepEqual(body.capability.models,input.manifest.policy.models);assert.equal(body.capability.provider,input.manifest.policy.provider);assert.deepEqual(body.capability.repositoryKeys,Object.keys(input.manifest.policy.repositories));assert.equal(body.capability.maxOutputBytesLimit,input.manifest.policy.maxOutputBytesLimit);return Response.json({sha256:sha(body.capability),operationalRevision:1});}
 if(url.endsWith('/claim')){claims++;const files=await readdir(join(input.manifest.stateDirectory,'claims'));const nonce=JSON.parse(await readFile(join(input.manifest.stateDirectory,'claims',files.find(name=>name.endsWith('.json')))));assert.equal(nonce.journalNonce,body.journalNonce);if(firstNonce===null)firstNonce=body.journalNonce;else assert.equal(body.journalNonce,firstNonce);
 if(input.mode==='ambiguous'&&claims===1)throw Error('Synthetic ambiguous network');const {wire}=wireFixture();wire.resumed=input.mode==='ambiguous'||claims>1;return Response.json(wire);}
 if(url.endsWith('/events'))return Response.json({receipts:body.events.map(event=>({attemptId:event.attemptId,epoch:event.epoch,sequence:event.sequence,payloadSha256:sha(event),receivedAt:NOW})),lastAppliedSequence:body.events.at(-1).sequence});
 if(url.endsWith('/reconcile')){reconciliations++;assert.equal(body.proof,'exited');assert.equal(body.journalNonce,firstNonce);if(body.events)return Response.json({receipts:body.events.map(event=>({attemptId:event.attemptId,epoch:event.epoch,sequence:event.sequence,payloadSha256:sha(event),receivedAt:NOW})),lastAppliedSequence:body.events.at(-1).sequence});return Response.json({result:body.result,recordId:'result:'+body.attemptId});}
 if(url.endsWith('/complete')){completions++;if(input.mode==='lost-result'&&completions===1)throw Error('Synthetic lost completion reply');return Response.json({result:body.result,recordId:'result:'+body.attemptId});}throw Error('Unexpected synthetic endpoint');};
 const {createConfiguredLocalExecutor}=await import(input.executorModule);
 const executor=await createConfiguredLocalExecutor({manifestPath:input.manifestPath});if(input.mode==='capability'){const report=await executor.reportCapability({expectedOperationalRevision:null});assert.equal(report.status,'capability_reported');const saved=JSON.parse(await readFile(input.manifestPath));assert.deepEqual(saved.capability.models,input.manifest.policy.models);assert.equal(saved.capability.provider,input.manifest.policy.provider);assert.equal(claims,0);assert.equal(launches,0);await assert.rejects(executor.execute({jobId:'job-fixture'}),/executor_once_consumed/);process.exit(0);}const first=await executor.execute({jobId:'job-fixture'});
 if(input.mode==='ambiguous'){assert.equal(first.status,'reconcile_required');assert.equal(launches,0);const resumed=await createConfiguredLocalExecutor({manifestPath:input.manifestPath});const second=await resumed.execute({jobId:'job-fixture'});assert.equal(second.status,'owner_review_required');assert.equal(launches,0);assert.equal(claims,2);}
 else if(input.mode==='lost-result'){assert.equal(first.status,'upload_only',JSON.stringify(first));assert.equal(launches,1);globalThis.syntheticRuntimeUnavailable=true;globalThis.syntheticRecoveryNow=RealDate.parse(NOW)+3600000;globalThis.syntheticRuntime.probeLocalExecution=async()=>{throw Error('provider must not be probed for recovery');};const resumed=await createConfiguredLocalExecutor({manifestPath:input.manifestPath});const second=await resumed.execute({jobId:'job-fixture'});assert.equal(second.status,'acknowledged',JSON.stringify(second));assert.equal(launches,1);assert.equal(claims,1);assert.equal(completions,1);assert.equal(reconciliations,1);}
 else{assert.equal(first.status,'acknowledged',JSON.stringify(first));assert.equal(first.processStarted,true);assert.equal(first.processExitConfirmed,true);assert.equal(launches,1);assert.equal(claims,1);await assert.rejects(executor.execute({jobId:'job-fixture'}),/executor_once_consumed/);}
 `;
 const child=spawnSync(process.execPath,['--input-type=module','-e',script],{input:JSON.stringify(input),encoding:'utf8',timeout:15000,maxBuffer:32768});assert.equal(child.status,0,child.stderr);assert.equal(child.error,undefined);
}
