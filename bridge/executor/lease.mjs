import {parseJobSpec,jobSpecSha256,checkExecutionAdmission,parseCapability,parseExecutionPolicy} from '../src/execution-policy.mjs';
import {shape,id,digest,integer,choice,stamp,canonical,sha,fail,model,list} from './codec.mjs';
const runtimeKeys=['version','sourceCommit','packageSha256','toolPolicy','executableSha256','executableVersion','toolPolicySha256'];
export function parseExecutionBinding(raw){
 shape(raw,['schemaVersion','provider','requestedModel','effort','runtime','capabilitySha256','configurationSha256','allowedPathsSha256','artifactRefs','effects','budget','modelIdentityPolicy']);
 if(raw.schemaVersion!==1)fail('invalid_binding');choice(raw.provider,['codex','claude']);model(raw.requestedModel);choice(raw.effort,['low','medium','high','xhigh','max','ultra']);shape(raw.runtime,runtimeKeys);
 for(const key of ['packageSha256','executableSha256','toolPolicySha256'])digest(raw.runtime[key]);
 if(!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(raw.runtime.sourceCommit))fail('invalid_runtime_commit');
 for(const key of ['version','toolPolicy','executableVersion'])if(typeof raw.runtime[key]!=='string'||raw.runtime[key].length<1||raw.runtime[key].length>128||/[\u0000-\u001f\u007f]/u.test(raw.runtime[key]))fail('invalid_runtime_identity');
 for(const key of ['capabilitySha256','configurationSha256','allowedPathsSha256'])digest(raw[key]);
 list(raw.artifactRefs,value=>{shape(value,['id','sha256','bytes']);id(value.id);digest(value.sha256);integer(value.bytes,0,32768);},8);
 if(new Set(raw.artifactRefs.map(value=>value.id)).size!==raw.artifactRefs.length)fail('duplicate_artifact');
 list(raw.effects,value=>choice(value,['repository.read','report.write','isolated-worktree.write','patch.write']),4,2);
 if(new Set(raw.effects).size!==raw.effects.length)fail('duplicate_effect');
 shape(raw.budget,['jobs','timeoutSeconds','outputBytesLimit','inputBytesLimit','payment','costDollars']);if(raw.budget.jobs!==1||raw.budget.payment!=='subscription-only'||raw.budget.costDollars!==null)fail('invalid_budget');
 integer(raw.budget.timeoutSeconds,30,600);integer(raw.budget.outputBytesLimit,1,2097152);integer(raw.budget.inputBytesLimit,0,32768);
 if(raw.artifactRefs.reduce((sum,value)=>sum+value.bytes,0)>raw.budget.inputBytesLimit)fail('input_limit');
 choice(raw.modelIdentityPolicy,['require-observed','allow-unverified']);return JSON.parse(canonical(raw));
}
function parseLease(raw){
 shape(raw,['jobId','attemptId','epoch','deviceId','leaseToken','expiresAt','spec','specSha256','approvalId']);
 for(const key of ['jobId','attemptId','deviceId','approvalId'])id(raw[key]);integer(raw.epoch);
 if(typeof raw.leaseToken!=='string'||raw.leaseToken.length<32||raw.leaseToken.length>4096||/[\u0000-\u0020\u007f]/u.test(raw.leaseToken))fail('invalid_lease_token');
 stamp(raw.expiresAt);const spec=parseJobSpec(raw.spec);if(digest(raw.specSha256)!==jobSpecSha256(spec))fail('lease_spec_differs');return {...raw,spec};
}
function timing(lease,raw){
 shape(raw,['serverNow','sentMonotonicMs','receivedMonotonicMs']);stamp(raw.serverNow);
 const sent=raw.sentMonotonicMs,received=raw.receivedMonotonicMs;
 if(!Number.isFinite(sent)||!Number.isFinite(received)||sent<0||received<sent||received-sent>15000)fail('untrusted_lease_timing');
 const remaining=Date.parse(lease.expiresAt)-Date.parse(raw.serverNow);
 if(remaining<=0||remaining>60000||remaining<=received-sent)fail('lease_expired');
 return {received,deadline:received+remaining-(received-sent)};
}
/** This checks authenticated caller material; it does not authenticate JSON or issue a grant.
 * expectedBindingSha256 must come from the owner's independently retained approval, never the lease response. */
export function admitExecutionLease({lease:raw,envelope,expectedBindingSha256,admission,timing:clock}){
 const lease=parseLease(raw);shape(envelope,['approval','executionBinding','bindingSha256','reservationId','approverId']);id(envelope.reservationId);id(envelope.approverId);
 const binding=parseExecutionBinding(envelope.executionBinding),bindingHash=sha(binding);
 if(digest(envelope.bindingSha256)!==bindingHash||digest(expectedBindingSha256)!==bindingHash)fail('execution_binding_differs');
 const approval=envelope.approval,verdict=checkExecutionAdmission({...admission,approval});
 if(!verdict.allowed)fail('admission_blocked');
 if(canonical(parseJobSpec(admission.spec))!==canonical(lease.spec)||lease.jobId!==admission.context.jobId||lease.deviceId!==admission.context.deviceId||lease.epoch!==admission.context.executionEpoch||lease.approvalId!==approval.id)fail('lease_identity_differs');
 const spec=lease.spec,capability=parseCapability(admission.capability),policy=parseExecutionPolicy(admission.policy);
 if(binding.provider!==capability.provider||canonical(binding.runtime)!==canonical(capability.runtime)||binding.capabilitySha256!==approval.capabilitySha256||binding.configurationSha256!==approval.configurationSha256||binding.allowedPathsSha256!==capability.allowedPathsSha256ByRepositoryKey[spec.repositoryKey]||binding.requestedModel!==spec.requestedModel||binding.effort!==spec.effort||binding.modelIdentityPolicy!==policy.modelIdentityPolicy)fail('binding_policy_differs');
 const expectedEffects=spec.operation==='project.inspect'?['repository.read','report.write']:['repository.read','report.write','isolated-worktree.write','patch.write'];
 if(canonical(binding.effects)!==canonical(expectedEffects)||binding.budget.timeoutSeconds!==spec.timeoutSeconds||binding.budget.outputBytesLimit!==spec.outputBytesLimit)fail('binding_effects_differ');
 if(canonical(binding.artifactRefs.map(value=>value.id))!==canonical(spec.inputArtifactIds)||binding.artifactRefs.some(value=>!admission.context.artifacts.some(item=>item.id===value.id&&item.sha256===value.sha256&&item.bytes===value.bytes)))fail('binding_artifacts_differ');
 const initial=timing(lease,clock);let deadline=initial.deadline,last=initial.received,stop=null;
 const jobDeadline=initial.received+spec.timeoutSeconds*1000;
 function tick(now){if(!Number.isFinite(now)||now<last){stop='monotonic_clock_invalid';fail(stop);}last=now;if(stop)fail(stop);if(now>=Math.min(deadline,jobDeadline)){stop='lease_expired';fail(stop);}}
 return Object.freeze({
  identity:Object.freeze({jobId:lease.jobId,attemptId:lease.attemptId,deviceId:lease.deviceId,epoch:lease.epoch,specSha256:lease.specSha256}),
  binding:Object.freeze(binding),spec:Object.freeze(spec),
  assertCurrent:tick,
  remaining(now){tick(now);return Math.min(deadline,jobDeadline)-now;},
  renew(next,clock){tick(clock.receivedMonotonicMs);const parsed=parseLease(next);if(['jobId','attemptId','deviceId','epoch','specSha256','approvalId','leaseToken'].some(key=>parsed[key]!==lease[key])||canonical(parsed.spec)!==canonical(spec))fail('renewal_identity_differs');const measured=timing(parsed,clock);if(measured.received<last)fail('monotonic_clock_invalid');deadline=measured.deadline;last=measured.received;},
  requestStop(reason){choice(reason,['cancel_requested','revoked','shutdown']);stop=reason;},
  snapshot(){return {identity:this.identity,bindingSha256:bindingHash,deadlineMonotonicMs:Math.min(deadline,jobDeadline),stopReason:stop};}
 });
}
export function recoveryDisposition(snapshot){
 const phase=snapshot.phase;
 if(['launch_intent','process_started','reconcile_required'].includes(phase))return {mode:'reconcile_required',mayLaunch:false,mayClaimCancellation:false};
 if(['process_exited','result_uploaded'].includes(phase))return {mode:'upload_only',mayLaunch:false,mayClaimCancellation:false};
 if(phase==='acknowledged')return {mode:'complete',mayLaunch:false,mayClaimCancellation:false};
 return {mode:'owner_review_required',mayLaunch:false,mayClaimCancellation:false};
}
