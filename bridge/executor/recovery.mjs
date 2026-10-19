import {open,readdir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join} from 'node:path';
import {cloudOrigin} from '../src/transport.mjs';
import {verifyExecutionDirectory,inspectExecutionJournal} from './journal.mjs';
import {readPrivateLaunchJson} from './launch-config.mjs';
import {openArtifactUploadJournal} from './artifact-upload.mjs';
import {openExecutionArtifacts} from './artifacts.mjs';
import {finishUploadedAttempt} from './completion.mjs';
import {canonical,sha,shape,id,digest,integer,fail} from './codec.mjs';
function identity(raw){shape(raw,['jobId','attemptId','deviceId','epoch','specSha256']);id(raw.jobId);id(raw.attemptId);id(raw.deviceId);integer(raw.epoch);digest(raw.specSha256);return raw;}
function context(raw){shape(raw,['schemaVersion','identity','ownerContextHash','journalNonceSha256','cloudOrigin','sha256']);const {sha256,...body}=raw;if(raw.schemaVersion!==1||sha(body)!==sha256)fail('attempt_context_corrupt');identity(raw.identity);digest(raw.ownerContextHash);digest(raw.journalNonceSha256);if(cloudOrigin(raw.cloudOrigin)!==raw.cloudOrigin)fail('attempt_context_corrupt');return raw;}
/** Authenticated claim metadata only; never a persisted lease or launch grant. */
export async function persistAttemptContext({directory,identity:owner,ownerContextHash,journalNonce,baseUrl,verifyPrivateState}){
 identity(owner);digest(ownerContextHash);if(typeof journalNonce!=='string'||!/^[A-Za-z0-9_-]{32,128}$/u.test(journalNonce))fail('invalid_journal_nonce');await verifyExecutionDirectory(directory,{verifyPrivateState});
 const body={schemaVersion:1,identity:owner,ownerContextHash,journalNonceSha256:sha(journalNonce),cloudOrigin:cloudOrigin(baseUrl)},record={...body,sha256:sha(body)},path=join(directory,'attempt-context.json');let fd;
 try{fd=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),0o600);}catch(error){if(error.code!=='EEXIST')throw error;}
 if(fd){try{await fd.writeFile(canonical(record));await fd.sync();}finally{await fd.close();}if(process.platform!=='win32'){const parent=await open(directory,'r');try{await parent.sync();}finally{await parent.close();}}}
 const prior=context(await readPrivateLaunchJson(path,8192));if(canonical(prior)!==canonical(record))fail('attempt_context_immutable');return prior;
}
/** Called only under the existing exclusive executor store lock. Inventory comes
 * from retained budget reservations, never arbitrary caller-selected attempt files. */
export async function locateRetainedAttempt({attempts,reservations,claims,jobId,deviceId,baseUrl,verifyPrivateState}){
 id(jobId);id(deviceId);for(const directory of [attempts,reservations,claims])await verifyExecutionDirectory(directory,{verifyPrivateState});
 const names=await readdir(reservations);if(names.length>12)fail('local_budget_capacity');const candidates=[];
 for(const name of names){if(!/^[a-f0-9]{64}\.json$/u.test(name))fail('local_budget_corrupt');const reservation=await readPrivateLaunchJson(join(reservations,name),8192);shape(reservation,['schemaVersion','identity','timeoutSeconds']);const owner=identity(reservation.identity);integer(reservation.timeoutSeconds,30,600);if(reservation.schemaVersion!==1||sha(owner)+'.json'!==name)fail('local_budget_corrupt');if(owner.jobId===jobId){if(owner.deviceId!==deviceId)fail('retained_device_differs');candidates.push(owner);}}
 const inventory=await readdir(attempts);if(inventory.filter(name=>name!=='executor.lock').length>12||inventory.some(name=>name!=='executor.lock'&&!/^[a-f0-9]{64}$/u.test(name)))fail('unsafe_attempt_inventory');
 if(inventory.some(name=>name!=='executor.lock'&&!names.includes(name+'.json')))fail('unaccounted_local_attempt');
 if(candidates.length>1)fail('retained_attempt_ambiguous');if(!candidates.length){if(inventory.some(name=>name!=='executor.lock'&&!names.includes(name+'.json')))fail('unaccounted_local_attempt');return null;}
 const owner=candidates[0],directory=join(attempts,sha(owner));await verifyExecutionDirectory(directory,{verifyPrivateState});const snapshot=await inspectExecutionJournal({directory,identity:owner,verifyPrivateState});
 const claim=await readPrivateLaunchJson(join(claims,sha({jobId})+'.json'),2048);shape(claim,['schemaVersion','jobId','journalNonce']);if(claim.schemaVersion!==1||claim.jobId!==jobId||typeof claim.journalNonce!=='string'||!/^[a-f0-9]{64}$/u.test(claim.journalNonce))fail('retained_claim_differs');
 const binding=context(await readPrivateLaunchJson(join(directory,'attempt-context.json'),8192));if(canonical(binding.identity)!==canonical(owner)||binding.journalNonceSha256!==sha(claim.journalNonce)||binding.cloudOrigin!==cloudOrigin(baseUrl))fail('retained_context_differs');
 return {identity:owner,directory,snapshot,ownerContextHash:binding.ownerContextHash,journalNonce:claim.journalNonce};
}
/** Retained exited recovery has no runtime, installation, provider, capability,
 * workspace or process dependency. A nonce can report proof, never launch. */
export async function recoverRetainedAttempt({retained,store,transport,verifyPrivateState,now=()=>new Date().toISOString()}){
 const journal=await store.openAttempt(retained.identity);let mappings;
 try{
  const snapshot=journal.snapshot();if(!['process_exited','result_uploaded','acknowledged'].includes(snapshot.phase))return {status:'reconcile_required',diagnostic:'exit_unconfirmed',processStarted:snapshot.processIdentity!==null,processExitConfirmed:false,modelVerified:false};
  mappings=await openArtifactUploadJournal({directory:retained.directory,identity:retained.identity,ownerContextHash:retained.ownerContextHash,verifyPrivateState});
  const descriptors=snapshot.records.filter(row=>row.entry.kind==='artifact').map(row=>row.entry.value),mapped=mappings.snapshot(),artifacts=await openExecutionArtifacts({directory:join(retained.directory,'artifacts'),verifyPrivateState});
  for(const descriptor of descriptors){if(!mapped[descriptor.id]?.ready||canonical(mapped[descriptor.id].prepare.descriptor)!==canonical(descriptor))return {status:'upload_only',diagnostic:'artifact_upload_pending',processStarted:true,processExitConfirmed:true,modelVerified:false};await artifacts.read(descriptor.id,descriptor.sha256,descriptor.bytes);}
  const done=await finishUploadedAttempt({mode:'reconcile',journal,transport,identity:retained.identity,ownerContextHash:retained.ownerContextHash,journalNonce:retained.journalNonce,mapping:{journal:mappings,directory:retained.directory,verifyPrivateState},now});
  return {status:done.status,diagnostic:'ok',artifactCount:descriptors.length,processStarted:snapshot.processIdentity!==null,processExitConfirmed:true,modelVerified:done.result.modelVerified};
 }catch{return {status:'upload_only',diagnostic:'retained_state_requires_review',processStarted:journal.snapshot().processIdentity!==null,processExitConfirmed:['process_exited','result_uploaded','acknowledged'].includes(journal.snapshot().phase),modelVerified:false};}finally{await mappings?.close();await journal.close();}
}
