import {cloudOrigin,unavailablePrivateIngress} from '../src/transport.mjs';
import {canonical,fail,shape,id,integer,bool,freezeJson} from './codec.mjs';
import {parseAgentLease,bindAgentLease} from './wire.mjs';
const authenticatedGrants=new WeakMap(),authenticatedTransports=new WeakMap();
import {parseCapability} from '../src/execution-policy.mjs';
const PATHS=Object.freeze({capabilities:'/api/bridge/jobs/capabilities',claim:'/api/bridge/jobs/claim',renew:'/api/bridge/jobs/renew',events:'/api/bridge/jobs/events',complete:'/api/bridge/jobs/complete',reconcile:'/api/bridge/jobs/reconcile'});
async function json(response,signal,maxBytes){
 if(response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')fail('invalid_agent_response');
 if(!response.body)fail('invalid_agent_response');const declared=response.headers.get('content-length');if(declared!==null&&(!/^\d{1,12}$/u.test(declared)||Number(declared)>maxBytes))fail('agent_response_bound');
 const reader=response.body.getReader(),chunks=[];const abort=()=>{reader.cancel().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});let size=0;try{if(signal.aborted)fail('agent_transport_uncertain');for(;;){const part=await reader.read();if(part.done)break;if(!(part.value instanceof Uint8Array))fail('invalid_agent_response');size+=part.value.byteLength;if(size>maxBytes)fail('agent_response_bound');chunks.push(Buffer.from(part.value));}try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{fail('invalid_agent_response');}}finally{signal.removeEventListener('abort',abort);reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{}}
}
function credentials(value){shape(value,['attemptId','leaseToken']);id(value.attemptId);if(typeof value.leaseToken!=='string'||!/^[a-f0-9]{64}$/u.test(value.leaseToken))fail('invalid_lease_token');}
function request(action,raw){
 if(!raw||Object.getPrototypeOf(raw)!==Object.prototype)fail('invalid_agent_request');
 if(action==='claim'){shape(raw,['jobId','journalNonce']);id(raw.jobId);if(typeof raw.journalNonce!=='string'||!/^[A-Za-z0-9_-]{32,128}$/u.test(raw.journalNonce))fail('invalid_journal_nonce');}
 else if(action==='renew')credentials(raw);
 else if(action==='events'){shape(raw,['attemptId','leaseToken','events']);credentials({attemptId:raw.attemptId,leaseToken:raw.leaseToken});if(!Array.isArray(raw.events)||raw.events.length<1||raw.events.length>50)fail('invalid_event_batch');}
 else if(action==='complete'){shape(raw,['attemptId','leaseToken','result']);credentials({attemptId:raw.attemptId,leaseToken:raw.leaseToken});}
 else if(action==='reconcile'){const keys=['attemptId','journalNonce','proof'];if(Object.hasOwn(raw,'events'))keys.push('events');if(Object.hasOwn(raw,'result'))keys.push('result');shape(raw,keys);id(raw.attemptId);if(!/^[A-Za-z0-9_-]{32,128}$/u.test(raw.journalNonce)||!['no-launch','exited'].includes(raw.proof))fail('invalid_reconciliation');}
 else{shape(raw,['capability','expectedOperationalRevision']);parseCapability(raw.capability);if(raw.expectedOperationalRevision!==null)integer(raw.expectedOperationalRevision,1);}
 const body=canonical(raw);if(Buffer.byteLength(body)>65536)fail('agent_request_bound');return body;
}
/** Closed separate execution transport. Default-disabled and no browser/cookie or
 * telemetry credential fallback. No automatic retry hides an ambiguous claim. */
export function createAgentExecutionTransport({enabled=false,baseUrl,deviceCredential=null,ingressAdapter=unavailablePrivateIngress,fetchImpl=globalThis.fetch,now=()=>Date.now(),monotonic=()=>performance.now(),requestMs=15000}){
 const origin=cloudOrigin(baseUrl);let stopped=false;if(typeof enabled!=='boolean'||!Number.isSafeInteger(requestMs)||requestMs<1||requestMs>15000)fail('invalid_agent_transport');
 async function send(action,payload){
  if(!enabled)fail('local_execution_disabled');if(stopped)fail('agent_authentication_stopped');const body=request(action,payload);if(typeof deviceCredential!=='string'||!deviceCredential||deviceCredential.length>4096||/[\r\n]/u.test(deviceCredential))fail('device_credential_unavailable');
  const sentMonotonicMs=monotonic();if(!Number.isFinite(sentMonotonicMs)||sentMonotonicMs<0)fail('invalid_monotonic_clock');const controller=new AbortController();let timer,readerResponse;const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('agent_transport_uncertain'));},requestMs);});
  const operation=async()=>{
   let ingress;try{ingress=await ingressAdapter.getHeaders({url:origin+PATHS[action],path:PATHS[action],method:'POST',signal:controller.signal});}catch{fail('private_ingress_unavailable');}
   if(!ingress||!Number.isFinite(Date.parse(ingress.expiresAt))||Date.parse(ingress.expiresAt)<=now())fail('private_ingress_unavailable');const headers=new Headers(ingress.headers);if(![...headers.keys()].length)fail('private_ingress_unavailable');
   for(const key of headers.keys())if(key==='cookie'||key==='x-control-room-device'||key==='content-type'||/authenticated-user|owner-id|forwarded|^host$|content-length/iu.test(key))fail('unsafe_ingress_headers');headers.set('content-type','application/json');headers.set('x-control-room-device',deviceCredential);
   try{readerResponse=await fetchImpl(origin+PATHS[action],{method:'POST',headers,body,redirect:'error',credentials:'omit',cache:'no-store',signal:controller.signal});}catch{fail('agent_transport_uncertain');}
   if(!readerResponse.ok){if([401,403].includes(readerResponse.status)){stopped=true;fail('agent_authentication_stopped');}if(readerResponse.status===409)fail('agent_conflict');if(readerResponse.status===429)fail('agent_rate_limited');fail(readerResponse.status>=500?'agent_transport_uncertain':'agent_request_rejected');}
   const result=await json(readerResponse,controller.signal,action==='claim'||action==='renew'?524288:65536);
   if((action==='claim'||action==='renew')&&result!==null){const grant=freezeJson(parseAgentLease(result)),receivedMonotonicMs=monotonic();if(!Number.isFinite(receivedMonotonicMs)||receivedMonotonicMs<sentMonotonicMs)fail('invalid_monotonic_clock');authenticatedGrants.set(grant,{sentMonotonicMs,receivedMonotonicMs,origin,monotonic,bound:false});return grant;}return result;
  };
  try{return await Promise.race([operation(),timeout]);}finally{clearTimeout(timer);controller.abort();if(readerResponse?.body&&!readerResponse.body.locked)readerResponse.body.cancel().catch(()=>{});}
 }
 const transport=Object.freeze(Object.fromEntries(Object.keys(PATHS).map(action=>[action,payload=>send(action,payload)])));authenticatedTransports.set(transport,{origin});return transport;
}

/** Private in-memory provenance is minted only after this fixed TLS/private-ingress
 * transport parsed a successful response. JSON/config cannot mint the WeakMap entry.
 * Test fetch injection is explicit local code, never a production JSON option. */
export async function bindAuthenticatedAgentGrant(grant,{policy,capability,journal,readLocalState}){
 const proof=authenticatedGrants.get(grant);if(!proof||proof.bound)fail('authenticated_agent_grant_required');proof.bound=true;
 if(!journal||typeof journal.snapshot!=='function'||typeof journal.append!=='function'||typeof readLocalState!=='function')fail('protected_local_state_required');
 const local=await readLocalState();shape(local,['otherActiveAttempts','usedJobs','usedRuntimeSeconds','cancelRequested','localDisabled']);integer(local.otherActiveAttempts,0,12);integer(local.usedJobs,0,12);integer(local.usedRuntimeSeconds,0,7200);bool(local.cancelRequested);bool(local.localDisabled);
 const state=journal.snapshot(),spec=grant.record.spec,frozen=grant.frozenAdmission,ownerKey=frozen.ownerContextHash;
 if(state.identity.jobId!==grant.jobId||state.identity.attemptId!==grant.attemptId||state.identity.deviceId!==grant.approvalEnvelope.approval.deviceId||state.identity.epoch!==grant.executionEpoch||state.identity.specSha256!==grant.record.specSha256)fail('journal_grant_identity_differs');
 if(!grant.resumed&&state.phase!==null&&state.phase!=='claimed')fail('journal_launch_history_conflict');
 const context={jobId:grant.jobId,deviceId:grant.approvalEnvelope.approval.deviceId,ownerKey,projectId:spec.projectId,taskId:spec.taskId,taskSnapshotSha256:spec.taskSnapshotSha256,repositoryKey:spec.repositoryKey,baseCommit:spec.baseCommit,executionEpoch:grant.executionEpoch,approvalEpoch:grant.executionEpoch,jobStatus:frozen.jobStatusAtClaim,activeAttempts:frozen.activeAttemptsBefore+local.otherActiveAttempts,approvalConsumed:frozen.approvalConsumedBefore,cancelRequested:local.cancelRequested,localDisabled:local.localDisabled,usedJobs:local.usedJobs,usedRuntimeSeconds:local.usedRuntimeSeconds,artifacts:frozen.artifactRefs.map(item=>({...item,ownerKey,immutable:true})),source:'native-authorized'};
 const admission={spec,specSha256:grant.record.specSha256,policy,capability,approval:grant.approvalEnvelope.approval,context,dependencies:frozen.dependencyRows,now:grant.serverNow};
 const lease=bindAgentLease(grant,{expectedBindingSha256:grant.approvalEnvelope.bindingSha256,admission,sentMonotonicMs:proof.sentMonotonicMs,receivedMonotonicMs:proof.receivedMonotonicMs});
 if(state.phase===null)await journal.append({kind:'phase',value:{phase:'claimed',workspaceKey:null,processIdentity:null,nextEventSequence:state.nextEventSequence}});
 return Object.freeze({
  identity:lease.identity,spec:lease.spec,binding:lease.binding,taskInput:lease.taskInput,get mayLaunch(){return lease.mayLaunch;},
  assertCurrent:now=>lease.assertCurrent(now),needsRenew:now=>lease.needsRenew(now),consumeLaunch:now=>{if(journal.snapshot().phase!=='launch_intent')fail('durable_launch_intent_required');return lease.consumeLaunch(now);},requestStop:reason=>lease.requestStop(reason),snapshot:()=>lease.snapshot(),
  async renew(transport){if(authenticatedTransports.get(transport)?.origin!==proof.origin)fail('authenticated_agent_transport_required');return lease.renew({async renew(body){const response=await transport.renew(body);if(authenticatedGrants.get(response)?.origin!==proof.origin)fail('authenticated_agent_grant_required');return response;}},proof.monotonic);},
  reportEvents(transport,events){if(authenticatedTransports.get(transport)?.origin!==proof.origin)fail('authenticated_agent_transport_required');return lease.reportEvents(transport,events);}
 });
}
