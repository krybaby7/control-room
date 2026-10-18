import {database} from '../helpers/sqlite.ts';
import {workspaceFixture,taskFixture} from '../helpers/workspace.ts';
import {loadWorkspace} from '../../lib/workspace-store.ts';
import {canonical,contentHash} from '../../lib/canonical-json.ts';
import type {DevicePrincipal} from '../../lib/devices/contracts.ts';
import type {AgentCommandContext} from '../../lib/agents/command-contracts.ts';
import {agentCapabilitySchema} from '../../lib/agents/contracts.ts';
import {buildAgentJobSpec,agentJobSpecSha256,buildAgentExecutionBinding,agentExecutionBindingSha256,buildAgentApprovalEnvelope} from '../../lib/agents/policy.ts';
import {claimAgentJob,type AgentStoreOptions} from '../../lib/agents/store.ts';
import {getOrCreateWorkspaceNamespaces} from '../../lib/workspace-namespaces.ts';
import type {AttachmentBucket} from '../../lib/attachments.ts';
const now='2026-10-18T12:00:00.000Z',later=(seconds:number)=>new Date(Date.parse(now)+seconds*1000).toISOString(),sha='a'.repeat(64),nonce='synthetic_journal_nonce_artifact_fixture_0001';
export const artifactNow=now,artifactLater=later;
async function baseFixture(timeoutSeconds=120,notes=''){
 const f=database(),owner='synthetic-owner',deviceId='synthetic-device',jobId='synthetic-job',intentId='synthetic-intent';
 const workspace=workspaceFixture({tasks:[taskFixture('task-1',{notes})]});await loadWorkspace(f.db,owner,()=>workspace,now);
 f.sqlite.prepare('INSERT INTO workspace_execution_state(user_id,epoch,restored_at) VALUES(?,0,?)').run(owner,now);
 const display={id:deviceId,label:'Synthetic lease fixture',createdAt:now,archivedAt:null},scopes=['jobs:poll','jobs:report'];
 f.sqlite.prepare('INSERT INTO devices(user_id,id,row_revision,payload_json,content_hash,created_at) VALUES(?,?,1,?,?,?)').run(owner,deviceId,canonical(display),await contentHash(canonical(display)),now);
 f.sqlite.prepare('INSERT INTO device_credentials(user_id,id,device_id,token_hash,scopes_json,execution_epoch,created_at,expires_at) VALUES(?,?,?,?,?,0,?,?)').run(owner,'credential-1',deviceId,sha,canonical(scopes),now,later(3600));
 f.sqlite.prepare('INSERT INTO device_runtime(user_id,device_id,operational_revision,execution_epoch,current_generation) VALUES(?,?,1,0,0)').run(owner,deviceId);
 const principal={ownerId:owner,deviceId,credentialId:'credential-1',scopes} as DevicePrincipal;
 const runtime={version:'synthetic-1',sourceCommit:'b'.repeat(40),packageSha256:sha,toolPolicy:'synthetic-policy',executableSha256:sha,executableVersion:'synthetic 1',toolPolicySha256:sha};
 const capability=agentCapabilitySchema.parse({schemaVersion:1,deviceId,configurationSha256:sha,provider:'codex',runtime,operations:['project.inspect'],models:[{id:'synthetic-exact-model',efforts:['medium']}],repositoryKeys:['synthetic-repo'],observedAt:now,expiresAt:later(300),maxConcurrent:1,availableSlots:1,maxTimeoutSeconds:600,maxOutputBytesLimit:2048,allowedPathsSha256ByRepositoryKey:{'synthetic-repo':sha},modelIdentityPolicy:'require-observed',subscriptionOnly:true,extraUsageOffAttested:true});
 const capabilityHash=await contentHash(canonical(capability));
 f.sqlite.prepare('INSERT INTO agent_capabilities(user_id,device_id,manifest_hash,payload_json,reported_at,operational_revision) VALUES(?,?,?,?,?,1)').run(owner,deviceId,capabilityHash,canonical(capability),now);
 const spec=await buildAgentJobSpec({operation:'project.inspect',projectId:'p1',taskId:'task-1',repositoryKey:'synthetic-repo',baseCommit:'b'.repeat(40),inputArtifactIds:[],requestedModel:'synthetic-exact-model',effort:'medium',timeoutSeconds,outputBytesLimit:2048,dependsOnJobIds:[]},{workspace,workspaceRevision:1,acceptanceInputs:{}});
 const specSha256=await agentJobSpecSha256(spec),record={id:jobId,intentId,spec,specSha256,createdAt:now,retryOfJobId:null,historical:false},binding=await buildAgentExecutionBinding(spec,capability,{artifactRefs:[],budget:{jobs:1,timeoutSeconds,outputBytesLimit:2048,inputBytesLimit:32768,payment:'subscription-only',costDollars:null},now}),bindingHash=await agentExecutionBindingSha256(binding);
 const envelope=await buildAgentApprovalEnvelope(spec,{approval:{id:'approval-1',jobId,deviceId,specSha256,capabilitySha256:capabilityHash,configurationSha256:sha,taskSnapshotSha256:spec.taskSnapshotSha256,approvedAt:now,expiresAt:later(86400),revokedAt:null,attempts:1,budget:{jobs:1,timeoutSeconds},origin:'native-owner'},executionBinding:binding,reservationId:'budget-1',approverId:owner},now);
 f.sqlite.prepare("INSERT INTO workspace_job_intents(user_id,id,kind,dedupe_key,payload_json,not_before,status,execution_epoch,cancel_requested) VALUES(?,?,'agent.execute',?,?,?,'pending',0,0)").run(owner,intentId,jobId,canonical({jobId,specSha256}),now);
 f.sqlite.prepare('INSERT INTO agent_jobs(user_id,id,row_revision,payload_json,content_hash,intent_id,project_id,task_id,spec_hash,created_at) VALUES(?,?,1,?,?,?,?,?,?,?)').run(owner,jobId,canonical(record),await contentHash(canonical(record)),intentId,'p1','task-1',specSha256,now);
 f.sqlite.prepare("INSERT INTO agent_job_state(user_id,job_id,intent_id,status,operational_revision,spec_hash,task_hash,device_id,approval_id,execution_epoch,updated_at) VALUES(?,?,?,'queued',1,?,?,?,?,0,?)").run(owner,jobId,intentId,specSha256,spec.taskSnapshotSha256,deviceId,'approval-1',now);
 f.sqlite.prepare('INSERT INTO job_approvals(user_id,id,job_id,device_id,spec_hash,binding_hash,payload_json,created_at,expires_at,reserved_seconds) VALUES(?,?,?,?,?,?,?,?,?,?)').run(owner,'approval-1',jobId,deviceId,specSha256,bindingHash,canonical(envelope),now,later(86400),timeoutSeconds);
 f.sqlite.prepare('INSERT INTO agent_budgets(user_id,id,operational_revision,payload_json,maximum_jobs,maximum_seconds,reserved_jobs,reserved_seconds,charged_seconds,enabled,updated_at) VALUES(?,?,1,?,1,600,1,?,0,1,?)').run(owner,'budget-1',canonical({maximumJobs:1,maximumSeconds:600,enabled:true}),timeoutSeconds,now);
 const candidate={deviceId,capabilityHash,bindingHash,budgetId:'budget-1',expiresAt:later(300),binding};
 const context:AgentCommandContext={async taskInputs(){return {};},async state(){return null;},async candidate(){return candidate;},async artifacts(){return [];},async dependencies(){return [];}};
 const options:AgentStoreOptions={now,context};
 return {...f,owner,principal,jobId,intentId,record,binding,capability,context,options};
}
export async function artifactSeedFixture(){
 const f=await baseFixture(),deviceSecret='synthetic_device_artifact_credential_00000000000001';f.sqlite.prepare('UPDATE device_credentials SET token_hash=? WHERE user_id=? AND id=?').run(await contentHash(deviceSecret),f.owner,f.principal.credentialId);await getOrCreateWorkspaceNamespaces(f.db,f.owner);
 type ObjectValue={bytes:Uint8Array;httpMetadata:{contentType:string};customMetadata:{sha256:string}};const objects=new Map<string,ObjectValue>(),bucket:AttachmentBucket={
  async put(key,bytes,options){if(objects.has(key))return null;objects.set(key,{bytes:bytes.slice(),httpMetadata:{...options.httpMetadata},customMetadata:{...options.customMetadata}});return {size:bytes.length};},
  async head(key){const object=objects.get(key);return object?{size:object.bytes.length,httpMetadata:{...object.httpMetadata},customMetadata:{...object.customMetadata}}:null;},
  async get(key){const object=objects.get(key);return object?{size:object.bytes.length,body:new ReadableStream<Uint8Array>({start(controller){controller.enqueue(object.bytes.slice());controller.close();}}),httpMetadata:{...object.httpMetadata},customMetadata:{...object.customMetadata}}:null;},
  async delete(key){objects.delete(key);}
 };
 return {...f,deviceSecret,bucket,objects,ingress:{async verify(){return {serviceIdentity:'synthetic-private-artifact-ingress'};}}};
}

export async function artifactFixture(){
 const f=await artifactSeedFixture(),lease=await claimAgentJob(f.db,f.principal,{jobId:f.jobId,journalNonce:nonce},f.options);if(!lease)throw new Error('Synthetic artifact claim failed.');return {...f,lease};
}
