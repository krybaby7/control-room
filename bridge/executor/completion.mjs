import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join} from 'node:path';
import {verifyExecutionDirectory} from './journal.mjs';
import {canonical,sha,shape,stamp,integer,digest,fail} from './codec.mjs';
const MAX=2*1024*1024;
function original(snapshot){return snapshot.records.map(row=>row.entry).filter(row=>['event','artifact','result'].includes(row.kind));}
function project(snapshot,mapping,now,ownerContextHash){
 if(mapping.journal.ownerContextHash!==ownerContextHash)fail('completion_owner_differs');
 if(canonical(mapping.journal.identity)!==canonical(snapshot.identity))fail('completion_mapping_identity_differs');
 const entries=original(snapshot),results=entries.filter(row=>row.kind==='result');if(results.length!==1)fail('local_result_required');const localResult=results[0].value;
 if(localResult.attemptId!==snapshot.identity.attemptId||localResult.epoch!==snapshot.identity.epoch)fail('completion_result_identity_differs');
 const descriptors=entries.filter(row=>row.kind==='artifact').map(row=>row.value),maps=mapping.journal.snapshot(),refs={};
 if(localResult.artifactIds.length!==descriptors.length||new Set(localResult.artifactIds).size!==localResult.artifactIds.length)fail('completion_artifact_set_differs');
 for(const descriptor of descriptors){const m=maps[descriptor.id];if(!m?.ready||canonical(m.prepare.descriptor)!==canonical(descriptor)||!localResult.artifactIds.includes(descriptor.id))fail('completion_artifact_not_ready');refs[descriptor.id]=m.ready.artifact.id;}
 if(new Set(Object.values(refs)).size!==descriptors.length)fail('duplicate_remote_artifact');
 const result={...localResult,artifactIds:localResult.artifactIds.map(id=>{if(!refs[id])fail('completion_artifact_not_ready');return refs[id];})};
 const events=entries.filter(row=>row.kind==='event').map(row=>row.value),projected=[];
 if(events[0]?.kind!=='accepted'||events[0].sequence!==1||events[0].details.specSha256!==snapshot.identity.specSha256)fail('accepted_event_required');
 for(const event of events){
  if(event.sequence!==projected.length+1||event.attemptId!==snapshot.identity.attemptId||event.epoch!==snapshot.identity.epoch)fail('completion_event_identity_differs');
  let remote=structuredClone(event);
  if(event.kind==='artifact_ready'){
   const descriptor=descriptors.find(d=>d.id===event.details.artifactId);if(!descriptor||descriptor.sha256!==event.details.sha256||descriptor.bytes!==event.details.bytes||descriptor.contentType!==event.details.type)fail('completion_artifact_event_differs');remote.details.artifactId=refs[descriptor.id];
  }
  projected.push({local:event,localSha256:sha(event),remote,remoteSha256:sha(remote)});
 }
 let terminal=events.find(event=>['completed','blocked'].includes(event.kind));
 if(!terminal){terminal={schemaVersion:1,attemptId:snapshot.identity.attemptId,epoch:snapshot.identity.epoch,sequence:events.length+1,kind:result.terminalProtocolObserved?'completed':'blocked',observedAt:stamp(now()),diagnostic:result.diagnostic,details:result.terminalProtocolObserved?{resultSha256:sha(result)}:{reason:result.diagnostic}};projected.push({local:terminal,localSha256:sha(terminal),remote:terminal,remoteSha256:sha(terminal)});}
 const last=projected.at(-1)?.remote;if(last?.kind!==(result.terminalProtocolObserved?'completed':'blocked')||last.kind==='completed'&&last.details.resultSha256!==sha(result))fail('completion_terminal_differs');
 if(projected.length>1024||Buffer.byteLength(canonical(result))>16384)fail('completion_capacity');
 return {version:1,identity:snapshot.identity,ownerContextHash,events:projected,result:{local:localResult,localSha256:sha(localResult),remote:result,remoteSha256:sha(result)},artifacts:descriptors.map(descriptor=>({local:descriptor,localSha256:sha(descriptor),remoteId:refs[descriptor.id]}))};
}
async function projectionFile({directory,verifyPrivateState},create){
 await verifyExecutionDirectory(directory,{verifyPrivateState});const path=join(directory,'outbound-projection.json');let handle;
 try{handle=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),0o600);}catch(error){if(error.code!=='EEXIST')throw error;}
 if(handle){try{const body=create(),text=canonical({...body,sha256:sha(body)});if(Buffer.byteLength(text)>MAX)fail('completion_capacity');await handle.writeFile(text);await handle.sync();}finally{await handle.close();}if(process.platform!=='win32'){const dir=await open(directory,'r');try{await dir.sync();}finally{await dir.close();}}}
 const fd=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));try{const stat=await fd.stat();if(!stat.isFile()||stat.size>MAX||process.platform!=='win32'&&((stat.mode&0o077)!==0||stat.uid!==process.getuid()))fail('unsafe_completion_projection');const row=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(await fd.readFile()));shape(row,['version','identity','ownerContextHash','events','result','artifacts','sha256']);const {sha256,...body}=row;if(sha(body)!==sha256)fail('completion_projection_digest_differs');return body;}finally{await fd.close();}
}
function acked(snapshot,target,id){return snapshot.records.some(row=>row.entry.kind==='receipt'&&row.entry.value.target===target&&row.entry.value.id===id);}
/** Exact outbound aggregation is immutable, independently hashed and durable before
 * sends. An acknowledgement of mapped bytes can only receipt the pinned local bytes.
 * This records execution evidence; it never accepts a proposal or completes a task. */
export async function finishUploadedAttempt({journal,lease,transport,credentials,journalNonce,mapping,ownerContextHash,mode='complete',identity:recoveryIdentity=null,now=()=>new Date().toISOString()}){
 digest(ownerContextHash);
 if(!['complete','reconcile'].includes(mode))fail('invalid_completion_mode');
 const selectedIdentity=mode==='reconcile'?recoveryIdentity:lease?.identity;
 if(canonical(journal.snapshot().identity)!==canonical(selectedIdentity)||mode==='complete'&&credentials?.attemptId!==selectedIdentity.attemptId||typeof journalNonce!=='string'||!/^[A-Za-z0-9_-]{32,128}$/u.test(journalNonce))fail('completion_attempt_identity_differs');
 if(!['process_exited','result_uploaded','acknowledged'].includes(journal.snapshot().phase))fail('completion_exit_phase_required');
 const projection=await projectionFile(mapping,()=>project(journal.snapshot(),mapping,now,ownerContextHash));
 const fixedNow=()=>projection.events.at(-1).local.observedAt;
 const expected=project(journal.snapshot(),mapping,fixedNow,ownerContextHash);if(canonical(projection)!==canonical(expected))fail('immutable_completion_projection');
 const terminal=projection.events.at(-1).local;
 if(!journal.snapshot().records.some(row=>row.entry.kind==='event'&&row.entry.value.sequence===terminal.sequence))await journal.append({kind:'event',value:terminal});
 for(const artifact of projection.artifacts)if(!acked(journal.snapshot(),'artifact',artifact.local.id))await journal.append({kind:'receipt',value:{target:'artifact',id:artifact.local.id,sha256:artifact.localSha256,receivedAt:stamp(now())}});
 const pending=projection.events.filter(row=>!acked(journal.snapshot(),'event',String(row.local.sequence)));
 while(pending.length){
  const batch=[];for(const row of pending){if(batch.length>=50||Buffer.byteLength(canonical(mode==='reconcile'?{attemptId:selectedIdentity.attemptId,journalNonce,proof:'exited',events:[...batch,row].map(item=>item.remote)}:{...credentials,events:[...batch,row].map(item=>item.remote)}))>65536)break;batch.push(row);}if(!batch.length)fail('completion_event_bound');
  const reply=mode==='reconcile'?await transport.reconcile({attemptId:selectedIdentity.attemptId,journalNonce,proof:'exited',events:batch.map(row=>row.remote)}):await lease.reportEvents(transport,batch.map(row=>row.remote));shape(reply,['receipts','lastAppliedSequence']);integer(reply.lastAppliedSequence,batch.at(-1).remote.sequence,projection.events.length);
  if(!Array.isArray(reply.receipts)||reply.receipts.length!==batch.length)fail('completion_receipt_set_differs');const seen=new Set();
  for(const receipt of reply.receipts){shape(receipt,['attemptId','epoch','sequence','payloadSha256','receivedAt']);stamp(receipt.receivedAt);const row=batch.find(item=>item.remote.sequence===receipt.sequence);if(!row||seen.has(receipt.sequence)||receipt.attemptId!==projection.identity.attemptId||receipt.epoch!==projection.identity.epoch||receipt.payloadSha256!==row.remoteSha256)fail('completion_event_receipt_differs');seen.add(receipt.sequence);}
  for(const receipt of reply.receipts){const row=batch.find(item=>item.remote.sequence===receipt.sequence);await journal.append({kind:'receipt',value:{target:'event',id:String(row.local.sequence),sha256:row.localSha256,receivedAt:receipt.receivedAt}});}pending.splice(0,batch.length);
 }
 if(!acked(journal.snapshot(),'result',projection.identity.attemptId)){
  const reply=mode==='reconcile'?await transport.reconcile({attemptId:selectedIdentity.attemptId,journalNonce,proof:'exited',result:projection.result.remote}):await transport.complete({...credentials,result:projection.result.remote});shape(reply,['result','recordId']);if(reply.recordId!=='result:'+projection.identity.attemptId||canonical(reply.result)!==canonical(projection.result.remote))fail('completion_result_receipt_differs');
  await journal.append({kind:'receipt',value:{target:'result',id:projection.identity.attemptId,sha256:projection.result.localSha256,receivedAt:stamp(now())}});
 }
 let snapshot=journal.snapshot();if(snapshot.phase==='process_exited'){await journal.append({kind:'phase',value:{phase:'result_uploaded',workspaceKey:snapshot.workspaceKey,processIdentity:snapshot.processIdentity,nextEventSequence:snapshot.nextEventSequence}});snapshot=journal.snapshot();}
 if(snapshot.phase==='result_uploaded')await journal.append({kind:'phase',value:{phase:'acknowledged',workspaceKey:snapshot.workspaceKey,processIdentity:snapshot.processIdentity,nextEventSequence:snapshot.nextEventSequence}});
 if(journal.snapshot().pending.length)fail('completion_acknowledgement_incomplete');
 return {status:'acknowledged',mode:'acknowledged',mayLaunch:false,mayClaimCancellation:false,result:projection.result.remote};
}
