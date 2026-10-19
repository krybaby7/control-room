import {canonicalMkdtemp as mkdtemp,unitPrivateStateVerifier} from './fixtures/private-state.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {openExecutionJournal} from '../executor/journal.mjs';
import {openArtifactUploadJournal,uploadAttemptArtifacts} from '../executor/artifact-upload.mjs';
import {finishUploadedAttempt} from '../executor/completion.mjs';
import {sha,canonical} from '../executor/codec.mjs';
const ownerContextHash='9'.repeat(64);
const now=()=>new Date('2026-10-19T12:00:00.000Z').toISOString(),identity={jobId:'synthetic-job',attemptId:'synthetic-attempt',deviceId:'synthetic-device',epoch:1,specSha256:'a'.repeat(64)},credentials={attemptId:identity.attemptId,leaseToken:'b'.repeat(64)},remoteId='11111111-1111-4111-8111-111111111111';
async function fixture(){
 const directory=await mkdtemp(join(tmpdir(),'synthetic-completion-'));let journal=await openExecutionJournal({verifyPrivateState:unitPrivateStateVerifier,directory,identity}),maps=await openArtifactUploadJournal({verifyPrivateState:unitPrivateStateVerifier,directory,identity,ownerContextHash});
 const processIdentity={pid:999,startedAt:now(),supervisorId:'synthetic-supervisor',ownershipSha256:'c'.repeat(64)};
 for(const phase of ['claimed','workspace_ready','launch_intent','process_started','process_exited'])await journal.append({kind:'phase',value:{phase,workspaceKey:phase==='claimed'?null:'synthetic-workspace',processIdentity:['process_started','process_exited'].includes(phase)?processIdentity:null,nextEventSequence:1}});
 const event=async(kind,details)=>journal.append({kind:'event',value:{schemaVersion:1,attemptId:identity.attemptId,epoch:1,sequence:journal.snapshot().nextEventSequence,kind,observedAt:now(),diagnostic:'ok',details}});
 await event('accepted',{specSha256:identity.specSha256,capabilitySha256:'d'.repeat(64)});await event('started',{runtimePackageSha256:'e'.repeat(64),toolPolicySha256:'f'.repeat(64),requestedModel:'synthetic-model',observedModel:null});await event('process_exit',{exitCode:0,processExitConfirmed:true,terminationUnconfirmed:false});
 const data=Buffer.from('{"summary":"synthetic"}'),descriptor={id:'result-local',filename:'report.json',contentType:'application/json',bytes:data.length,sha256:createHash('sha256').update(data).digest('hex'),relativePath:'artifacts/result-local'};
 await journal.append({kind:'artifact',value:descriptor});await event('artifact_ready',{artifactId:descriptor.id,sha256:descriptor.sha256,bytes:descriptor.bytes,type:descriptor.contentType});
 const result={attemptId:identity.attemptId,epoch:1,disposition:'succeeded',requestedModel:'synthetic-model',observedModel:null,modelVerified:false,terminalProtocolObserved:true,processExitConfirmed:true,terminationUnconfirmed:false,artifactIds:[descriptor.id],usage:null,diagnostic:'ok'};await journal.append({kind:'result',value:result});
 let issued=0;const remote={id:remoteId,status:'reserved',filename:descriptor.filename,mimeType:'application/json',expectedBytes:data.length,declaredSha256:descriptor.sha256,logicalType:'summary'};
 const mutation=async()=>({mutationId:'m1_'+'1'.repeat(32)+'_'+String(++issued).padStart(32,'0'),revision:issued});
 const confirm=(action,p)=>{const command=action==='reserve'?{type:'jobs.artifact.reserve',value:{filename:p.filename,mimeType:p.mimeType,expectedBytes:p.expectedBytes},logicalType:p.logicalType,sha256:p.sha256}:{type:'jobs.artifact.finalize',id:p.id};return {status:'committed',receipt:{mutationId:p.mutationId,commandHash:sha({protocolVersion:1,command}),appliedRevision:p.revision+1},currentRevision:p.revision+1,artifact:{...remote,status:action==='reserve'?'reserved':'ready'}};};
 await uploadAttemptArtifacts({journal,artifacts:{read:async()=>data},mappings:maps,credentials,ownerContextHash,transport:{mutationId:mutation,reserve:async p=>confirm('reserve',p),stage:async()=>({status:'staged',id:remoteId,bytes:data.length,sha256:descriptor.sha256,finalized:false}),finalize:async p=>confirm('finalize',p)}});
 return {directory,get journal(){return journal;},get maps(){return maps;},result,async reopen(){await journal.close();await maps.close();journal=await openExecutionJournal({verifyPrivateState:unitPrivateStateVerifier,directory,identity});maps=await openArtifactUploadJournal({verifyPrivateState:unitPrivateStateVerifier,directory,identity,ownerContextHash});},async close(){await journal.close();await maps.close();await rm(directory,{recursive:true,force:true});}};
}
test('immutable projection survives lost mapped events/result replies and acknowledges original hashes only',async()=>{
 const f=await fixture();let eventLost=true,resultLost=true,eventCalls=0,resultCalls=0;const accepted=new Map();let resultBody;
 const lease={identity,async reportEvents(_transport,events){eventCalls++;const receipts=events.map(event=>{if(accepted.has(event.sequence))assert.equal(accepted.get(event.sequence),canonical(event));else accepted.set(event.sequence,canonical(event));return {attemptId:identity.attemptId,epoch:1,sequence:event.sequence,payloadSha256:sha(event),receivedAt:now()};});if(eventLost){eventLost=false;throw new Error('synthetic lost events');}return {receipts,lastAppliedSequence:events.at(-1).sequence};}};
 const transport={async complete(body){resultCalls++;if(resultBody)assert.equal(canonical(body),resultBody);resultBody=canonical(body);if(resultLost){resultLost=false;throw new Error('synthetic lost completion');}return {result:body.result,recordId:'result:'+identity.attemptId};}};
 const args=()=>({journal:f.journal,lease,transport,credentials,journalNonce:'x'.repeat(32),ownerContextHash,mapping:{journal:f.maps,directory:f.directory,verifyPrivateState:unitPrivateStateVerifier},now});
 try{
  await assert.rejects(finishUploadedAttempt(args()),/lost events/);assert.equal(f.journal.snapshot().phase,'process_exited');
  await f.reopen();
  await assert.rejects(finishUploadedAttempt(args()),/lost completion/);assert.equal(f.journal.snapshot().phase,'process_exited');
  await f.reopen();
  const done=await finishUploadedAttempt(args());assert.equal(done.status,'acknowledged');assert.deepEqual(done.result.artifactIds,[remoteId]);assert.equal(f.journal.snapshot().pending.length,0);assert.equal(f.journal.snapshot().phase,'acknowledged');
  assert.equal(eventCalls,2);assert.equal(resultCalls,2);await finishUploadedAttempt(args());assert.equal(resultCalls,2);
  const projection=JSON.parse(await readFile(join(f.directory,'outbound-projection.json'),'utf8'));
  const artifact=projection.events.find(row=>row.local.kind==='artifact_ready');assert.equal(artifact.local.details.artifactId,'result-local');assert.equal(artifact.remote.details.artifactId,remoteId);assert.notEqual(artifact.localSha256,artifact.remoteSha256);
  assert.equal(projection.events.at(-1).remote.details.resultSha256,sha(done.result));assert.equal(projection.result.localSha256,sha(f.result));assert.notEqual(projection.result.localSha256,projection.result.remoteSha256);
  assert.equal(projection.events.find(row=>row.local.kind==='started').remote.details.observedModel,null);
 }finally{await f.close();}
});
test('wrong mapped receipt never acknowledges original event or sends result',async()=>{
 const f=await fixture();let completed=false;const lease={identity,async reportEvents(_transport,events){return {receipts:events.map(event=>({attemptId:identity.attemptId,epoch:1,sequence:event.sequence,payloadSha256:'0'.repeat(64),receivedAt:now()})),lastAppliedSequence:events.at(-1).sequence};}};
 try{await assert.rejects(finishUploadedAttempt({journal:f.journal,lease,credentials,journalNonce:'x'.repeat(32),ownerContextHash,mapping:{journal:f.maps,directory:f.directory,verifyPrivateState:unitPrivateStateVerifier},now,transport:{complete:async()=>{completed=true;}}}),/completion_event_receipt_differs/);assert.equal(completed,false);assert.ok(f.journal.snapshot().pending.some(row=>row.entry.kind==='event'));}finally{await f.close();}
});
