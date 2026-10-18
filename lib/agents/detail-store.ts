import {readCurrent} from '../workspace-store.ts';
import {ownerAgentContext} from './context.ts';
import {agentTaskSemanticProjection} from './policy.ts';
import type {SqlDatabase} from '../workspace-store.ts';
import {canonical,contentHash} from '../canonical-json.ts';
import {agentIdSchema,agentJobEventSchema,agentExecutionBindingSchema,agentApprovalEnvelopeSchema} from './contracts.ts';
import {validateAgentJobRecord} from './policy.ts';
import {readAgentJobs} from './read-store.ts';
import {jobDetailSchema,jobEventPageSchema,type JobDetailRead,type JobEventPage} from './detail-contracts.ts';
import {ownerReader} from '../workspace-modules.ts';
import {attachmentRecordSchema} from '../evidence-module.ts';
import {resolveAttachmentNamespace} from '../attachment-namespace-access.ts';
import {isBlobFenced} from '../attachment-upload-fences.ts';
type Attempt={id:string;job_id:string;execution_epoch:number;identity_json:string;operational_revision:number;last_applied_sequence:number};
async function attempt(db:SqlDatabase,owner:string,jobId:string,attemptId:string){return db.prepare('SELECT id,job_id,execution_epoch,identity_json,operational_revision,last_applied_sequence FROM job_attempts WHERE user_id=? AND job_id=? AND id=?').bind(owner,jobId,attemptId).first<Attempt>();}
/** Owner is supplied only by authenticated server code. No credentials, journal,
 * lease tokens, private approval envelopes or process identity are projected. */
export async function readAgentJobEvents(db:SqlDatabase,owner:string,jobId:string,attemptId:string,now:string,afterSequence=0):Promise<JobEventPage|null>{
 if(!owner||!Number.isSafeInteger(afterSequence)||afterSequence<0||afterSequence>1024)throw new Error('Invalid owner event page.');
 agentIdSchema.parse(jobId);agentIdSchema.parse(attemptId);
 const before=await attempt(db,owner,jobId,attemptId);if(!before)return null;
 const frozen=await validateAgentJobRecord(JSON.parse(before.identity_json).record);if(frozen.id!==jobId)throw new Error('Frozen job identity differs.');
 const rows=(await db.prepare('SELECT sequence,payload_json,payload_hash,received_at,applied_at FROM job_events WHERE user_id=? AND attempt_id=? AND epoch=? AND sequence>? ORDER BY sequence LIMIT 51').bind(owner,attemptId,before.execution_epoch,afterSequence).all<{sequence:number;payload_json:string;payload_hash:string;received_at:string;applied_at:string|null}>()).results;
 const items=[];for(const row of rows.slice(0,50)){const event=agentJobEventSchema.parse(JSON.parse(row.payload_json));if(event.sequence!==row.sequence||await contentHash(canonical(event))!==row.payload_hash)throw new Error('Event digest differs.');items.push({event,payloadHash:row.payload_hash,receivedAt:row.received_at,applied:row.applied_at!==null});}
 const after=await attempt(db,owner,jobId,attemptId);if(!after||canonical(before)!==canonical(after))throw new Error('Attempt changed during read.');
 return jobEventPageSchema.parse({jobId,attemptId,epoch:before.execution_epoch,specSha256:frozen.specSha256,generatedAt:now,afterSequence,lastAppliedSequence:before.last_applied_sequence,items,nextAfterSequence:rows.length>50?items.at(-1)!.event.sequence:null});
}
export async function readAgentJobDetail(db:SqlDatabase,owner:string,jobId:string,now:string):Promise<JobDetailRead|null>{
 agentIdSchema.parse(jobId);if(!owner)throw new Error('An authenticated owner is required.');
 const owned=await db.prepare('SELECT 1 FROM agent_jobs WHERE user_id=? AND id=? UNION ALL SELECT 1 FROM agent_results WHERE user_id=? AND job_id=? UNION ALL SELECT 1 FROM job_attempts WHERE user_id=? AND job_id=? LIMIT 1').bind(owner,jobId,owner,jobId,owner,jobId).first();
 if(!owned)return null;
 const model=await readAgentJobs(db,owner,now,{jobId});const job=model.jobs.find(row=>row.record.id===jobId);if(!job)return null;
 const artifacts:JobDetailRead['artifacts']=[];
 const actual=job.result?await attempt(db,owner,jobId,job.result.attemptId):null;
 const frozen=actual?await validateAgentJobRecord(JSON.parse(actual.identity_json).record):null;
 for(const id of job.result?.artifactIds??[]){
  const unavailable={id,status:'unavailable' as const,logicalType:null,filename:null,mimeType:null,bytes:null,sha256:null,href:null};
  if(!actual||frozen?.id!==jobId||frozen.specSha256!==job.record.specSha256||actual.execution_epoch!==job.result!.epoch){artifacts.push(unavailable);continue;}
  const binding=await db.prepare('SELECT logical_type,sha256,bytes FROM agent_artifacts WHERE user_id=? AND attempt_id=? AND artifact_id=?').bind(owner,actual.id,id).first<{logical_type:string;sha256:string;bytes:number}>();
  if(!binding){artifacts.push(unavailable);continue;}
  const row=await ownerReader(db,owner).get('attachments',id);if(!row){artifacts.push(unavailable);continue;}
  const record=attachmentRecordSchema.parse(JSON.parse(row.payload_json));if(record.id!==id||await contentHash(canonical(record))!==row.content_hash)throw new Error('Artifact metadata digest differs.');
  if(record.status!=='ready'||record.sha256!==binding.sha256||record.actualBytes!==binding.bytes||record.expectedBytes!==binding.bytes||!await resolveAttachmentNamespace(db,owner,record)||await isBlobFenced(db,owner,{attachmentId:id,storageKey:record.storageKey})){artifacts.push(unavailable);continue;}
  const ledger=await db.prepare('SELECT 1 FROM attachment_blob_objects WHERE user_id=? AND storage_key=? AND attachment_id=? AND bytes=? AND sha256=? AND verified_at IS NOT NULL AND purged_at IS NULL').bind(owner,record.storageKey,id,binding.bytes,binding.sha256).first();
  if(!ledger){artifacts.push(unavailable);continue;}
  artifacts.push({id,status:'ready',logicalType:binding.logical_type as 'summary'|'patch'|'transcript'|'diagnostic',filename:record.filename,mimeType:record.mimeType,bytes:binding.bytes,sha256:binding.sha256,href:'/api/attachments/'+encodeURIComponent(id)+'/content'});
 }
 let provenance:JobDetailRead['provenance']=null;
 const provenanceAttempt=job.attempt?await attempt(db,owner,jobId,job.attempt.id):actual;
 if(provenanceAttempt){const identity=JSON.parse(provenanceAttempt.identity_json),parsedBinding=agentExecutionBindingSchema.safeParse(identity.executionBinding),envelope=agentApprovalEnvelopeSchema.safeParse(identity.approvalEnvelope);
 if(parsedBinding.success&&envelope.success){const prior=await validateAgentJobRecord(identity.record);if(prior.id!==jobId||canonical(parsedBinding.data)!==canonical(envelope.data.executionBinding)||await contentHash(canonical(identity.taskInput))!==prior.spec.taskSnapshotSha256)throw new Error('Frozen input identity differs.');
 const current=await readCurrent(db,owner,now),task=current.workspace.tasks.find(row=>row.id===prior.spec.taskId);let currentTaskMatches:boolean|null=null;if(task){const projection=agentTaskSemanticProjection(task,await ownerAgentContext(db,owner,now).taskInputs(task.id));currentTaskMatches=await contentHash(canonical(projection))===prior.spec.taskSnapshotSha256;}
 provenance={specSha256:prior.specSha256,baseCommit:prior.spec.baseCommit,repositoryKey:prior.spec.repositoryKey,inputArtifacts:parsedBinding.data.artifactRefs,configurationHash:parsedBinding.data.configurationSha256,allowedPathsHash:parsedBinding.data.allowedPathsSha256,runtime:parsedBinding.data.runtime,provider:parsedBinding.data.provider,capabilityHash:parsedBinding.data.capabilitySha256,taskInputHash:prior.spec.taskSnapshotSha256,currentTaskMatches};}}
 const events=job.attempt?await readAgentJobEvents(db,owner,jobId,job.attempt.id,now):null;
 const fresh=await readAgentJobs(db,owner,now,{jobId}),freshJob=fresh.jobs.find(row=>row.record.id===jobId);
 if(fresh.revision!==model.revision||canonical(freshJob??null)!==canonical(job))throw new Error('Job detail changed during read.');
 return jobDetailSchema.parse({revision:model.revision,generatedAt:now,job,provenance,artifacts,events});
}
