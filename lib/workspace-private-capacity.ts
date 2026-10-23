import {createsHistoryOwnerGrant} from './history/owner-grants.ts';
import {parseHistoryRecord} from './history/record.ts';
import {canonical,contentHash} from './canonical-json.ts';
import {sourceConfigurationHash} from './background/job-store.ts';
import {sourceConnectionSchema,sourceTargetSchema} from './sources/validation.ts';
import {auditProjectIds} from './audit-projects.ts';
import {privateInsertGrowth,combinePrivateGrowth,createPrivateGrowthContext,type PrivateGrowthContext} from './private-growth.ts';
import {privateRowGrowth,type PrivateGrowth,type PrivateCapacityGuard} from './private-capacity.ts';
import type {SqlDatabase} from './workspace-store.ts';
import type {WorkspaceEnvelope} from './types.ts';
import type {MutationPlan} from './workspace-transaction.ts';
import type {WorkspaceCommand} from './workspace-protocol.ts';
import type {prepareWorkspaceBackup} from './workspace-backups.ts';
import type {validateAgentArtifactPlan} from './agents/artifact-controls.ts';
type Bind=string|number|null;type Row=Record<string,Bind>;
export interface WorkspacePrivateCapacityInput {
 plan:MutationPlan;before:WorkspaceEnvelope;command:WorkspaceCommand;
 mutationId:string;commandHash:string;now:string;
 preparedBackup:Awaited<ReturnType<typeof prepareWorkspaceBackup>>|null;
 agentArtifact?:Awaited<ReturnType<typeof validateAgentArtifactPlan>>;
 /** Additional server-produced physical growth from other leaf controls. This
  * is NEVER a request field. Their own count/row guards remain mandatory. */
 supplementalGrowth?:readonly PrivateGrowth[];
}
export interface WorkspacePrivateCapacityQuote {schemaContext:PrivateGrowthContext;growth:PrivateGrowth[];guards:PrivateCapacityGuard[];firstCancelAttemptIds:string[];firstRevokeDeviceIds:string[]}
/** Quote growth only: this helper does not admit a command, consume a reservation,
 * create authority, or execute writes. All returned guards and the neutral
 * privateCapacityGuard MUST run inside the same transient compiler claim.
 *
 * Existing bytes/deletions never fund growth. Updates use independent positive
 * column bounds, avoiding stale-before-size undercounts. Actual affected-count
 * guards close operational insertion races for bulk recovery updates. */
export async function workspacePrivateCapacityGrowth(db:SqlDatabase,owner:string,input:WorkspacePrivateCapacityInput):Promise<WorkspacePrivateCapacityQuote>{
 if(!owner||owner.length>256||!Number.isSafeInteger(input.before.revision)||input.before.revision<1)throw new Error('Invalid server capacity context.');
 const growthContext=await createPrivateGrowthContext(db);
 const {plan,command,now}=input,guards:PrivateCapacityGuard[]=[{sql:growthContext.guard.sql,bindings:[...growthContext.guard.bindings]}],totals=new Map<string,PrivateGrowth>();
 const table=(name:string)=>name as PrivateGrowth['table'];
 function add(value:PrivateGrowth){if(!Number.isSafeInteger(value.bytes)||value.bytes<0||!Number.isSafeInteger(value.rows)||value.rows<0)throw new Error('Invalid private growth.');const previous=totals.get(value.table);const next={...value,bytes:value.bytes+(previous?.bytes??0),rows:value.rows+(previous?.rows??0)};if(!Number.isSafeInteger(next.bytes)||!Number.isSafeInteger(next.rows))throw new Error('Private growth exceeds safe arithmetic.');totals.set(value.table,next);}
 async function insert(name:string,values:Row){add(await privateInsertGrowth(db,table(name) as Exclude<PrivateGrowth['table'],'baselineRemovalFences'>,values,growthContext));}
 // Full new value fragments include their keys/punctuation and hence upper
 // bound every positive replacement delta, even if old values changed.
 function update(name:string,patch:Row,count=1){if(!Number.isSafeInteger(count)||count<0)throw new Error('Invalid private update count.');if(!count)return;const size=privateRowGrowth(table(name),null,patch);add({...size,rows:0,bytes:size.bytes*count});}
 async function count(name:string,predicate='1',bindings:Bind[]=[]){const row=await db.prepare('SELECT COUNT(*) AS n FROM '+name+' WHERE user_id=? AND '+predicate).bind(owner,...bindings).first<{n:number}>();const n=row?.n??0;if(!Number.isSafeInteger(n)||n<0||n>100000)throw new Error('Private affected-row bound exceeded.');guards.push({sql:'(SELECT COUNT(*) FROM '+name+' WHERE user_id=? AND '+predicate+')<=?',bindings:[owner,...bindings,n]});return n;}
 async function upsert(name:string,key:Row,values:Row){
  const where=Object.keys(key).map(column=>column+' IS ?').join(' AND ')||'1',bindings=[owner,...Object.values(key)];
  const found=await db.prepare('SELECT 1 FROM '+name+' WHERE user_id=? AND '+where).bind(...bindings).first();
  guards.push({sql:(found?'EXISTS':'NOT EXISTS')+'(SELECT 1 FROM '+name+' WHERE user_id=? AND '+where+')',bindings});
  if(found)update(name,values);else await insert(name,{...key,...values});
 }
 // Epoch is used only by prospective rows that actually contain it. Keep its
 // exact persisted value and share one operation-local read across those rows.
 let epochRead:Promise<number>|undefined;
 function readEpoch():Promise<number>{return epochRead??=db.prepare('SELECT epoch FROM workspace_execution_state WHERE user_id=?').bind(owner).first<{epoch:number}>().then(row=>row?.epoch??0);}
 await insert('workspace_mutations',{mutation_id:input.mutationId,command_hash:input.commandHash,revision:input.before.revision+1,committed_at:now});
 for(const job of plan.jobs)await insert('workspace_job_intents',{id:job.id,kind:job.kind,dedupe_key:job.dedupeKey,payload_json:canonical(job.payload),not_before:job.notBefore,status:job.kind==='agent.execute'?'awaiting_approval':'pending',execution_epoch:await readEpoch(),cancel_requested:0});
 if(plan.restoreEpoch)update('workspace_job_intents',{status:'cancelled',cancel_requested:1},await count('workspace_job_intents'));
 if(plan.importSource){
  // Match the compiler's exact activation scope. A status transition still has
  // positive physical bytes, even though no new stage row is inserted.
  const source=plan.importSource,predicate="import_id=? AND import_hash=? AND status='verified' AND target_revision=? AND expires_at>?";
  const affected=await count('attachment_archive_stages',predicate,[source.id,source.hash,input.before.revision,now]);
  update('attachment_archive_stages',{status:'committed'},affected);
 }
 if(input.preparedBackup){const backup=input.preparedBackup.manifest;await insert('workspace_backups',{id:backup.id,source_revision:input.before.revision,created_at:now,reason:backup.reason,bytes:backup.bytes,sha256:backup.sha256,content:input.preparedBackup.content,status:'ready',pinned:backup.reason==='manual'?1:0});}
 if(plan.backup?.reason==='restore'){
  // The compiler copies persisted planning bytes, not a hydrated weekly view.
  const persisted=await db.prepare('SELECT content,revision,updated_at FROM workspaces WHERE user_id=?').bind(owner).first<{content:string;revision:number;updated_at:string}>();
  if(!persisted)throw new Error('Missing owner workspace.');
  await upsert('workspace_recovery',{},persisted);
 }
 for(const event of plan.events){
  for(const projectId of auditProjectIds(event,input.before.workspace,plan.planningAfter))await insert('audit_project_links',{event_id:event.id,project_id:projectId});
  if(event.kind==='entity.delete'&&(event.entityType==='task'||event.entityType==='capture')){
   add(privateRowGrowth('baselineRemovalFences',null,{entity_id:event.entityId,entity_type:event.entityType,event_id:event.id,kind:event.kind,occurred_at:now,payload_json:canonical(event)}));
  }
 }
 for(const entry of plan.historyImports??[])if(entry.sourceIdentity!==undefined&&entry.sourceHash!==undefined)await upsert('audit_import_identities',{source_identity:entry.sourceIdentity},{source_hash:entry.sourceHash,event_id:entry.id});
 // Consent is non-recoverable authority: its compiler enforces a separate
 // finite authority pool with funded revocation, never the recovery DATA quota.
 for(const grant of plan.reviewGrants??[])await insert('review_ack_grants',{ack_id:grant.id,ack_hash:grant.hash,snapshot_id:grant.snapshotId,snapshot_hash:grant.snapshotHash,created_at:now});
 for(const read of plan.notificationReads??[])if(read.read)await upsert('notification_read_state',{notification_id:read.id},{notification_hash:read.hash,read_at:now,request_id:input.mutationId});
 if(plan.baselineAdvance)await upsert('project_baseline_heads',{project_id:plan.baselineAdvance.projectId},{revision_id:plan.baselineAdvance.revisionId,content_hash:plan.baselineAdvance.hash,recorded_at:now});
 for(const write of plan.writes){
  if(write.table==='project_history'&&write.operation!=='delete'&&['roadmap.agree','checkpoint.assess','history.association.set'].includes(command.type)&&createsHistoryOwnerGrant(command.type,parseHistoryRecord(write.value),write.operation,now,input.mutationId))await insert('acceptance_owner_grants',{record_id:write.id,content_hash:await contentHash(canonical(write.value))});
  if(command.type==='acceptance.record'&&write.table==='acceptance_records'&&write.operation==='insert')await insert('acceptance_owner_grants',{record_id:write.id,content_hash:await contentHash(canonical(write.value))});
  if((command.type==='decisions.decide'||command.type==='decisions.supersede')&&write.table==='decision_versions'&&write.operation==='insert'){
   const value=write.value as unknown as {id:string;version:number;status:string;decidedAt:string|null;recordedAt:string};
   if(value.status==='decided'&&value.decidedAt===now&&value.recordedAt===now)await insert('decision_owner_grants',{decision_id:value.id,version:value.version,content_hash:await contentHash(canonical(value))});
  }
  if(write.table==='attachments'&&write.operation==='insert'&&(command.type==='attachment.reserve'||command.type==='jobs.artifact.reserve')){
   const value=write.value as unknown as {id:string;storageKey:string;expectedBytes:number;createdAt:string},ns=await db.prepare('SELECT blob_namespace FROM workspace_source_namespaces WHERE user_id=?').bind(owner).first<{blob_namespace:string}>();
   if(!ns)throw new Error('Missing private attachment namespace.');
   await insert('attachment_blob_objects',{storage_key:value.storageKey,attachment_id:value.id,namespace:ns.blob_namespace,bytes:value.expectedBytes,sha256:null,created_at:value.createdAt,verified_at:null,purged_at:null});
  }
  if(write.table==='attachments'&&write.operation==='update'&&(command.type==='attachment.finalize'||command.type==='jobs.artifact.finalize')){
   const value=write.value as unknown as {sha256:string|null;readyAt:string|null};update('attachment_blob_objects',{sha256:value.sha256,verified_at:value.readyAt});
  }
 }
 if(command.type==='jobs.artifact.reserve'&&input.agentArtifact){const {material,record}=input.agentArtifact;await insert('agent_artifacts',{attempt_id:material.attemptId,artifact_id:record.id,logical_type:material.logicalType,sha256:material.sha256,bytes:material.bytes,created_at:now});}
 const controls=plan.agentControls;
 const revisionMax=Number.MAX_SAFE_INTEGER;
 const pending="'awaiting_approval','queued','leased','running','cancelling','reconcile_required'";
 async function release(approvalId:string|null){if(!approvalId)return;const row=await db.prepare('SELECT payload_json,revoked_at FROM job_approvals WHERE user_id=? AND id=?').bind(owner,approvalId).first<{payload_json:string;revoked_at:string|null}>();if(row?.revoked_at===null){update('job_approvals',{revoked_at:now});update('agent_budgets',{reserved_jobs:revisionMax,reserved_seconds:revisionMax,operational_revision:revisionMax,updated_at:now});}}
 if(plan.restoreEpoch){
  const n=await count('agent_job_state','status IN('+pending+')');
  update('agent_job_state',{status:'reconcile_required',cancel_requested_at:now,cancel_request_id:'restore-'+'f'.repeat(36),operational_revision:revisionMax,updated_at:now},n);
  // Each affected state owns at most one immutable approval/reservation. A
  // conservative release bound covers only potential positive numeric/time
  // growth; resource decrements themselves never create quota credit.
  update('job_approvals',{revoked_at:now},n);update('agent_budgets',{reserved_jobs:revisionMax,reserved_seconds:revisionMax,operational_revision:revisionMax,updated_at:now},n);
  update('workspace_job_intents',{status:'cancelled',cancel_requested:1},n);
 }else if(controls?.action==='create'){
  const value=controls.record;await insert('agent_job_state',{job_id:value.id,intent_id:value.intentId,status:'awaiting_approval',operational_revision:1,spec_hash:value.specSha256,task_hash:value.spec.taskSnapshotSha256,execution_epoch:await readEpoch(),updated_at:now});
 }else if(controls?.action==='budget'){
  const values={payload_json:canonical({maximumJobs:controls.maximumJobs,maximumSeconds:controls.maximumSeconds,enabled:controls.enabled}),maximum_jobs:controls.maximumJobs,maximum_seconds:controls.maximumSeconds,enabled:controls.enabled?1:0,updated_at:now};
  if(controls.expectedOperationalRevision===null)await insert('agent_budgets',{id:controls.id,operational_revision:1,reserved_jobs:0,reserved_seconds:0,charged_seconds:0,...values});
  else update('agent_budgets',{...values,operational_revision:revisionMax});
 }else if(controls?.action==='approve'){
  const envelope=controls.envelope;await insert('job_approvals',{id:envelope.approval.id,job_id:controls.jobId,device_id:envelope.approval.deviceId,spec_hash:envelope.approval.specSha256,binding_hash:envelope.bindingSha256,payload_json:canonical(envelope),created_at:now,expires_at:envelope.approval.expiresAt,consumed_at:null,revoked_at:null,reserved_seconds:envelope.approval.budget.timeoutSeconds});
  update('agent_budgets',{reserved_jobs:revisionMax,reserved_seconds:revisionMax,operational_revision:revisionMax,updated_at:now});
  update('agent_job_state',{status:'queued',device_id:envelope.approval.deviceId,approval_id:envelope.approval.id,operational_revision:revisionMax,updated_at:now});update('workspace_job_intents',{status:'pending'});
 }else if(controls?.action==='accept-result')update('agent_job_state',{accepted_at:now,accepted_task_hash:controls.taskHash,operational_revision:revisionMax,updated_at:now});
 else if(controls&&(controls.action==='cancel'||controls.action==='reject')){
  const state=await db.prepare('SELECT approval_id FROM agent_job_state WHERE user_id=? AND job_id=?').bind(owner,controls.jobId).first<{approval_id:string|null}>();await release(state?.approval_id??null);
  update('agent_job_state',{status:'reconcile_required',cancel_requested_at:now,cancel_request_id:controls.requestId,operational_revision:revisionMax,updated_at:now});update('workspace_job_intents',{status:'cancelled',cancel_requested:1});
 }

 // Same-queue extension metadata is private recovery data, not another queue.
 for(const extension of plan.integrationJobs??[])await insert('integration_jobs',{intent_id:extension.intentId,source_id:extension.sourceId,subject_id:extension.sourceId,job_subject_kind:'source',configuration_hash:extension.configurationHash,operational_revision:1,attempt_count:0});
 for(const extension of plan.reviewJobs??[])await insert('integration_jobs',{intent_id:extension.intentId,source_id:null,subject_id:extension.snapshotId,job_subject_kind:'review',configuration_hash:await contentHash(canonical(extension.scope)),operational_revision:1,attempt_count:0});
 if(plan.restoreEpoch){
  update('source_sync_state',{paused:1,cursor:null,etag:null,operational_revision:revisionMax,execution_epoch:revisionMax},await count('source_sync_state'));
  update('automation_runtime',{paused:1,operational_revision:revisionMax,execution_epoch:revisionMax,principal_ref:null,retry_at:null},await count('automation_runtime'));
 }else{
  const changedConnections=new Set(plan.writes.filter(w=>w.table==='source_connections').map(w=>w.id));
  const newTargets=plan.writes.filter(w=>w.table==='source_targets'),archivedProjects=new Set(plan.planningAfter.projects.filter(p=>p.archivedAt&&!input.before.workspace.projects.find(old=>old.id===p.id)?.archivedAt).map(p=>p.id));
  if(changedConnections.size||newTargets.length||plan.sourceControls?.length||archivedProjects.size){
   const stored=(await db.prepare('SELECT id,payload_json FROM source_targets WHERE user_id=? ORDER BY id LIMIT 101').bind(owner).all<{id:string;payload_json:string}>()).results;
   if(stored.length>100)throw new Error('Source target capacity exceeded.');
   const targets=new Map(stored.map(row=>[row.id,sourceTargetSchema.parse(JSON.parse(row.payload_json))]));
   for(const write of newTargets)targets.set(write.id,sourceTargetSchema.parse(write.value));
   const actions=new Map<string,'pause'|'resume'>();for(const target of targets.values())if(changedConnections.has(target.connectionId)||archivedProjects.has(target.projectId)||newTargets.some(write=>write.id===target.id))actions.set(target.id,'pause');
   for(const control of plan.sourceControls??[])actions.set(control.sourceId,control.action);
   for(const [sourceId,action]of actions){
    const target=targets.get(sourceId);if(!target)throw new Error('Source capacity projection has no owner target.');
    const changed=plan.writes.find(write=>write.table==='source_connections'&&write.id===target.connectionId),storedConnection=changed?null:await db.prepare('SELECT payload_json FROM source_connections WHERE user_id=? AND id=?').bind(owner,target.connectionId).first<{payload_json:string}>();
    const connection=sourceConnectionSchema.parse(changed?.value??(storedConnection?JSON.parse(storedConnection.payload_json):null)),hash=await sourceConfigurationHash(connection,target);
    await upsert('source_sync_state',{source_id:sourceId},{operational_revision:revisionMax,configuration_hash:hash,execution_epoch:await readEpoch(),paused:action==='pause'?1:0,cursor:null,etag:null,attempted_at:null,last_success_at:null,last_source_revision:null,failure:null,retry_at:null,failure_count:0});
    if(action==='pause'){const predicate='id IN(SELECT intent_id FROM integration_jobs WHERE user_id=? AND source_id=?)';update('workspace_job_intents',{status:'cancelled',cancel_requested:1},await count('workspace_job_intents',predicate,[owner,sourceId]));}
   }
  }
  for(const control of plan.automationControls??[]){
   // Trusted principal IDs in the closed private profile have a 500-UTF16-unit
   // ceiling; escaped NUL units upper-bound UTF-8/JSON for every such ID.
   // This is a byte bound only and never installs that placeholder.
   await upsert('automation_runtime',{schedule_id:control.scheduleId},{configuration_hash:control.configurationHash,operational_revision:revisionMax,execution_epoch:await readEpoch(),paused:control.action==='pause'?1:0,next_due_at:control.nextDueAt,principal_ref:control.action==='pause'?null:String.fromCharCode(0).repeat(500),last_attempt_at:null,last_success_at:null,failure:null,retry_at:null});
   if(control.action==='pause'){const predicate='(id IN(SELECT intent_id FROM integration_jobs WHERE user_id=? AND schedule_id=?) OR id IN(SELECT intent_id FROM automation_occurrence_claims WHERE user_id=? AND schedule_id=?))';update('workspace_job_intents',{status:'cancelled',cancel_requested:1},await count('workspace_job_intents',predicate,[owner,control.scheduleId,owner,control.scheduleId]));}
  }
 }
 if(plan.deviceControls&&!plan.restoreEpoch){
  const ids=[...new Set([...(plan.deviceControls.revokeIds??[]),...(plan.deviceControls.enrollment?[plan.deviceControls.enrollment.deviceId]:[])])];
  for(const deviceId of ids){
   update('device_sessions',{retired_at:now},await count('device_sessions','device_id=? AND retired_at IS NULL',[deviceId]));
   update('device_live_windows',{consumed_at:now,expires_at:now},await count('device_live_windows','device_id=? AND consumed_at IS NULL AND julianday(expires_at)>julianday(?)',[deviceId,now]));
   await upsert('device_runtime',{device_id:deviceId},{operational_revision:revisionMax,execution_epoch:await readEpoch(),current_generation:revisionMax,current_boot_id:null,last_live_received_at:null,revoked_at:now,last_request_at:null});
  }
 }

 // File retirement modifies private archive bookkeeping without deleting bytes.
 if(plan.fileBackupRemoval)update('backup_archives',{status:'retired',execution_epoch:revisionMax,updated_at:now});
 for(const value of input.supplementalGrowth??[])add(value);
 const growth=combinePrivateGrowth(...totals.values()),firstCancelAttemptIds:string[]=[],firstRevokeDeviceIds:string[]=[];
 // This is a funded-reservation candidate only, NOT a quota exemption. The
 // neutral guard independently verifies unresolved ownership and absent cancel
 // fields; central agent state CAS must write this exact request ID/time.
 if(controls?.action==='cancel'&&controls.requestId===input.mutationId&&growth.reduce((n,row)=>n+row.bytes,0)<=4096&&growth.reduce((n,row)=>n+row.rows,0)<=2){
  const candidate=await db.prepare('SELECT a.id FROM job_attempts a JOIN agent_job_state s ON s.user_id=a.user_id AND s.job_id=a.job_id AND s.attempt_id=a.id WHERE a.user_id=? AND a.job_id=? AND a.result_json IS NULL AND a.reconciled_at IS NULL AND s.cancel_request_id IS NULL AND s.cancel_requested_at IS NULL').bind(owner,controls.jobId).first<{id:string}>();
  if(candidate)firstCancelAttemptIds.push(candidate.id);
 }
 if(command.type==='devices.revoke'&&plan.deviceControls?.revokeIds?.length===1&&command.id===plan.deviceControls.revokeIds[0]&&!plan.deviceControls.enrollment&&!plan.agentControls&&!plan.restoreEpoch&&growth.reduce((sum,row)=>sum+row.bytes,0)<=2048&&growth.reduce((sum,row)=>sum+row.rows,0)<=1){
  const deviceId=plan.deviceControls.revokeIds[0],runtime=await db.prepare('SELECT operational_revision FROM device_runtime WHERE user_id=? AND device_id=? AND revoked_at IS NULL').bind(owner,deviceId).first<{operational_revision:number}>();
  const sessions=await db.prepare('SELECT COUNT(*) n FROM device_sessions WHERE user_id=? AND device_id=? AND retired_at IS NULL').bind(owner,deviceId).first<{n:number}>();
  const windows=await db.prepare('SELECT COUNT(*) n FROM device_live_windows WHERE user_id=? AND device_id=? AND consumed_at IS NULL AND julianday(expires_at)>julianday(?)').bind(owner,deviceId,now).first<{n:number}>();
  const nativeRows=await db.prepare('SELECT COUNT(*) n FROM device_runtime WHERE user_id=?').bind(owner).first<{n:number}>();
  if(runtime&&Number.isSafeInteger(runtime.operational_revision)&&runtime.operational_revision>0&&sessions&&sessions.n<=1&&windows&&windows.n<=1&&nativeRows&&nativeRows.n<=20){
   guards.push({sql:'EXISTS(SELECT 1 FROM device_runtime WHERE user_id=? AND device_id=? AND operational_revision=? AND revoked_at IS NULL)',bindings:[owner,deviceId,runtime.operational_revision]});
   guards.push({sql:'(SELECT COUNT(*) FROM device_sessions WHERE user_id=? AND device_id=? AND retired_at IS NULL)<=1',bindings:[owner,deviceId]});
   guards.push({sql:'(SELECT COUNT(*) FROM device_live_windows WHERE user_id=? AND device_id=? AND consumed_at IS NULL AND julianday(expires_at)>julianday(?))<=1',bindings:[owner,deviceId,now]});
   firstRevokeDeviceIds.push(deviceId);
  }
 }
 return {schemaContext:growthContext,growth,guards,firstCancelAttemptIds,firstRevokeDeviceIds};
}
