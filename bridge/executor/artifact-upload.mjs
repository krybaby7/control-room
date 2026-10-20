import {open,unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {cloudOrigin,unavailablePrivateIngress} from '../src/transport.mjs';
import {verifyExecutionDirectory} from './journal.mjs';
import {canonical,sha,shape,id,digest,integer,fileKey,fail} from './codec.mjs';
const LIMIT=10*1024*1024,MAX_JOURNAL=2*1024*1024;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const mutation=value=>{if(typeof value!=='string'||!/^m1_[a-f0-9]{32}_[a-f0-9]{32}$/u.test(value))fail('invalid_artifact_mutation');return value;};
const uuid=value=>{if(typeof value!=='string'||!UUID.test(value))fail('invalid_remote_artifact');return value;};
function credentials(value){shape(value,['attemptId','leaseToken']);id(value.attemptId);digest(value.leaseToken);}
function identity(value){shape(value,['jobId','attemptId','deviceId','epoch','specSha256']);id(value.jobId);id(value.attemptId);id(value.deviceId);integer(value.epoch);digest(value.specSha256);return structuredClone(value);}
function metadata(value){shape(value,['id','filename','contentType','bytes','sha256','relativePath']);fileKey(value.id);fileKey(value.filename);integer(value.bytes,0,LIMIT);digest(value.sha256);if(value.relativePath!=='artifacts/'+value.id||!['text/plain','text/markdown','text/x-diff','application/json'].includes(value.contentType))fail('invalid_artifact_descriptor');return structuredClone(value);}
function reserveFor(descriptor){
 const logicalType=descriptor.contentType==='text/x-diff'?'patch':descriptor.contentType==='application/json'?'summary':'diagnostic';
 return {filename:descriptor.filename,mimeType:descriptor.contentType,expectedBytes:descriptor.bytes,logicalType,sha256:descriptor.sha256};
}
function physical(request){return {filename:request.mimeType==='text/x-diff'&&!request.filename.endsWith('.txt')?request.filename+'.txt':request.filename,mimeType:['text/x-diff','text/markdown'].includes(request.mimeType)?'text/plain':request.mimeType};}
function command(action,request){return action==='reserve'?{type:'jobs.artifact.reserve',value:{filename:request.filename,mimeType:request.mimeType,expectedBytes:request.expectedBytes},logicalType:request.logicalType,sha256:request.sha256}:{type:'jobs.artifact.finalize',id:request.id};}
function confirmation(action,request,raw){
 shape(raw,['status','receipt','currentRevision','artifact']);if(!['committed','replayed'].includes(raw.status))fail('artifact_receipt_unconfirmed');integer(raw.currentRevision,1);
 shape(raw.receipt,['mutationId','commandHash','appliedRevision']);if(raw.receipt.mutationId!==request.mutationId||raw.receipt.commandHash!==sha({protocolVersion:1,command:command(action,request)}))fail('artifact_receipt_differs');integer(raw.receipt.appliedRevision,1);if(raw.receipt.appliedRevision!==request.revision+1||raw.currentRevision<raw.receipt.appliedRevision)fail('artifact_revision_differs');
 const a=raw.artifact;shape(a,['id','status','filename','mimeType','expectedBytes','declaredSha256','logicalType']);uuid(a.id);if(!['reserved','ready'].includes(a.status)||action==='finalize'&&(a.id!==request.id||a.status!=='ready'))fail('artifact_not_ready');
 return {receipt:structuredClone(raw.receipt),artifact:structuredClone(a)};
}
/** Fixed private ingress only; request and full response share one finite deadline.
 * Ambiguous writes are returned to durable replay, never automatically retried. */
export function createArtifactUploadTransport({enabled=false,baseUrl,deviceCredential=null,ingressAdapter=unavailablePrivateIngress,fetchImpl=globalThis.fetch,requestMs=15000,now=()=>Date.now()}){
 const origin=cloudOrigin(baseUrl);integer(requestMs,1,15000);let stopped=false;
 async function send(action,payload,auth){
  if(enabled!==true)fail('local_execution_disabled');if(stopped)fail('agent_authentication_stopped');credentials(auth);
  if(typeof deviceCredential!=='string'||!deviceCredential||deviceCredential.length>4096||/[\r\n]/u.test(deviceCredential))fail('device_credential_unavailable');
  const path='/api/bridge/jobs/artifacts/'+(action==='content'?uuid(payload.id)+'/content':action),method=action==='content'?'PUT':'POST';
  const controller=new AbortController();let timer,response;
  const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('artifact_transport_uncertain'));},requestMs);});
  async function work(){
   let ingress;try{ingress=await ingressAdapter.getHeaders({url:origin+path,path,method,signal:controller.signal});}catch{fail('private_ingress_unavailable');}
   if(!ingress||!Number.isFinite(Date.parse(ingress.expiresAt))||Date.parse(ingress.expiresAt)<=now())fail('private_ingress_unavailable');const headers=new Headers(ingress.headers);if(![...headers.keys()].length)fail('private_ingress_unavailable');
   for(const key of headers.keys())if(/cookie|^x-control-room-|authenticated-user|owner-id|forwarded|^host$|content-length|content-type/iu.test(key))fail('unsafe_ingress_headers');
   headers.set('x-control-room-device',deviceCredential);let body;
   if(action==='content'){if(!(payload.bytes instanceof Uint8Array)||payload.bytes.length>LIMIT)fail('artifact_bound');headers.set('content-type',payload.mimeType);headers.set('x-control-room-attempt',auth.attemptId);headers.set('x-control-room-lease',auth.leaseToken);body=payload.bytes;}
   else{headers.set('content-type','application/json');body=canonical({...payload,...auth});if(Buffer.byteLength(body)>65536)fail('artifact_request_bound');}
   try{response=await fetchImpl(origin+path,{method,headers,body,signal:controller.signal,redirect:'error',credentials:'omit',cache:'no-store'});}catch{fail('artifact_transport_uncertain');}
   if(!response.ok){if([401,403].includes(response.status)){stopped=true;try{await ingressAdapter.invalidate?.();}catch{}fail('agent_authentication_stopped');}fail(response.status===409?'artifact_conflict':response.status>=500?'artifact_transport_uncertain':'artifact_request_rejected');}
   if(response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json'||!response.body)fail('invalid_artifact_response');
   const reader=response.body.getReader(),chunks=[];let size=0;const abort=()=>{reader.cancel().catch(()=>{});};controller.signal.addEventListener('abort',abort,{once:true});
   try{for(;;){const next=await reader.read();if(controller.signal.aborted)fail('artifact_transport_uncertain');if(next.done)break;size+=next.value.byteLength;if(size>65536)fail('artifact_response_bound');chunks.push(Buffer.from(next.value));}try{return JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{fail('invalid_artifact_response');}}finally{controller.signal.removeEventListener('abort',abort);reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{}}
  }
  try{return await Promise.race([work(),deadline]);}finally{clearTimeout(timer);controller.abort();if(response?.body&&!response.body.locked)response.body.cancel().catch(()=>{});}
 }
 return Object.freeze({mutationId:auth=>send('mutation-id',{},auth),reserve:(payload,auth)=>send('reserve',payload,auth),stage:(payload,auth)=>send('content',payload,auth),finalize:(payload,auth)=>send('finalize',payload,auth)});
}
function apply(state,entry){
 shape(entry,['localId','kind','value']);fileKey(entry.localId);if(!['prepare','reserved','staged','finalize','ready'].includes(entry.kind))fail('invalid_upload_entry');
 const prior=state.get(entry.localId)??{};if(Object.hasOwn(prior,entry.kind)){if(canonical(prior[entry.kind])!==canonical(entry.value))fail('immutable_upload_mapping');return;}
 const order=['prepare','reserved','staged','finalize','ready'],index=order.indexOf(entry.kind);if(index>0&&!prior[order[index-1]])fail('upload_mapping_order');
 const v=entry.value;
 if(entry.kind==='prepare'){shape(v,['descriptor','request']);metadata(v.descriptor);if(v.descriptor.id!==entry.localId)fail('artifact_identity_differs');const r=v.request;shape(r,['revision','mutationId','filename','mimeType','expectedBytes','logicalType','sha256']);integer(r.revision,1);mutation(r.mutationId);if(canonical({...reserveFor(v.descriptor),revision:r.revision,mutationId:r.mutationId})!==canonical(r))fail('artifact_identity_differs');}
 if(entry.kind==='reserved'||entry.kind==='ready'){
  shape(v,['receipt','artifact']);const request=entry.kind==='reserved'?prior.prepare.request:prior.finalize;
  const result=confirmation(entry.kind==='reserved'?'reserve':'finalize',request,{status:'committed',currentRevision:v.receipt?.appliedRevision,receipt:v.receipt,artifact:v.artifact});
  const expected={...prior.prepare.request,...physical(prior.prepare.request)},a=result.artifact;
  if(a.filename!==expected.filename||a.mimeType!==expected.mimeType||a.expectedBytes!==expected.expectedBytes||a.declaredSha256!==expected.sha256||a.logicalType!==expected.logicalType)fail('artifact_metadata_differs');
  if(entry.kind==='reserved'&&[...state.values()].some(item=>item.reserved?.artifact.id===a.id))fail('duplicate_remote_artifact');
 }
 if(entry.kind==='staged'){shape(v,['status','id','bytes','sha256','finalized']);if(v.status!=='staged'||v.finalized!==false||v.id!==prior.reserved.artifact.id||v.bytes!==prior.prepare.descriptor.bytes||v.sha256!==prior.prepare.descriptor.sha256)fail('artifact_stage_differs');}
 if(entry.kind==='finalize'){shape(v,['revision','mutationId','id']);integer(v.revision,1);mutation(v.mutationId);if(v.id!==prior.reserved.artifact.id)fail('artifact_identity_differs');}
 state.set(entry.localId,{...prior,[entry.kind]:structuredClone(v)});if(state.size>100)fail('artifact_capacity');
}
/** Separate schema, held alongside the attempt's existing exclusive journal.
 * No credential is persisted. Torn writes/locks require reconciliation. */
export async function openArtifactUploadJournal({directory,identity:rawIdentity,ownerContextHash,verifyPrivateState}){
 const owner=identity(rawIdentity);digest(ownerContextHash);await verifyExecutionDirectory(directory,{create:true,verifyPrivateState});const lockPath=join(directory,'artifact-upload.lock'),nonce=randomUUID();let lock,handle,closed=false,poisoned=false;
 try{
  lock=await open(lockPath,'wx',0o600);await lock.writeFile(nonce);await lock.sync();
  handle=await open(join(directory,'artifact-upload.ndjson'),constants.O_RDWR|constants.O_APPEND|constants.O_CREAT|(constants.O_NOFOLLOW??0),0o600);
  const stat=await handle.stat();if(!stat.isFile()||stat.size>MAX_JOURNAL||process.platform!=='win32'&&((stat.mode&0o077)!==0||stat.uid!==process.getuid()))fail('unsafe_upload_journal');
  const text=new TextDecoder('utf8',{fatal:true}).decode(await handle.readFile());if(text&&!text.endsWith('\n'))fail('upload_journal_truncated');let size=Buffer.byteLength(text),rows=[],state=new Map();
  for(const line of text.split('\n').filter(Boolean)){const row=JSON.parse(line);shape(row,['version','identity','ownerContextHash','sequence','previousSha256','entry','sha256']);const {sha256,...body}=row;if(row.version!==1||row.ownerContextHash!==ownerContextHash||canonical(row.identity)!==canonical(owner)||row.sequence!==rows.length+1||row.previousSha256!==(rows.at(-1)?.sha256??null)||sha(body)!==sha256)fail('upload_journal_corrupt');apply(state,row.entry);rows.push(row);if(rows.length>500)fail('upload_journal_capacity');}
  const syncDir=async()=>{if(process.platform!=='win32'){const fd=await open(directory,'r');try{await fd.sync();}finally{await fd.close();}}};await syncDir();let serial=Promise.resolve();
  const snapshot=()=>structuredClone(Object.fromEntries(state));
  async function append(entry){if(closed||poisoned)fail('upload_journal_closed');const next=structuredClone(state);apply(next,entry);if(canonical(Object.fromEntries(next))===canonical(Object.fromEntries(state)))return snapshot();const body={version:1,identity:owner,ownerContextHash,sequence:rows.length+1,previousSha256:rows.at(-1)?.sha256??null,entry},row={...body,sha256:sha(body)},line=canonical(row)+'\n';if(size+Buffer.byteLength(line)>MAX_JOURNAL||rows.length>=500)fail('upload_journal_capacity');try{await handle.writeFile(line);await handle.sync();}catch{poisoned=true;fail('upload_journal_write_uncertain');}size+=Buffer.byteLength(line);rows.push(row);state=next;return snapshot();}
  return Object.freeze({identity:structuredClone(owner),ownerContextHash,snapshot,append(entry){const result=serial.then(()=>append(entry));serial=result.catch(()=>{});return result;},async close(){await serial;if(closed)return;closed=true;await handle.close();await lock.close();const fd=await open(lockPath,constants.O_RDONLY|(constants.O_NOFOLLOW??0));let value;try{value=await fd.readFile('utf8');}finally{await fd.close();}if(value!==nonce)fail('upload_lock_identity_differs');await unlink(lockPath);await syncDir();}});
 }catch(error){await handle?.close().catch(()=>{});if(lock){await lock.close().catch(()=>{});await unlink(lockPath).catch(()=>{});}throw error;}
}
/** Uploads only the original local result's immutable artifacts. Does not complete
 * or accept a result; caller must map and acknowledge original events/result. */
export async function uploadAttemptArtifacts({journal,artifacts,mappings,transport,credentials:auth,ownerContextHash}){
 credentials(auth);digest(ownerContextHash);if(mappings.ownerContextHash!==ownerContextHash)fail('upload_owner_differs');const state=journal.snapshot();if(auth.attemptId!==state.identity.attemptId||canonical(mappings.identity)!==canonical(state.identity))fail('upload_attempt_differs');
 const entries=state.records.map(row=>row.entry),results=entries.filter(row=>row.kind==='result');if(results.length!==1)fail('local_result_required');const result=results[0].value;
 const descriptors=entries.filter(row=>row.kind==='artifact').map(row=>metadata(row.value));if(descriptors.length>100||descriptors.reduce((n,d)=>n+d.bytes,0)>LIMIT||result.artifactIds.length!==descriptors.length||result.artifactIds.some(local=>!descriptors.some(d=>d.id===local)))fail('local_result_artifacts_differ');
 const refs=[],byLocalId={};
 for(const d of descriptors){
  const data=await artifacts.read(d.id,d.sha256,d.bytes);if(!(data instanceof Uint8Array)||data.byteLength!==d.bytes||createHash('sha256').update(data).digest('hex')!==d.sha256)fail('artifact_identity_differs');
  let m=mappings.snapshot()[d.id];if(m&&canonical(m.prepare.descriptor)!==canonical(d))fail('artifact_identity_differs');
  const save=async(kind,value)=>{await mappings.append({localId:d.id,kind,value});m=mappings.snapshot()[d.id];};
  if(!m){const issued=await transport.mutationId(auth);shape(issued,['mutationId','revision']);mutation(issued.mutationId);integer(issued.revision,1);await save('prepare',{descriptor:d,request:{...reserveFor(d),...issued}});}
  if(!m.reserved)await save('reserved',confirmation('reserve',m.prepare.request,await transport.reserve(m.prepare.request,auth)));
  if(!m.staged)await save('staged',await transport.stage({id:m.reserved.artifact.id,mimeType:m.reserved.artifact.mimeType,bytes:data},auth));
  if(!m.finalize){const issued=await transport.mutationId(auth);shape(issued,['mutationId','revision']);mutation(issued.mutationId);integer(issued.revision,1);await save('finalize',{...issued,id:m.reserved.artifact.id});}
  if(!m.ready)await save('ready',confirmation('finalize',m.finalize,await transport.finalize(m.finalize,auth)));
  const ref={id:m.ready.artifact.id,sha256:d.sha256,bytes:d.bytes,type:m.ready.artifact.logicalType};refs.push(ref);byLocalId[d.id]=ref;
 }
 return Object.freeze({artifactRefs:refs,remoteIds:refs.map(ref=>ref.id),byLocalId});
}
