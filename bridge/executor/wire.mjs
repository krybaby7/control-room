import {parseJobSpec,jobSpecSha256,validateJobDependencyGraph} from '../src/execution-policy.mjs';
import {admitExecutionLease,parseExecutionBinding} from './lease.mjs';
import {shape,id,digest,integer,bool,stamp,canonical,sha,fail,freezeJson} from './codec.mjs';
const TASK_KEYS=['id','projectId','milestoneId','title','notes','status','horizon','priority','dueDate','weekly','weeklyWeek','estimateMinutes','dependsOn','blocker','sourceUrl','evidence','completedAt','archivedFromStatus','acceptanceInputs'];
function boundedJson(raw,{maxBytes=32768,maxNodes=10000,maxDepth=40,code='task_input_bound'}={}){
 const stack=[{value:raw,depth:0}],seen=new Set();let nodes=0;
 while(stack.length){const {value,depth,exit}=stack.pop();if(exit){seen.delete(value);continue;}if(++nodes>maxNodes||depth>maxDepth)fail(code);if(value===null||['string','boolean'].includes(typeof value)||typeof value==='number'&&Number.isFinite(value))continue;if(typeof value!=='object'||seen.has(value)||!Array.isArray(value)&&Object.getPrototypeOf(value)!==Object.prototype)fail('invalid_task_input');seen.add(value);stack.push({value,depth,exit:true});if(!Array.isArray(value)&&Object.keys(value).some(key=>['__proto__','constructor','prototype'].includes(key)))fail('invalid_task_input');for(const child of Object.values(value))stack.push({value:child,depth:depth+1});}
 if(Buffer.byteLength(canonical(raw))>maxBytes)fail(code);
}
export function parseAgentLease(raw){
 shape(raw,['attemptId','jobId','executionEpoch','leaseToken','leaseExpiresAt','deadlineAt','operationalRevision','record','executionBinding','resumed','approvalEnvelope','serverNow','taskInput','frozenAdmission']);
 id(raw.attemptId);id(raw.jobId);integer(raw.executionEpoch);integer(raw.operationalRevision,1);bool(raw.resumed);stamp(raw.serverNow);stamp(raw.leaseExpiresAt);stamp(raw.deadlineAt);
 if(typeof raw.leaseToken!=='string'||!/^[a-f0-9]{64}$/u.test(raw.leaseToken))fail('invalid_lease_token');
 shape(raw.record,['id','intentId','spec','specSha256','createdAt','retryOfJobId','historical']);id(raw.record.id);id(raw.record.intentId);stamp(raw.record.createdAt);if(raw.record.retryOfJobId!==null)id(raw.record.retryOfJobId);if(raw.record.historical!==false||raw.record.id!==raw.jobId||raw.record.retryOfJobId===raw.record.id)fail('historical_job_not_authority');
 boundedJson(raw,{maxBytes:524288,maxNodes:50000,maxDepth:45,code:'agent_lease_bound'});
 const spec=parseJobSpec(raw.record.spec);if(digest(raw.record.specSha256)!==jobSpecSha256(spec))fail('record_spec_differs');
 const binding=parseExecutionBinding(raw.executionBinding);shape(raw.approvalEnvelope,['approval','executionBinding','bindingSha256','reservationId','approverId']);id(raw.approvalEnvelope.reservationId);id(raw.approvalEnvelope.approverId);digest(raw.approvalEnvelope.bindingSha256);
 if(canonical(binding)!==canonical(raw.approvalEnvelope.executionBinding)||sha(binding)!==raw.approvalEnvelope.bindingSha256)fail('envelope_binding_differs');
 const approval=raw.approvalEnvelope.approval;shape(approval,['id','jobId','deviceId','specSha256','capabilitySha256','configurationSha256','taskSnapshotSha256','approvedAt','expiresAt','revokedAt','attempts','budget','origin']);for(const key of ['id','jobId','deviceId'])id(approval[key]);for(const key of ['specSha256','capabilitySha256','configurationSha256','taskSnapshotSha256'])digest(approval[key]);stamp(approval.approvedAt);stamp(approval.expiresAt);if(approval.revokedAt!==null)stamp(approval.revokedAt);shape(approval.budget,['jobs','timeoutSeconds']);if(approval.attempts!==1||approval.budget.jobs!==1||approval.budget.timeoutSeconds!==spec.timeoutSeconds||approval.origin!=='native-owner'||approval.jobId!==raw.jobId||approval.specSha256!==raw.record.specSha256||approval.taskSnapshotSha256!==spec.taskSnapshotSha256||approval.capabilitySha256!==binding.capabilitySha256||approval.configurationSha256!==binding.configurationSha256||Date.parse(approval.expiresAt)-Date.parse(approval.approvedAt)<=0||Date.parse(approval.expiresAt)-Date.parse(approval.approvedAt)>86400000)fail('approval_wire_identity_differs');

 boundedJson(raw.taskInput);shape(raw.taskInput,TASK_KEYS);if(raw.taskInput.id!==spec.taskId||raw.taskInput.projectId!==spec.projectId||sha(raw.taskInput)!==spec.taskSnapshotSha256)fail('task_snapshot_differs');
 if(Buffer.byteLength(canonical(raw.taskInput))+binding.artifactRefs.reduce((sum,item)=>sum+item.bytes,0)>binding.budget.inputBytesLimit)fail('task_and_artifact_input_bound');
 const frozen=raw.frozenAdmission;shape(frozen,['ownerContextHash','jobStatusAtClaim','activeAttemptsBefore','approvalConsumedBefore','dependencyRows','artifactRefs']);digest(frozen.ownerContextHash);if(frozen.jobStatusAtClaim!=='queued'||frozen.activeAttemptsBefore!==0||frozen.approvalConsumedBefore!==false||Buffer.byteLength(canonical(frozen))>393216)fail('invalid_frozen_admission');
 const rows=validateJobDependencyGraph(raw.jobId,frozen.dependencyRows,frozen.ownerContextHash),root=rows.find(row=>row.id===raw.jobId);if(root.status!=='queued'||canonical(root.dependsOnJobIds)!==canonical(spec.dependsOnJobIds)||root.dependsOnJobIds.some(id=>rows.find(row=>row.id===id)?.status!=='succeeded'))fail('frozen_dependency_identity_differs');
 if(canonical(frozen.artifactRefs)!==canonical(binding.artifactRefs))fail('frozen_artifact_identity_differs');

 const now=Date.parse(raw.serverNow),expires=Date.parse(raw.leaseExpiresAt),deadline=Date.parse(raw.deadlineAt);if(expires<=now||expires-now>60000||expires>deadline||deadline-now>spec.timeoutSeconds*1000||deadline<=now)fail('invalid_server_deadline');
 return JSON.parse(canonical(raw));
}
function localLease(wire){return {jobId:wire.jobId,attemptId:wire.attemptId,epoch:wire.executionEpoch,deviceId:wire.approvalEnvelope.approval.deviceId,leaseToken:wire.leaseToken,expiresAt:wire.leaseExpiresAt,spec:wire.record.spec,specSha256:wire.record.specSha256,approvalId:wire.approvalEnvelope.approval.id};}
/** All response data must arrive through the authenticated fixed transport.
 * The expected binding hash is retained independently from the owner's approval.
 * Resumed leases never authorize another process launch. */
export function bindAgentLease(raw,{expectedBindingSha256,admission,sentMonotonicMs,receivedMonotonicMs}){
 const wire=parseAgentLease(raw),timing={serverNow:wire.serverNow,sentMonotonicMs,receivedMonotonicMs};
 const local=admitExecutionLease({lease:localLease(wire),envelope:wire.approvalEnvelope,expectedBindingSha256,admission,timing,serverDeadlineAt:wire.deadlineAt});
 let current=wire,nextRenew=receivedMonotonicMs+15000,uncertain=false,renewing=false,launchConsumed=false;
 return Object.freeze({
  identity:local.identity,spec:local.spec,binding:local.binding,
  taskInput:freezeJson(JSON.parse(canonical(wire.taskInput))),get mayLaunch(){return !wire.resumed&&!uncertain&&!launchConsumed&&local.snapshot().stopReason===null;},
  consumeLaunch(now){this.assertCurrent(now);if(!this.mayLaunch)fail('launch_not_admissible');launchConsumed=true;},
  assertCurrent(now){if(uncertain)fail('lease_renewal_uncertain');local.assertCurrent(now);},
  needsRenew(now){this.assertCurrent(now);return now>=nextRenew;},
  async renew(transport,monotonic){
   if(renewing)fail('renewal_in_progress');const sent=monotonic();this.assertCurrent(sent);renewing=true;
   try{const response=await transport.renew({attemptId:current.attemptId,leaseToken:current.leaseToken}),received=monotonic(),next=parseAgentLease(response);if(!next.resumed||next.operationalRevision<=current.operationalRevision||['attemptId','jobId','executionEpoch','leaseToken','deadlineAt'].some(key=>next[key]!==current[key])||canonical(next.record)!==canonical(current.record)||canonical(next.executionBinding)!==canonical(current.executionBinding)||canonical(next.approvalEnvelope)!==canonical(current.approvalEnvelope)||canonical(next.taskInput)!==canonical(current.taskInput)||canonical(next.frozenAdmission)!==canonical(current.frozenAdmission))fail('renewal_wire_identity_differs');
    local.renew(localLease(next),{serverNow:next.serverNow,sentMonotonicMs:sent,receivedMonotonicMs:received});current=next;nextRenew=received+15000;return this.snapshot();
   }catch{uncertain=true;local.requestStop('shutdown');fail('lease_renewal_uncertain');}finally{renewing=false;}
  },
  reportEvents(transport,events){return transport.events({attemptId:current.attemptId,leaseToken:current.leaseToken,events});},
  requestStop(reason){local.requestStop(reason);},
  snapshot(){return {...local.snapshot(),operationalRevision:current.operationalRevision,nextRenewMonotonicMs:nextRenew,resumed:wire.resumed,mayLaunch:this.mayLaunch};}
 });
}
/** Receipt acknowledgement is journaled only after exact immutable hash/epoch/sequence verification.
 * Ambiguous HTTP outcomes leave the same pending events for exact-ID retry. */
export async function flushJournalEvents({journal,lease,transport}){
 const snapshot=journal.snapshot(),credentials={attemptId:lease.identity.attemptId,leaseToken:'0'.repeat(64)};if(snapshot.identity.attemptId!==credentials.attemptId||snapshot.identity.epoch!==lease.identity.epoch)fail('journal_lease_identity_differs');
 const candidates=snapshot.pending.filter(row=>row.entry.kind==='event').sort((a,b)=>a.entry.value.sequence-b.entry.value.sequence),batch=[];
 for(const row of candidates){const next=[...batch,row.entry.value];if(next.length>50||Buffer.byteLength(canonical({...credentials,events:next}))>65536)break;batch.push(row.entry.value);}
 if(!batch.length){if(candidates.length)fail('event_request_bound');return {sent:0,lastAppliedSequence:null};}
 const reply=await lease.reportEvents(transport,batch);shape(reply,['receipts','lastAppliedSequence']);integer(reply.lastAppliedSequence,0,snapshot.nextEventSequence-1);
 if(!Array.isArray(reply.receipts)||reply.receipts.length!==batch.length)fail('event_receipt_set_differs');const receipts=JSON.parse(canonical(reply.receipts)),seen=new Set();
 for(const receipt of receipts){shape(receipt,['attemptId','epoch','sequence','payloadSha256','receivedAt']);stamp(receipt.receivedAt);integer(receipt.sequence,1);digest(receipt.payloadSha256);const event=batch.find(item=>item.sequence===receipt.sequence);if(!event||seen.has(receipt.sequence)||receipt.attemptId!==snapshot.identity.attemptId||receipt.epoch!==snapshot.identity.epoch||receipt.payloadSha256!==sha(event))fail('event_receipt_identity_differs');seen.add(receipt.sequence);}
 for(const receipt of receipts)await journal.append({kind:'receipt',value:{target:'event',id:String(receipt.sequence),sha256:receipt.payloadSha256,receivedAt:receipt.receivedAt}});
 return {sent:batch.length,lastAppliedSequence:reply.lastAppliedSequence};
}
