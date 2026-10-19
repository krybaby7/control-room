import {createSubscriptionRuntime} from './runtime.mjs';
/** Production entry point. The pinned runtime registry is empty, so no lease,
 * worktree, process, command, provider fallback or model call is performed. */
export function createLocalExecutor(){
 const runtime=createSubscriptionRuntime();
 return Object.freeze({enabled:false,async probeLocalExecution(){return runtime.probeLocalExecution();},async execute(){return {status:'blocked',diagnostic:'not_installed',processStarted:false,processExitConfirmed:false,modelVerified:false};}});
}

import {open,readdir,rename,unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ensurePrivateWindowsState} from '../src/windows-state.mjs';
import {parseCapability,capabilitySha256,executionPolicySha256} from '../src/execution-policy.mjs';
import {readConfig} from '../src/config.mjs';
import {createCredentialStore} from '../src/credentials.mjs';
import {unavailablePrivateIngress} from '../src/transport.mjs';
import {createInstalledSubscriptionRuntime,deriveInstalledToolPolicyEvidence} from './runtime.mjs';
import {openLocalRuntimeInstallation,installLocalRuntime} from './runtime-install.mjs';
import {createWindowsOwnedProcessSupervisor,prepareWindowsOwnedHelperDirectory} from './owned-process.mjs';
import {openLaunchManifest,readPrivateLaunchJson,launchLocalPath,parseLaunchManifest} from './launch-config.mjs';
import {resolveExecutionPrivateIngress} from './connection.mjs';
import {createAgentExecutionTransport,bindAuthenticatedAgentGrant} from './transport.mjs';
import {prepareDurableClaim} from './claims.mjs';
import {openExecutorStore} from './store.mjs';
import {verifyExecutionDirectory,inspectExecutionJournal} from './journal.mjs';
import {createWorkspaceManager} from './workspace.mjs';
import {openExecutionArtifacts} from './artifacts.mjs';
import {createBoundedAttemptRunner} from './runner.mjs';
import {createArtifactUploadTransport,openArtifactUploadJournal,uploadAttemptArtifacts} from './artifact-upload.mjs';
import {finishUploadedAttempt} from './completion.mjs';
import {persistAttemptContext,locateRetainedAttempt,recoverRetainedAttempt} from './recovery.mjs';
import {shape,id,sha,canonical,fail,integer,stamp} from './codec.mjs';

async function directory(path,verifyPrivateState){await verifyExecutionDirectory(path,{create:true,verifyPrivateState});return path;}
async function reserveBudget(directory,identity,timeoutSeconds){const path=join(directory,sha(identity)+'.json'),record={schemaVersion:1,identity,timeoutSeconds};let fd;try{fd=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),0o600);}catch(error){if(error.code!=='EEXIST')throw error;const prior=await readPrivateLaunchJson(path,4096);if(canonical(prior)!==canonical(record))fail('local_budget_identity_differs');return;}
 try{await fd.writeFile(canonical(record));await fd.sync();}finally{await fd.close();}if(process.platform!=='win32'){const parent=await open(directory,'r');try{await parent.sync();}finally{await parent.close();}}
}
/** Conservative retained reservations never refund an unknown/failed run. This
 * reader runs under the single executor store lock and authenticates every journal. */
async function readProtectedLocalBudget({reservations,attempts,current,verifyPrivateState,signal}){
 if(process.platform==='win32')await verifyPrivateState(reservations);const names=await readdir(reservations);if(names.length>12)fail('local_budget_capacity');let usedJobs=0,usedRuntimeSeconds=0,otherActiveAttempts=0;const identities=new Map();
 for(const name of names){if(!/^[a-f0-9]{64}\.json$/u.test(name))fail('local_budget_corrupt');const value=await readPrivateLaunchJson(join(reservations,name),4096);shape(value,['schemaVersion','identity','timeoutSeconds']);if(value.schemaVersion!==1||sha(value.identity)+'.json'!==name)fail('local_budget_corrupt');shape(value.identity,['jobId','attemptId','deviceId','epoch','specSha256']);integer(value.timeoutSeconds,30,600);identities.set(sha(value.identity),value.identity);if(canonical(value.identity)!==canonical(current)){usedJobs++;usedRuntimeSeconds+=value.timeoutSeconds;}}
 for(const name of await readdir(attempts)){if(name==='executor.lock')continue;if(!/^[a-f0-9]{64}$/u.test(name)||!identities.has(name))fail('unaccounted_local_attempt');const identity=identities.get(name);if(canonical(identity)===canonical(current))continue;const snapshot=await inspectExecutionJournal({directory:join(attempts,name),identity,verifyPrivateState});if(!['acknowledged','blocked','process_exited','result_uploaded'].includes(snapshot.phase))otherActiveAttempts++;}
 return {otherActiveAttempts,usedJobs,usedRuntimeSeconds,cancelRequested:signal.aborted,localDisabled:false};
}
export async function installConfiguredLocalRuntime({manifestPath,archivePath}){launchLocalPath(archivePath);const {manifest,verifyPrivateState}=await openLaunchManifest(manifestPath);if(!manifest.enabled)fail('local_execution_disabled');const parent=dirname(manifest.installation.directory);await directory(parent,verifyPrivateState);const installed=await installLocalRuntime({archivePath,...manifest.installation,verifyPrivateState});return {status:'installed',runtimeVersion:installed.runtimeVersion,providerVerified:false,windowsAcceptanceVerified:false};}

/** One explicitly selected job only. No polling, automatic claim retries, launch
 * retries, credential fallbacks, JSON dependency injection or public output. */
export async function createConfiguredLocalExecutor({manifestPath}){
 const {manifest,verifyPrivateState,verifyPrivateWorkspace}=await openLaunchManifest(manifestPath);
 if(!manifest.enabled)return createLocalExecutor();
 const connection=await readConfig(manifest.bridgeConfigPath),ingressAdapter=await resolveExecutionPrivateIngress(connection.cloudBaseUrl,{configPath:manifest.bridgeConfigPath});
 if(ingressAdapter===unavailablePrivateIngress)return Object.freeze({enabled:false,async execute(){return {status:'needs_connection',diagnostic:'private_ingress_unavailable',processStarted:false,processExitConfirmed:false,modelVerified:false};}});
 if(!connection.cloudBaseUrl||!connection.deviceId||manifest.capability.deviceId!==connection.deviceId)fail('device_connection_unavailable');
 const stateRoot=manifest.stateDirectory,credentials=await createCredentialStore({path:join(dirname(manifestPath),'.control-room-bridge','credentials.dpapi')}).load();
 shape(credentials,['deviceId','credentialId','deviceCredential','expiresAt']);if(credentials.deviceId!==connection.deviceId||typeof credentials.deviceCredential!=='string'||Date.parse(stamp(credentials.expiresAt))<=Date.now())fail('device_connection_unavailable');
 const now=()=>new Date().toISOString();let runtimePromise;
 const loadRuntime=()=>runtimePromise??=(async()=>{const installation=await openLocalRuntimeInstallation({...manifest.installation,verifyPrivateState}),owner=await createWindowsOwnedProcessSupervisor({helperExecutable:manifest.helper.executable,helperSha256:manifest.helper.sha256});return createInstalledSubscriptionRuntime({installation,owner,policy:manifest.policy,providerConfiguration:manifest.providerConfiguration,executableEvidence:manifest.executableEvidence,now});})();
 const transportOptions={enabled:true,baseUrl:connection.cloudBaseUrl,deviceCredential:credentials.deviceCredential,ingressAdapter},transport=createAgentExecutionTransport(transportOptions),artifactTransport=createArtifactUploadTransport(transportOptions);
 let consumed=false;
 return Object.freeze({enabled:true,probeLocalExecution:async()=>{const runtime=await loadRuntime();return runtime.probeLocalExecution(manifest.providerConfiguration);},async reportCapability({expectedOperationalRevision=null}={}){
  if(consumed)fail('executor_once_consumed');consumed=true;if(expectedOperationalRevision!==null)integer(expectedOperationalRevision,1,Number.MAX_SAFE_INTEGER-1);ingressAdapter.assertAvailable?.();
  const runtime=await loadRuntime(),probe=await runtime.probeLocalExecution(manifest.providerConfiguration);if(!probe.ready)fail('provider_probe_unavailable');ingressAdapter.assertAvailable?.();
  await directory(stateRoot,verifyPrivateState);const attempts=await directory(join(stateRoot,'attempts'),verifyPrivateState),reservations=await directory(join(stateRoot,'reservations'),verifyPrivateState);await directory(join(stateRoot,'claims'),verifyPrivateState);const store=await openExecutorStore({directory:attempts,verifyPrivateState});
  try{const budget=await readProtectedLocalBudget({reservations,attempts,current:null,verifyPrivateState,signal:new AbortController().signal}),observedAt=now(),end=Math.min(Date.parse(observedAt)+300000,Date.parse(ingressAdapter.releaseUntil??new Date(Date.parse(observedAt)+300000).toISOString()));
   if(end<=Date.parse(observedAt))fail('private_ingress_unavailable');const capability=deriveConfiguredCapability({policy:manifest.policy,runtimeIdentity:runtime.identity,deviceId:connection.deviceId,budget,observedAt,expiresAt:new Date(end).toISOString()});
   const receipt=await transport.capabilities({capability,expectedOperationalRevision});shape(receipt,['sha256','operationalRevision']);if(receipt.sha256!==capabilitySha256(capability)||receipt.operationalRevision!==(expectedOperationalRevision??0)+1)fail('capability_receipt_differs');
   await writeReportedCapability(manifestPath,manifest,capability);return {status:'capability_reported',sha256:receipt.sha256,operationalRevision:receipt.operationalRevision,observedAt,expiresAt:capability.expiresAt,modelExecutionVerified:false};
  }finally{await store.close();}
 },async execute({jobId,signal=new AbortController().signal}={}){
  id(jobId);if(consumed)fail('executor_once_consumed');consumed=true;if(!(signal instanceof AbortSignal))fail('invalid_abort_signal');if(signal.aborted)return {status:'blocked',diagnostic:'cancel_requested'};
  await directory(stateRoot,verifyPrivateState);const attempts=await directory(join(manifest.stateDirectory,'attempts'),verifyPrivateState),reservations=await directory(join(manifest.stateDirectory,'reservations'),verifyPrivateState),claims=await directory(join(manifest.stateDirectory,'claims'),verifyPrivateState),store=await openExecutorStore({directory:attempts,verifyPrivateState});let journal,mappings,report;const conclude=value=>(report=value);
  try{
   const recoverable=await locateRetainedAttempt({attempts,reservations,claims,jobId,deviceId:connection.deviceId,baseUrl:connection.cloudBaseUrl,verifyPrivateState});
   if(recoverable)return conclude(await recoverRetainedAttempt({retained:recoverable,store,transport,verifyPrivateState,now}));
   const runtime=await loadRuntime(),probe=await runtime.probeLocalExecution(manifest.providerConfiguration);if(!probe.ready)return conclude({status:'needs_provider',diagnostic:probe.issues[0]??'probe_failed',processStarted:false,processExitConfirmed:false,modelVerified:false});
   const time=Date.now(),capability=manifest.capability;if(Date.parse(capability.observedAt)>time||Date.parse(capability.expiresAt)<=time||time-Date.parse(capability.observedAt)>300000)fail('capability_stale');
   const claim=await prepareDurableClaim({directory:claims,jobId,verifyPrivateState});if(signal.aborted)fail('cancel_requested');const grant=await transport.claim(claim);if(grant===null)return conclude({status:'no_job',diagnostic:'not_admitted',processStarted:false,processExitConfirmed:false,modelVerified:false});
   const identity={jobId:grant.jobId,attemptId:grant.attemptId,deviceId:connection.deviceId,epoch:grant.executionEpoch,specSha256:grant.record.specSha256};if(identity.jobId!==jobId)fail('claim_job_identity_differs');
   journal=await store.openAttempt(identity);await reserveBudget(reservations,identity,grant.record.spec.timeoutSeconds);
   await persistAttemptContext({directory:join(attempts,sha(identity)),identity,ownerContextHash:grant.frozenAdmission.ownerContextHash,journalNonce:claim.journalNonce,baseUrl:connection.cloudBaseUrl,verifyPrivateState});
   const lease=await bindAuthenticatedAgentGrant(grant,{policy:manifest.policy,capability,journal,readLocalState:()=>readProtectedLocalBudget({reservations,attempts,current:identity,verifyPrivateState,signal})});
   const attemptDirectory=join(attempts,sha(identity)),artifacts=await openExecutionArtifacts({directory:join(attemptDirectory,'artifacts'),verifyPrivateState});
   if(journal.snapshot().phase==='claimed'&&journal.snapshot().nextEventSequence===1)await journal.append({kind:'event',value:{schemaVersion:1,attemptId:identity.attemptId,epoch:identity.epoch,sequence:1,kind:'accepted',observedAt:now(),diagnostic:'ok',details:{specSha256:identity.specSha256,capabilitySha256:lease.binding.capabilitySha256}}});
   const repository=manifest.policy.repositories[lease.spec.repositoryKey];if(!repository)fail('repository_not_registered');
   let workspaceManager={async prepare(){fail('launch_not_admissible');}};
   if(lease.mayLaunch){const workspaceParent=await directory(join(dirname(manifestPath),'.control-room-workspaces'),verifyPrivateWorkspace),workspaceRoot=await directory(join(workspaceParent,'repo-'+sha({repositoryKey:lease.spec.repositoryKey}).slice(0,32)),verifyPrivateWorkspace);workspaceManager=await createWorkspaceManager({gitExecutable:manifest.gitExecutable,repository,stateRoot:workspaceRoot,verifyPrivateWorkspace});}
   const runner=createBoundedAttemptRunner({lease,journal,workspaceManager,runtime,artifacts,config:{enabled:true,...manifest.providerConfiguration},transport,now,authority:ingressAdapter}),outcome=await runner.run({signal});
   if(outcome.mode==='upload_only'){
    const ownerContextHash=grant.frozenAdmission.ownerContextHash;
    mappings=await openArtifactUploadJournal({directory:attemptDirectory,identity,ownerContextHash,verifyPrivateState});
    const mapping=await uploadAttemptArtifacts({journal,artifacts,mappings,ownerContextHash,transport:artifactTransport,credentials:{attemptId:grant.attemptId,leaseToken:grant.leaseToken}});
    // Completion source integration verifies mapped event/result receipts before
    // acknowledgement. Uploading bytes alone cannot claim a terminal result.
    const completed=await finishUploadedAttempt({journal,lease,transport,ownerContextHash,credentials:{attemptId:grant.attemptId,leaseToken:grant.leaseToken},journalNonce:claim.journalNonce,mapping:{journal:mappings,directory:attemptDirectory,verifyPrivateState},now});
    return conclude({status:completed.status,diagnostic:'ok',artifactCount:mapping.remoteIds.length,processStarted:journal.snapshot().processIdentity!==null,processExitConfirmed:true,modelVerified:completed.result.modelVerified});
   }
   const retained=journal.snapshot(),priorResult=retained.records.find(row=>row.entry.kind==='result')?.entry.value;return conclude({status:outcome.mode,diagnostic:outcome.mode==='complete'?'ok':outcome.diagnostic??'owner_review_required',processStarted:retained.processIdentity!==null,processExitConfirmed:outcome.mode==='complete'&&priorResult?.processExitConfirmed===true,modelVerified:outcome.mode==='complete'&&priorResult?.modelVerified===true});
  }catch{const retained=journal?.snapshot(),phase=retained?.phase,exited=['process_exited','result_uploaded','acknowledged'].includes(phase);return conclude({status:exited?'upload_only':'reconcile_required',diagnostic:'retained_state_requires_review',processStarted:retained?.processIdentity!==null&&retained?.processIdentity!==undefined?true:['launch_intent','reconcile_required'].includes(phase)?null:false,processExitConfirmed:exited,modelVerified:false});}finally{let uncertain=false;for(const resource of [mappings,journal,store]){try{await resource?.close();}catch{uncertain=true;}}if(uncertain&&report){report.status='reconcile_required';report.diagnostic='local_close_uncertain';}}
 }});
}

export async function prepareConfiguredLocalHelper({manifestPath}){const {manifest}=await openLaunchManifest(manifestPath);if(!manifest.enabled)fail('local_execution_disabled');await prepareWindowsOwnedHelperDirectory(dirname(manifest.helper.executable));await createWindowsOwnedProcessSupervisor({helperExecutable:manifest.helper.executable,helperSha256:manifest.helper.sha256});return {status:'prepared',windowsAcceptanceVerified:false};}
export async function inspectConfiguredToolPolicy({manifestPath}){const {manifest,verifyPrivateState}=await openLaunchManifest(manifestPath);if(!manifest.enabled)fail('local_execution_disabled');const installation=await openLocalRuntimeInstallation({...manifest.installation,verifyPrivateState});return deriveInstalledToolPolicyEvidence(installation,{provider:manifest.providerConfiguration.provider,platform:process.platform});}

async function writeReportedCapability(manifestPath,manifest,capability){
 const temporary=join(dirname(manifestPath),'.capability-'+randomUUID()+'.json');let file;
 try{if(canonical(parseLaunchManifest(await readPrivateLaunchJson(manifestPath)))!==canonical(manifest))fail('local_configuration_changed');file=await open(temporary,'wx',0o600);await file.writeFile(canonical({...manifest,capability})+'\n');await file.sync();await file.close();file=null;await ensurePrivateWindowsState({configPath:temporary,stateDirectory:join(dirname(manifestPath),'.control-room-bridge')});if(canonical(parseLaunchManifest(await readPrivateLaunchJson(manifestPath)))!==canonical(manifest))fail('local_configuration_changed');await rename(temporary,manifestPath);if(process.platform!=='win32'){const parent=await open(dirname(manifestPath),'r');try{await parent.sync();}finally{await parent.close();}}}finally{await file?.close();await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}

/** Trusted local composition derives capability scope; launch templates are never fresh evidence. */
export function deriveConfiguredCapability({policy,runtimeIdentity,deviceId,budget,observedAt,expiresAt}){
 const remaining=Math.max(0,policy.maxBatchSeconds-budget.usedRuntimeSeconds),repositoryKeys=Object.keys(policy.repositories);
 if(canonical(runtimeIdentity)!==canonical(policy.runtime))fail('runtime_identity_differs');
 return parseCapability({schemaVersion:1,deviceId,configurationSha256:executionPolicySha256(policy),runtime:runtimeIdentity,operations:policy.operations,models:policy.models,repositoryKeys,observedAt,expiresAt,maxConcurrent:1,availableSlots:budget.otherActiveAttempts===0&&budget.usedJobs<policy.maxJobs&&remaining>=30?1:0,maxTimeoutSeconds:Math.max(30,Math.min(policy.maxTimeoutSeconds,remaining)),maxOutputBytesLimit:policy.maxOutputBytesLimit,provider:policy.provider,allowedPathsSha256ByRepositoryKey:Object.fromEntries(repositoryKeys.map(key=>[key,sha(policy.repositories[key].allowedPaths)])),modelIdentityPolicy:policy.modelIdentityPolicy,subscriptionOnly:policy.subscriptionOnly,extraUsageOffAttested:policy.extraUsageOffAttested});
}
