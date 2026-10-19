import {open,lstat,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {loadInstalledRuntimeAdapter} from './runtime-install.mjs';
import {assertWindowsOwnedProcessSupervisor} from './owned-process.mjs';
import {parseExecutionPolicy} from '../src/execution-policy.mjs';
import {canonical} from './codec.mjs';
/** No subscription runtime has been installed or verified in this repository.
 * This registry is intentionally empty; only a reviewed source change may add a
 * supported immutable package after independent upstream acceptance. */
const PINNED_RUNTIME_REGISTRY=Object.freeze({});
const OPERATIONS=['response','edit'],EFFORTS=['low','medium','high','xhigh','max','ultra'];
const ISSUES=new Set(['not_installed','disabled','invalid_configuration','invalid_request','pin_identity_mismatch','provider_identity_mismatch','model_unavailable','effort_unavailable','subscription_required','extra_usage_attestation_required','authentication_required','quota_exceeded','policy_blocked','probe_failed','probe_stale','runtime_identity_mismatch','tool_policy_mismatch','request_cancelled','runtime_failed','invalid_runtime_result','output_limit','model_identity_mismatch','model_identity_unverified','terminal_protocol_unverified','termination_unconfirmed']);
export class RuntimeBoundaryError extends Error{constructor(code){super(code);this.name='RuntimeBoundaryError';this.code=code;}}
function bad(code){throw new RuntimeBoundaryError(code);}
function shape(value,keys){if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))bad('invalid_configuration');return value;}
function name(value,max=128){if(typeof value!=='string'||!value||value.length>max||!/^[A-Za-z0-9][A-Za-z0-9._:+-]*$/u.test(value))bad('invalid_configuration');return value;}
function digest(value){if(typeof value!=='string'||!/^[a-f0-9]{64}$/u.test(value))bad('invalid_configuration');return value;}
function commit(value){if(typeof value!=='string'||! /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value))bad('invalid_configuration');return value;}
function integer(value,min,max){if(!Number.isSafeInteger(value)||value<min||value>max)bad('invalid_request');return value;}
function stamp(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?Z$/u.test(value)||!Number.isFinite(Date.parse(value))||new Date(value.slice(0,10)+'T00:00:00Z').toISOString().slice(0,10)!==value.slice(0,10))bad('invalid_configuration');return value;}
function localPath(value){if(typeof value!=='string'||value.length>1024||/[\u0000-\u001f\u007f"*?<>|]/u.test(value)||!(/^[A-Za-z]:[\\/]/u.test(value)||/^\/[^/]/u.test(value))||value.startsWith('\\\\')||value.split(/[\\/]/u).some(part=>part==='.'||part==='..'))bad('invalid_configuration');if(/^[A-Za-z]:[\\/]/u.test(value)?value.slice(2).includes(':'):value.includes('\\'))bad('invalid_configuration');return value;}
function providerConfig(value){shape(value,['provider','executable','subscriptionOnly','extraUsageOffAttested']);if(!['codex','claude'].includes(value.provider))bad('provider_identity_mismatch');if(value.subscriptionOnly!==true)bad('subscription_required');if(value.extraUsageOffAttested!==true)bad('extra_usage_attestation_required');return {provider:value.provider,executable:localPath(value.executable),subscriptionOnly:true,extraUsageOffAttested:true};}
function frozenInstallation(){return Object.freeze({status:'not_installed',enabled:false,provider:null,packageName:null,packageVersion:null,sourceCommit:null,tarballSha256:null,runtimeVersion:null,toolPolicy:null});}
function blocked(code,values={}){return {status:'blocked',finalText:'',stdout:'',stderr:'',observedModel:values.observedModel??null,observedModels:values.observedModels??[],completed:false,exitCode:values.exitCode??null,terminationUnconfirmed:values.terminationUnconfirmed===true,usage:null,error:ISSUES.has(code)?code:'runtime_failed'};}
function unavailableProbe(now,issue='not_installed'){return {ready:false,runtimeVersion:null,issues:[issue],checkedAt:stamp(now()),toolPolicy:'not_installed'};}
/** Production factory accepts no adapter/package/path/model/config selection.
 * There is no require/import, CLI spawn, provider API, or fallback implementation. */
export function createSubscriptionRuntime(options={}){
 if(!options||Object.getPrototypeOf(options)!==Object.prototype||Object.keys(options).some(key=>key!=='now')||options.now!==undefined&&typeof options.now!=='function')bad('invalid_configuration');
 const now=options.now??(()=>new Date().toISOString());
 if(Object.keys(PINNED_RUNTIME_REGISTRY).length!==0)throw new RuntimeBoundaryError('pin_identity_mismatch');
 const probeLocalExecution=async()=>unavailableProbe(now),execute=async()=>blocked('not_installed');
 return Object.freeze({installation:frozenInstallation(),probeLocalExecution,probe:probeLocalExecution,execute});
}
function pin(raw){shape(raw,['packageName','packageVersion','sourceCommit','tarballSha256','runtimeVersion','toolPolicy']);return {packageName:name(raw.packageName),packageVersion:name(raw.packageVersion),sourceCommit:commit(raw.sourceCommit),tarballSha256:digest(raw.tarballSha256),runtimeVersion:name(raw.runtimeVersion),toolPolicy:name(raw.toolPolicy)};}
function testPolicy(raw){shape(raw,['enabled','provider','executable','workspace','models','pin','allowUnverifiedModel','mode','timeoutMs','outputBytesLimit']);if(typeof raw.enabled!=='boolean'||typeof raw.allowUnverifiedModel!=='boolean'||!['codex','claude'].includes(raw.provider)||!OPERATIONS.includes(raw.mode)||!Array.isArray(raw.models)||raw.models.length>32)bad('invalid_configuration');const models=raw.models.map(value=>{shape(value,['id','efforts']);if(!Array.isArray(value.efforts)||!value.efforts.length||value.efforts.length>EFFORTS.length||value.efforts.some(effort=>!EFFORTS.includes(effort))||new Set(value.efforts).size!==value.efforts.length)bad('invalid_configuration');return {id:name(value.id),efforts:[...value.efforts]};});if(new Set(models.map(value=>value.id)).size!==models.length)bad('invalid_configuration');return {enabled:raw.enabled,provider:raw.provider,executable:localPath(raw.executable),workspace:localPath(raw.workspace),models,pin:pin(raw.pin),allowUnverifiedModel:raw.allowUnverifiedModel,mode:raw.mode,timeoutMs:integer(raw.timeoutMs,30000,600000),outputBytesLimit:integer(raw.outputBytesLimit,1,2097152)};}
const samePin=(a,b)=>Object.keys(a).every(key=>a[key]===b[key]);
function providerEvidence(raw,policy,now){
 shape(raw,['ready','runtimeVersion','issues','checkedAt','toolPolicy']);if(typeof raw.ready!=='boolean'||!Array.isArray(raw.issues)||raw.issues.length>32||raw.issues.some(issue=>!ISSUES.has(issue)))bad('probe_failed');
 const checkedAt=stamp(raw.checkedAt),time=Date.parse(stamp(now()));if(Date.parse(checkedAt)>time||time-Date.parse(checkedAt)>300000)bad('probe_stale');
 if(raw.runtimeVersion!==policy.pin.runtimeVersion)bad('runtime_identity_mismatch');if(raw.toolPolicy!==policy.pin.toolPolicy)bad('tool_policy_mismatch');
 return {ready:raw.ready&&raw.issues.length===0,runtimeVersion:raw.runtimeVersion,issues:[...raw.issues],checkedAt,toolPolicy:raw.toolPolicy};
}
function request(raw,policy){
 shape(raw,['config','workspace','prompt','requestedModel','effort','mode','timeoutMs','outputBytesLimit','signal']);const config=providerConfig(raw.config);
 if(config.provider!==policy.provider)bad('provider_identity_mismatch');if(config.executable!==policy.executable||raw.workspace!==policy.workspace)bad('invalid_request');localPath(raw.workspace);
 if(typeof raw.prompt!=='string'||Buffer.byteLength(raw.prompt,'utf8')>32768)bad('invalid_request');
 const selected=policy.models.find(model=>model.id===raw.requestedModel);if(!selected)bad('model_unavailable');if(!selected.efforts.includes(raw.effort))bad('effort_unavailable');if(raw.mode!==policy.mode)bad('policy_blocked');
 integer(raw.timeoutMs,30000,600000);integer(raw.outputBytesLimit,1,2097152);if(raw.timeoutMs>policy.timeoutMs||raw.outputBytesLimit>policy.outputBytesLimit)bad('policy_blocked');
 if(!(raw.signal instanceof AbortSignal))bad('invalid_request');if(raw.signal.aborted)bad('request_cancelled');
 return {...raw,config};
}
function result(raw,selected,policy){
 shape(raw,['status','finalText','stdout','stderr','observedModel','observedModels','completed','exitCode','terminationUnconfirmed','usage','error']);
 if(!['completed','failed','timed_out','cancelled','blocked','rate_limited'].includes(raw.status)||typeof raw.completed!=='boolean'||typeof raw.terminationUnconfirmed!=='boolean'||!['finalText','stdout','stderr'].every(key=>typeof raw[key]==='string')||raw.exitCode!==null&&!Number.isSafeInteger(raw.exitCode)||!Array.isArray(raw.observedModels)||raw.observedModels.length>32||raw.observedModel!==null&&typeof raw.observedModel!=='string')bad('invalid_runtime_result');
 const outputBytes=['finalText','stdout','stderr'].reduce((sum,key)=>sum+Buffer.byteLength(raw[key],'utf8'),0);if(outputBytes>selected.outputBytesLimit)bad('output_limit');
 const observedModels=raw.observedModels.map(value=>name(value)),observedModel=raw.observedModel===null?null:name(raw.observedModel);if(new Set(observedModels).size!==observedModels.length)bad('invalid_runtime_result');
 if(observedModel!==null&&observedModel!==selected.requestedModel||observedModels.some(value=>value!==selected.requestedModel))return blocked('model_identity_mismatch',{observedModel,observedModels,exitCode:raw.exitCode,terminationUnconfirmed:raw.terminationUnconfirmed});
 if(raw.terminationUnconfirmed)return blocked('termination_unconfirmed',{observedModel,observedModels,exitCode:raw.exitCode,terminationUnconfirmed:true});
 if(raw.status==='completed'&&(!raw.completed||raw.exitCode!==0))return blocked('terminal_protocol_unverified',{observedModel,observedModels,exitCode:raw.exitCode});
 if(raw.status!=='completed'&&raw.completed)bad('invalid_runtime_result');
 if(raw.status==='completed'&&observedModel===null&&!policy.allowUnverifiedModel)return blocked('model_identity_unverified',{observedModel,observedModels,exitCode:raw.exitCode});
 let usage=null;if(raw.usage!==null){if(!raw.usage||Object.getPrototypeOf(raw.usage)!==Object.prototype||Object.keys(raw.usage).length>32||Object.entries(raw.usage).some(([key,value])=>!/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(key)||['__proto__','constructor','prototype'].includes(key)||/secret|token_value|password|credential|auth/iu.test(key)||typeof value!=='number'||!Number.isFinite(value)||value<0||value>Number.MAX_SAFE_INTEGER))bad('invalid_runtime_result');usage={...raw.usage};}
 if(raw.error!==null&&typeof raw.error!=='string')bad('invalid_runtime_result');
 if(raw.status==='completed'&&raw.error!==null)return blocked(ISSUES.has(raw.error)?raw.error:'runtime_failed',{observedModel,observedModels,exitCode:raw.exitCode});
 return {status:raw.status,finalText:raw.finalText,stdout:raw.stdout,stderr:raw.stderr,observedModel,observedModels,completed:raw.completed,exitCode:raw.exitCode,terminationUnconfirmed:false,usage,error:raw.error===null?null:ISSUES.has(raw.error)?raw.error:'runtime_failed'};
}
/** Explicit in-memory TEST ONLY dependency constructor. It cannot be selected by
 * production JSON/config/name; createSubscriptionRuntime never reads this object.
 * Fake results prove wrapper contracts, not package/CLI/model/Windows execution. */
export function createTestRuntimeHarness(options){
 shape(options,['adapter','identity','policy','now']);shape(options.adapter,['probe','execute']);if(typeof options.adapter.probe!=='function'||typeof options.adapter.execute!=='function'||typeof options.now!=='function')bad('invalid_configuration');
 const identity=pin(options.identity),policy=testPolicy(options.policy),now=options.now;
 const preflight=config=>{if(!policy.enabled)bad('disabled');if(!samePin(identity,policy.pin))bad('pin_identity_mismatch');const parsed=providerConfig(config);if(parsed.provider!==policy.provider)bad('provider_identity_mismatch');if(parsed.executable!==policy.executable)bad('invalid_configuration');return parsed;};
 const probeLocalExecution=async config=>{try{const parsed=preflight(config);return providerEvidence(await options.adapter.probe(parsed),policy,now);}catch(error){return unavailableProbe(now,error instanceof RuntimeBoundaryError?error.code:'probe_failed');}};
 const execute=async raw=>{try{preflight(raw?.config);const selected=request(raw,policy),evidence=await probeLocalExecution(selected.config);if(!evidence.ready)return blocked(evidence.issues[0]??'probe_failed');if(selected.signal.aborted)return blocked('request_cancelled');return result(await options.adapter.execute(selected),selected,policy);}catch(error){return blocked(error instanceof RuntimeBoundaryError?error.code:'runtime_failed');}};
 return Object.freeze({testOnly:true,installation:Object.freeze({status:'synthetic-test-only',enabled:policy.enabled,...identity}),probeLocalExecution,probe:probeLocalExecution,execute});
}

/** Derived from independently authenticated package bytes and fixed local semantics.
 * This digest is evidence of reviewed policy identity, not a provider/live probe. */
export async function deriveInstalledToolPolicyEvidence(installation,{provider,platform}={}){
 await loadInstalledRuntimeAdapter(installation);
 if(!['codex','claude'].includes(provider)||!['win32','linux','darwin'].includes(platform))bad('invalid_configuration');
 const descriptor=Object.freeze({schemaVersion:1,runtimeVersion:installation.runtimeVersion,sourceCommit:installation.sourceCommit,packageSha256:installation.tarballSha256,toolPolicyVersion:installation.toolPolicy,provider,platform,providerToolPolicy:provider==='claude'?'restricted-file-tools':platform==='win32'?'native-sandbox-windows-unelevated':'native-sandbox'});
 return Object.freeze({descriptor,sha256:createHash('sha256').update(canonical(descriptor)).digest('hex')});
}
/** Explicit trusted local composition. Installation, native process ownership,
 * and independent policy pins are separate prerequisites; JSON cannot mint them. */
export async function createInstalledSubscriptionRuntime(options){
 shape(options,['installation','owner','policy','providerConfiguration','executableEvidence','now']);
 if(typeof options.now!=='function')bad('invalid_configuration');
 const now=options.now,owner=options.owner,policy=parseExecutionPolicy(options.policy),config=providerConfig(options.providerConfiguration);
 assertWindowsOwnedProcessSupervisor(owner);
 const adapter=await loadInstalledRuntimeAdapter(options.installation),installed=options.installation;
 if(!policy.enabled)bad('disabled');if(policy.provider!==config.provider)bad('provider_identity_mismatch');
 if(!policy.subscriptionOnly)bad('subscription_required');if(!policy.extraUsageOffAttested)bad('extra_usage_attestation_required');
 const identity=policy.runtime;if(!identity||identity.version!==installed.runtimeVersion||identity.sourceCommit!==installed.sourceCommit||identity.packageSha256!==installed.tarballSha256||identity.toolPolicy!==installed.toolPolicy)bad('pin_identity_mismatch');
 shape(options.executableEvidence,['sha256','version']);
 const evidence={sha256:digest(options.executableEvidence.sha256),version:options.executableEvidence.version};
 if(evidence.sha256!==identity.executableSha256||evidence.version!==identity.executableVersion)bad('pin_identity_mismatch');
 const toolEvidence=await deriveInstalledToolPolicyEvidence(installed,{provider:config.provider,platform:process.platform});if(identity.toolPolicySha256!==toolEvidence.sha256)bad('tool_policy_mismatch');
 const allowUnverifiedModel=policy.modelIdentityPolicy==='allow-unverified';
 async function verifyExecutable(){
  const path=config.executable,stat=await lstat(path);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>128*1024*1024||await realpath(path)!==path)bad('provider_identity_mismatch');
  const file=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try{const opened=await file.stat();if(opened.ino!==stat.ino||opened.dev!==stat.dev||opened.nlink!==1||opened.size!==stat.size)bad('provider_identity_mismatch');
   const hash=createHash('sha256'),buffer=Buffer.alloc(65536);let length=0;for(;;){const {bytesRead}=await file.read(buffer,0,buffer.length,null);if(!bytesRead)break;length+=bytesRead;if(length>128*1024*1024)bad('provider_identity_mismatch');hash.update(buffer.subarray(0,bytesRead));}if(hash.digest('hex')!==evidence.sha256)bad('provider_identity_mismatch');
  }finally{await file.close();}
 }
 await verifyExecutable();
 function selectedRequest(raw){
  shape(raw,['config','workspace','prompt','requestedModel','effort','mode','timeoutMs','outputBytesLimit','signal','allowUnverifiedModel']);
  const parsed=providerConfig(raw.config);if(Object.keys(config).some(key=>config[key]!==parsed[key]))bad('provider_identity_mismatch');
  localPath(raw.workspace);if(typeof raw.prompt!=='string'||!raw.prompt||Buffer.byteLength(raw.prompt)>32768)bad('invalid_request');
  const model=policy.models.find(item=>item.id===raw.requestedModel);if(!model)bad('model_unavailable');if(!model.efforts.includes(raw.effort))bad('effort_unavailable');
  const operation=raw.mode==='response'?'project.inspect':raw.mode==='edit'?'project.propose-patch':null;
  if(!policy.operations.includes(operation)||raw.allowUnverifiedModel!==allowUnverifiedModel)bad('policy_blocked');
  integer(raw.timeoutMs,30000,policy.maxTimeoutSeconds*1000);integer(raw.outputBytesLimit,1,policy.maxOutputBytesLimit);
  if(!(raw.signal instanceof AbortSignal))bad('invalid_request');if(raw.signal.aborted)bad('request_cancelled');
  return {...raw,config:{...config},allowUnverifiedModel};
 }
 const expectedProviderTools=config.provider==='claude'?'restricted-file-tools':process.platform==='win32'?'native-sandbox-windows-unelevated':'native-sandbox';
 async function probeLocalExecution(rawConfig){try{
  const parsed=providerConfig(rawConfig);if(Object.keys(config).some(key=>parsed[key]!==config[key]))bad('provider_identity_mismatch');
  await loadInstalledRuntimeAdapter(installed);await verifyExecutable();
  const raw=await adapter.probe({...config});shape(raw,['ready','runtimeVersion','issues','checkedAt','toolPolicy']);
  if(typeof raw.ready!=='boolean'||!Array.isArray(raw.issues)||raw.issues.length>32)bad('probe_failed');
  const checkedAt=stamp(raw.checkedAt),time=Date.parse(stamp(now()));if(Date.parse(checkedAt)>time||time-Date.parse(checkedAt)>300000)bad('probe_stale');
  if(raw.runtimeVersion!==evidence.version)bad('provider_identity_mismatch');if(raw.toolPolicy!==expectedProviderTools)bad('tool_policy_mismatch');
  await verifyExecutable();return {ready:raw.ready&&raw.issues.length===0,runtimeVersion:installed.runtimeVersion,issues:raw.ready&&raw.issues.length===0?[]:['probe_failed'],checkedAt,toolPolicy:installed.toolPolicy};
 }catch(error){return unavailableProbe(now,error instanceof RuntimeBoundaryError?error.code:'probe_failed');}}
 async function executeOwned(raw,ownership){let nativeResult=null,started=false,launched=false;try{
  shape(ownership,['onStarted']);if(typeof ownership.onStarted!=='function')bad('invalid_request');
  const selected=selectedRequest(raw);assertWindowsOwnedProcessSupervisor(owner);const readiness=await probeLocalExecution(selected.config);if(!readiness.ready)bad(readiness.issues[0]??'probe_failed');if(selected.signal.aborted)bad('request_cancelled');await loadInstalledRuntimeAdapter(installed);await verifyExecutable();
  const owned={async run(nativeRequest){if(launched)bad('policy_blocked');launched=true;
   if(nativeRequest.executable!==config.executable||nativeRequest.cwd!==selected.workspace||nativeRequest.timeoutMs>selected.timeoutMs||nativeRequest.outputBytesLimit>selected.outputBytesLimit)bad('policy_blocked');
   nativeResult=await owner.run(nativeRequest);return nativeResult;
  }};
  const output=await adapter.executeOwned(selected,{owner:owned,onStarted:async value=>{await ownership.onStarted(value);started=true;}});
  if(!output||Object.getPrototypeOf(output)!==Object.prototype||Object.keys(output).some(key=>!['status','finalText','stdout','stderr','observedModel','observedModels','completed','exitCode','terminationUnconfirmed','usage','error','events','runtimeBlock','processExitConfirmed'].includes(key)))bad('invalid_runtime_result');
  const normalized=Object.fromEntries(['status','finalText','stdout','stderr','observedModel','observedModels','completed','exitCode','terminationUnconfirmed','usage','error'].map(key=>[key,output[key]]));
  if(!launched)return {...blocked('runtime_failed'),processExitConfirmed:false};
  const confirmed=started&&nativeResult?.processExitConfirmed===true&&nativeResult?.terminationUnconfirmed===false;
  if(output.processExitConfirmed!==confirmed||output.exitCode!==nativeResult?.exitCode||!confirmed)return {...blocked('termination_unconfirmed',{terminationUnconfirmed:launched}),processExitConfirmed:false};
  const checked=result(normalized,selected,{allowUnverifiedModel});return {...checked,processExitConfirmed:confirmed};
 }catch(error){return {...blocked(error instanceof RuntimeBoundaryError?error.code:'runtime_failed',{terminationUnconfirmed:launched&&nativeResult?.processExitConfirmed!==true}),processExitConfirmed:started&&nativeResult?.processExitConfirmed===true&&nativeResult?.terminationUnconfirmed===false};}}
 return Object.freeze({identity:Object.freeze({...identity}),installation:Object.freeze({...installed,enabled:true,provider:config.provider}),probeLocalExecution,probe:probeLocalExecution,executeOwned});
}
