import {canonicalMkdtemp as mkdtemp,unitPrivateStateVerifier} from './fixtures/private-state.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareDurableClaim} from '../executor/claims.mjs';
import {openExecutorStore} from '../executor/store.mjs';
import {persistAttemptContext,locateRetainedAttempt,recoverRetainedAttempt} from '../executor/recovery.mjs';
import {sha,canonical} from '../executor/codec.mjs';
const ownerContextHash='9'.repeat(64),identity={jobId:'synthetic-retained-job',attemptId:'synthetic-retained-attempt',deviceId:'synthetic-device',epoch:4,specSha256:'a'.repeat(64)},now=()=>new Date('2026-10-19T12:00:00Z').toISOString(),baseUrl='https://synthetic.invalid';
async function fixture({artifact=false,phase='process_exited'}={}){
 const directory=await mkdtemp(join(tmpdir(),'synthetic-executor-recovery-'));const attempts=join(directory,'attempts'),reservations=join(directory,'reservations'),claims=join(directory,'claims');for(const path of [attempts,reservations,claims])await mkdir(path,{mode:0o700});
 const store=await openExecutorStore({verifyPrivateState:unitPrivateStateVerifier,directory:attempts}),claim=await prepareDurableClaim({verifyPrivateState:unitPrivateStateVerifier,directory:claims,jobId:identity.jobId});
 const journal=await store.openAttempt(identity),attemptDirectory=join(attempts,sha(identity));await writeFile(join(reservations,sha(identity)+'.json'),canonical({schemaVersion:1,identity,timeoutSeconds:120}),{mode:0o600});
 await persistAttemptContext({verifyPrivateState:unitPrivateStateVerifier,directory:attemptDirectory,identity,ownerContextHash,journalNonce:claim.journalNonce,baseUrl});
 const processIdentity={pid:999,startedAt:now(),supervisorId:'synthetic-supervisor',ownershipSha256:'b'.repeat(64)};
 for(const value of ['claimed','workspace_ready','launch_intent','process_started','process_exited']){await journal.append({kind:'phase',value:{phase:value,workspaceKey:value==='claimed'?null:'synthetic-workspace',processIdentity:['process_started','process_exited'].includes(value)?processIdentity:null,nextEventSequence:1}});if(value===phase)break;}
 if(phase==='process_exited'){
  const event=async(kind,details)=>journal.append({kind:'event',value:{schemaVersion:1,attemptId:identity.attemptId,epoch:identity.epoch,sequence:journal.snapshot().nextEventSequence,kind,observedAt:now(),diagnostic:'unknown',details}});
  await event('accepted',{specSha256:identity.specSha256,capabilitySha256:'c'.repeat(64)});await event('started',{runtimePackageSha256:'d'.repeat(64),toolPolicySha256:'e'.repeat(64),requestedModel:'synthetic-model',observedModel:null});
  for(let i=0;i<53;i++)await event('progress',{stage:'executing',completedUnits:i,totalUnits:53});
  await event('process_exit',{exitCode:1,processExitConfirmed:true,terminationUnconfirmed:false});
  if(artifact)await journal.append({kind:'artifact',value:{id:'result-pending',filename:'pending.txt',contentType:'text/plain',bytes:1,sha256:'f'.repeat(64),relativePath:'artifacts/result-pending'}});
  await journal.append({kind:'result',value:{attemptId:identity.attemptId,epoch:identity.epoch,disposition:'failed',requestedModel:'synthetic-model',observedModel:null,modelVerified:false,terminalProtocolObserved:false,processExitConfirmed:true,terminationUnconfirmed:false,artifactIds:artifact?['result-pending']:[],usage:null,diagnostic:'unknown'}});
 }
 await journal.close();const locate=()=>locateRetainedAttempt({verifyPrivateState:unitPrivateStateVerifier,attempts,reservations,claims,jobId:identity.jobId,deviceId:identity.deviceId,baseUrl});
 return {directory,attemptDirectory,attempts,reservations,claims,claim,store,locate,async close(){await store.close();await rm(directory,{recursive:true,force:true});}};
}
test('retained exited nonce recovery batches >50 immutable events across reply loss without lease/provider/probe',async()=>{
 const f=await fixture();const accepted=new Map();let lost=true,resultLost=true,eventCalls=0,resultCalls=0;
 const transport={async reconcile(payload){assert.equal(payload.attemptId,identity.attemptId);assert.equal(payload.journalNonce,f.claim.journalNonce);assert.equal(payload.proof,'exited');assert.equal(Object.hasOwn(payload,'leaseToken'),false);
  if(payload.events){eventCalls++;assert.ok(payload.events.length<=50);const receipts=payload.events.map(event=>{if(accepted.has(event.sequence))assert.equal(accepted.get(event.sequence),canonical(event));else accepted.set(event.sequence,canonical(event));return {attemptId:identity.attemptId,epoch:identity.epoch,sequence:event.sequence,payloadSha256:sha(event),receivedAt:now()};});if(lost){lost=false;throw new Error('synthetic lost batch');}return {receipts,lastAppliedSequence:Math.max(...accepted.keys())};}
  resultCalls++;assert.equal(accepted.size,57);if(resultLost){resultLost=false;throw new Error('synthetic lost result');}return {result:payload.result,recordId:'result:'+identity.attemptId};
 },async claim(){throw new Error('must not claim');},async complete(){throw new Error('must not complete lease route');},async renew(){throw new Error('must not renew');}};
 try{
  const invoke=async()=>recoverRetainedAttempt({verifyPrivateState:unitPrivateStateVerifier,retained:await f.locate(),store:f.store,transport,now});
  assert.equal((await invoke()).status,'upload_only');assert.equal((await invoke()).status,'upload_only');assert.equal((await invoke()).status,'acknowledged');assert.equal(eventCalls,3);assert.equal(resultCalls,2);
  const retained=await f.locate();assert.equal(retained.snapshot.phase,'acknowledged');assert.equal(retained.snapshot.pending.length,0);
  const context=await readFile(join(f.attemptDirectory,'attempt-context.json'),'utf8');assert.equal(context.includes(f.claim.journalNonce),false);assert.equal(context.includes('leaseToken'),false);assert.equal(JSON.parse(context).ownerContextHash,ownerContextHash);
 }finally{await f.close();}
});
test('pending original artifact and unconfirmed process stay closed without reconciliation or provider work',async()=>{
 for(const options of [{artifact:true},{phase:'process_started'}]){const f=await fixture(options);let calls=0;try{const done=await recoverRetainedAttempt({verifyPrivateState:unitPrivateStateVerifier,retained:await f.locate(),store:f.store,transport:{reconcile:async()=>{calls++;}},now});assert.equal(done.status,options.artifact?'upload_only':'reconcile_required');assert.equal(calls,0);}finally{await f.close();}}
});
test('retained context refuses owner/origin/nonce changes and ambiguous same-job inventory',async()=>{
 const f=await fixture();try{
  await assert.rejects(persistAttemptContext({verifyPrivateState:unitPrivateStateVerifier,directory:f.attemptDirectory,identity,ownerContextHash:'8'.repeat(64),journalNonce:f.claim.journalNonce,baseUrl}),/attempt_context_immutable/);
  await assert.rejects(persistAttemptContext({verifyPrivateState:unitPrivateStateVerifier,directory:f.attemptDirectory,identity,ownerContextHash,journalNonce:'0'.repeat(64),baseUrl}),/attempt_context_immutable/);
  await assert.rejects(locateRetainedAttempt({verifyPrivateState:unitPrivateStateVerifier,attempts:f.attempts,reservations:f.reservations,claims:f.claims,jobId:identity.jobId,deviceId:identity.deviceId,baseUrl:'https://foreign.synthetic.invalid'}),/retained_context_differs/);
  const other={...identity,attemptId:'synthetic-ambiguous-attempt'};await writeFile(join(f.reservations,sha(other)+'.json'),canonical({schemaVersion:1,identity:other,timeoutSeconds:120}),{mode:0o600});await assert.rejects(f.locate(),/retained_attempt_ambiguous/);
 }finally{await f.close();}
});
