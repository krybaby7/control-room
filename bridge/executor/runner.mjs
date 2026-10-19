import {isAbsolute} from 'node:path';
import {canonical,shape,fail,sha} from './codec.mjs';
import {recoveryDisposition} from './lease.mjs';
import {validateInspectionReport} from './operations.mjs';

/** Local dependency seam, never selected by JSON or the disabled production CLI.
 * executeOwned must create a suspended owned process, await onStarted's durable
 * receipt before resuming, and confirm the whole owned tree exited. The ordinary
 * subscription execute interface cannot provide that ownership guarantee. */
export function createBoundedAttemptRunner({lease,journal,workspaceManager,runtime,artifacts,config,monotonic=()=>performance.now(),now=()=>new Date().toISOString(),transport=null}){
 shape(config,['enabled','provider','executable','subscriptionOnly','extraUsageOffAttested']);
 if(config.enabled!==true||config.subscriptionOnly!==true||config.extraUsageOffAttested!==true||config.provider!==lease.binding.provider)fail('local_execution_disabled');
 if(typeof config.executable!=='string'||!isAbsolute(config.executable)||/[\r\n\0]/u.test(config.executable))fail('invalid_local_executable');
 if(typeof runtime?.executeOwned!=='function'||canonical(runtime.identity)!==canonical(lease.binding.runtime))fail('owned_runtime_unavailable');
 if(canonical(journal.snapshot().identity)!==canonical(lease.identity))fail('journal_lease_identity_differs');
 let active=false;
 const phase=async(phase,workspaceKey=null,processIdentity=null)=>journal.append({kind:'phase',value:{phase,workspaceKey,processIdentity,nextEventSequence:journal.snapshot().nextEventSequence}});
 const event=async(kind,details,diagnostic='ok')=>journal.append({kind:'event',value:{schemaVersion:1,attemptId:lease.identity.attemptId,epoch:lease.identity.epoch,sequence:journal.snapshot().nextEventSequence,kind,observedAt:now(),diagnostic,details}});
 return Object.freeze({
  async run({signal=new AbortController().signal}={}){
   if(active)fail('executor_slot_unavailable');active=true;
   let timer,renewing=false,renewal=null,started=false,identity=null,workspace=null,launchIntent=false;
   const controller=new AbortController(),abort=()=>controller.abort();
   try{
    if(!(signal instanceof AbortSignal))fail('invalid_abort_signal');
    const prior=journal.snapshot();
    if(prior.phase!=='claimed')return recoveryDisposition(prior);
    if(!lease.mayLaunch)fail('launch_not_admissible');
    const prompt=canonical({operation:lease.spec.operation,task:lease.taskInput});if(Buffer.byteLength(prompt)>32768)fail('input_limit');
    lease.assertCurrent(monotonic());if(signal.aborted)fail('cancel_requested');
    signal.addEventListener('abort',abort,{once:true});
    workspace=await workspaceManager.prepare({workspaceKey:'attempt-'+sha(lease.identity).slice(0,32),baseCommit:lease.spec.baseCommit});
    await phase('workspace_ready',workspace.workspaceKey);
    await workspace.verify();lease.assertCurrent(monotonic());if(controller.signal.aborted)fail('cancel_requested');
    await phase('launch_intent',workspace.workspaceKey);launchIntent=true;
    lease.consumeLaunch(monotonic());
    // An ambiguous renewal revokes permission immediately. Abort asks only the
    // owned runtime to stop; it never manufactures an exit or cancellation ack.
    timer=setInterval(()=>{if(renewing)return;try{lease.assertCurrent(monotonic());if(lease.needsRenew(monotonic())){if(!transport){controller.abort();return;}renewing=true;renewal=Promise.resolve(lease.renew(transport)).then(()=>{if(lease.snapshot?.().cancelRequest)controller.abort();}).catch(()=>controller.abort()).finally(()=>{renewing=false;});}}catch{controller.abort();}},100);
    const output=await runtime.executeOwned({config:{provider:config.provider,executable:config.executable,subscriptionOnly:true,extraUsageOffAttested:true},workspace:workspace.root,prompt,requestedModel:lease.spec.requestedModel,effort:lease.spec.effort,mode:lease.spec.operation==='project.inspect'?'response':'edit',timeoutMs:lease.spec.timeoutSeconds*1000,outputBytesLimit:lease.spec.outputBytesLimit,signal:controller.signal,allowUnverifiedModel:lease.binding.modelIdentityPolicy==='allow-unverified'},{async onStarted(ownedIdentity){
     if(started)fail('duplicate_owned_start');identity=structuredClone(ownedIdentity);await phase('process_started',workspace.workspaceKey,identity);started=true;
     await event('started',{runtimePackageSha256:lease.binding.runtime.packageSha256,toolPolicySha256:lease.binding.runtime.toolPolicySha256,requestedModel:lease.spec.requestedModel,observedModel:null});
     lease.assertCurrent(monotonic());if(controller.signal.aborted)fail('cancel_requested');
    }});
    clearInterval(timer);timer=null;await renewal;
    if(!started||output.terminationUnconfirmed!==false||output.processExitConfirmed!==true){await phase('reconcile_required',workspace.workspaceKey,identity);return {mode:'reconcile_required',mayLaunch:false,mayClaimCancellation:false};}
    await phase('process_exited',workspace.workspaceKey,identity);
    const matched=output.observedModel===lease.spec.requestedModel&&Array.isArray(output.observedModels)&&output.observedModels.length===1&&output.observedModels[0]===lease.spec.requestedModel;
    await event('model_observed',{requestedModel:lease.spec.requestedModel,observedModel:output.observedModel??null,observedModels:output.observedModels,modelVerified:matched});
    await event('process_exit',{exitCode:Number.isSafeInteger(output.exitCode)&&output.exitCode>=-255&&output.exitCode<=255?output.exitCode:null,processExitConfirmed:true,terminationUnconfirmed:false});
    const cancellation=lease.snapshot?.().cancelRequest??null;
    if(cancellation)await event('cancel_acknowledged',{requestId:cancellation.requestId,exitConfirmed:true},'cancel_requested');
    const mismatch=output.observedModel!==null&&output.observedModel!==lease.spec.requestedModel||!Array.isArray(output.observedModels)||output.observedModels.some(value=>value!==lease.spec.requestedModel);
    let current=true;try{lease.assertCurrent(monotonic());}catch{current=false;}
    const outputBound=['finalText','stdout','stderr'].every(key=>typeof output[key]==='string')&&['finalText','stdout','stderr'].reduce((sum,key)=>sum+Buffer.byteLength(output[key]),0)<=lease.spec.outputBytesLimit;
    let workspaceIntact=true;try{await workspace.verify();}catch{workspaceIntact=false;}
    let disposition='failed',diagnostic='unknown',artifactIds=[];
    if(!workspaceIntact){disposition='blocked';diagnostic='policy_blocked';}
    else if(!outputBound){disposition='blocked';diagnostic='artifact_invalid';}
    else if(mismatch){disposition='blocked';diagnostic='model_mismatch';}
    else if(cancellation){disposition='cancelled';diagnostic='cancel_requested';}
    // Native cancellation proves a local stop, not an authenticated owner request.
    // A cancelled server result additionally requires its exact request/ack proof.
    else if(output.status==='cancelled'){diagnostic='cancel_requested';}
    else if(current&&!controller.signal.aborted&&output.status==='completed'&&output.completed===true&&output.exitCode===0&&output.error===null&&(matched||lease.binding.modelIdentityPolicy==='allow-unverified')){
     try{
      if(typeof output.finalText!=='string'||Buffer.byteLength(output.finalText)>lease.spec.outputBytesLimit)fail('output_limit');
      let artifact;
      if(lease.spec.operation==='project.inspect')artifact=validateInspectionReport(JSON.parse(output.finalText),workspace,lease.spec.outputBytesLimit);
      else{const data=Buffer.from(output.finalText);await workspace.checkPatch(data,lease.spec.outputBytesLimit);artifact={filename:'proposal.diff',contentType:'text/x-diff',data};}
      const descriptor=await artifacts.put({id:'result-'+sha(lease.identity).slice(0,32),filename:artifact.filename,contentType:artifact.contentType,data:artifact.data});
      await journal.append({kind:'artifact',value:descriptor});artifactIds=[descriptor.id];await event('artifact_ready',{artifactId:descriptor.id,sha256:descriptor.sha256,bytes:descriptor.bytes,type:descriptor.contentType});disposition='succeeded';diagnostic='ok';
     }catch{disposition='blocked';diagnostic='artifact_invalid';}
    }else if(output.status==='timed_out')diagnostic='timeout';
    const result={attemptId:lease.identity.attemptId,epoch:lease.identity.epoch,disposition,requestedModel:lease.spec.requestedModel,observedModel:output.observedModel??null,modelVerified:matched,terminalProtocolObserved:output.completed===true,processExitConfirmed:true,terminationUnconfirmed:false,artifactIds,usage:null,diagnostic};
    await journal.append({kind:'result',value:result});return {mode:'upload_only',mayLaunch:false,mayClaimCancellation:false,result};
   }catch{
    const state=journal.snapshot();
    if(launchIntent&&['launch_intent','process_started','process_exited'].includes(state.phase))await phase('reconcile_required',workspace.workspaceKey,state.processIdentity);
    else if(['claimed','workspace_ready'].includes(state.phase))await phase('blocked',state.workspaceKey,null);
    return {mode:launchIntent?'reconcile_required':'owner_review_required',mayLaunch:false,mayClaimCancellation:false,diagnostic:'policy_blocked'};
   }finally{clearInterval(timer);signal?.removeEventListener?.('abort',abort);controller.abort();active=false;}
  }
 });
}
