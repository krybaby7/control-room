import {compileHistoryAnalysisConsent} from './history/analysis-commands.ts';
import {createsHistoryOwnerGrant} from './history/owner-grants.ts';
import {parseHistoryRecord} from './history/record.ts';
import {generationAssertionStatements} from './generation-assertions.ts';
import {readFinalMutation} from './final-mutation-read.ts';
import {capturePlanningPreflight} from './recoverability-planning-capture.ts';
import {readMutationAdmission,classifyMutationAdmission} from './mutation-admission-reader.ts';
import {withWorkspaceAdmission} from './workspace-admission.ts';
import {workspacePrivateCapacityGrowth} from './workspace-private-capacity.ts';
import {privateCapacityGuard,PrivateCapacityError} from './private-capacity.ts';
import {fileBackupRemovalControlSchema,fileBackupRemovalStatements} from './automations/backup-archive-removal.ts';
import {validateAgentArtifactPlan} from './agents/artifact-controls.ts';
import {backupQuotaGuard} from './backup-archive-quota.ts';
import {validateAttachmentMetadataDiscard} from './attachment-metadata-discard-control.ts';
import {validateNormalizedMergePlan,normalizedMergeAttachmentAssertions,type NormalizedMergeControl} from './normalized-merge-control.ts';
import {agentControlStatements} from './agents/transaction-controls.ts';
import {deviceControlStatements} from './runtime/transaction-controls.ts';
import {baselineControlStatements} from './baselines/transaction-controls.ts';
import {recoverabilityConditions,combineClaimConditions,prepareClaimAssertions,RecoverabilityCapacityError} from './recoverability-admission.ts';
import {RECOVERABILITY_SQL_ARGUMENT_BYTES} from './recoverability-measure.ts';
import {reviewControlStatements} from './reviews/transaction-controls.ts';
import {sourceControlStatements} from './sources/transaction-controls.ts';
import {attachmentGenerationSql,attachmentGenerationPredicate} from './attachment-generation.ts';
import {ownerPrepareContext} from './workspace-context.ts';
import {auditProjectIds} from './audit-projects.ts';
import {moduleProjection,moduleColumnNames,IMMUTABLE_MODULE_TABLES} from './module-columns.ts';
import type { Workspace, WorkspaceEnvelope } from './types.ts';
import { readCurrent, type SqlDatabase, type SqlStatement } from './workspace-store.ts';
import { parseWorkspaceExport } from './workspace-validation.ts';
import { encodePlanning } from './workspace-codec.ts';
import { OWNER_TABLES, ownerReader, ownerTable, type GuardedWrite, type RowPrecondition, type OwnerScopedReader, type RegisteredOwnerTable, type ModuleRow } from './workspace-modules.ts';
import type { AuditEventDraft, CommandResult, JobIntent, MutationOutcome, WorkspaceCommand } from './workspace-protocol.ts';
import { readStagedImport } from './import-staging.ts';
import { prepareWorkspaceBackup, readWorkspaceBackup, listWorkspaceBackups, BACKUP_LIMITS } from './workspace-backups.ts';
import { RECEIPT_CAPACITY, WorkspaceCapacityError, receiptCount } from './workspace-capacity.ts';
import { checkMutationEpoch } from './idempotency-retention.ts';
import { RetiredMutationError, CommandValidationError, MutationIdReuseError, ModuleConflictError, WorkspaceStorageError } from './workspace-errors.ts';
export interface ModuleReplacement {table:RegisteredOwnerTable;beforeRows:ModuleRow[];records:Array<{id:string;value:import('./workspace-protocol.ts').JsonValue}>;}
export interface MutationPlan { historyAnalysisConsent?:import('./history/analysis-commands.ts').HistoryAnalysisConsentControl; historyRemovalRows?:Array<{id:string;row_revision:number;content_hash:string}>; fileBackupRemoval?:import('./automations/backup-archive-removal.ts').FileBackupRemovalControl; normalizedMerge?:NormalizedMergeControl;attachmentMetadataDiscard?:{id:string;storageKey:string}; agentControls?:import('./agents/command-contracts.ts').AgentControls; deviceControls?:import('./runtime/command-contracts.ts').DeviceRuntimeControls; baselineAdvance?:{workspaceRevision:number;operationalWatermarks:Record<string,number>;revisionId:string;hash:string;projectId:string;expectedParent:import('./baselines/contracts.ts').BaselineParent;sourceProofs:import('./baselines/contracts.ts').BaselineSourceProof[]}; reviewGrants?:Array<{id:string;hash:string;snapshotId:string;snapshotHash:string}>;notificationReads?:Array<{id:string;hash:string;read:boolean}>;automationControls?:Array<{scheduleId:string;configurationHash:string;action:'pause'|'resume';nextDueAt:string}>;reviewJobs?:Array<{intentId:string;snapshotId:string;scope:import('./reviews/contracts.ts').ReviewScope}>; integrationJobs?:import('./background/job-contract.ts').IntegrationJobExtension[];sourceControls?:Array<{sourceId:string;action:'pause'|'resume';configurationHash:string}>;preserveModules?:boolean; decisionGrants?:Array<{id:string;version:number;hash:string}>; referenceSnapshot?:import('./workspace-references.ts').ReferenceSnapshot; backupRemoval?:{id:string;sha256:string;newerId:string;newerSha256:string};emptyModules?:RegisteredOwnerTable[];importSource?:{id:string;hash:string};replacements?:ModuleReplacement[];restoreEpoch?:boolean;historyImports?:Array<{id:string;source:import('./workspace-protocol.ts').JsonValue;importHash:string;sourceIdentity?:string;sourceHash?:string}>; planningAfter: Workspace; writes: GuardedWrite[]; preconditions?: RowPrecondition[]; events: AuditEventDraft[]; backup?: {reason:'restore'|'delete'|'repair'|'manual'}; jobs: JobIntent[]; }
export interface PrepareContext { historyRuntime?:{executionEpoch:()=>Promise<number>}; agentArtifact?:import('./agents/artifact-store.ts').AgentArtifactMaterial; agentRuntime?:import('./agents/command-contracts.ts').AgentCommandContext; deviceRuntime?:import('./runtime/command-contracts.ts').DeviceRuntimeContext; baselineRuntime?:{preview:(input:import('./baselines/contracts.ts').BaselinePreviewInput)=>Promise<import('./baselines/contracts.ts').BaselineRevisionPreview>}; automationRuntime?:{canResume:(schedule:import('./automations/contracts.ts').AutomationSchedule)=>Promise<boolean>}; sourceRuntime?:{state:(sourceId:string)=>Promise<import('./sources/contracts.ts').SourceSyncState|null>;canResume:(connection:import('./sources/contracts.ts').SourceConnection,target:import('./sources/contracts.ts').SourceTarget)=>Promise<boolean>};mutationId?:string; userId: string; before: WorkspaceEnvelope; command: WorkspaceCommand; now: string; query: OwnerScopedReader; backups?:{prepareFileRemoval?:(input:import('./backup-removal.ts').BackupRemoval)=>Promise<import('./automations/backup-archive-removal.ts').FileBackupRemovalControl>;get:(id:string)=>ReturnType<typeof readWorkspaceBackup>;list:()=>ReturnType<typeof listWorkspaceBackups>};readAuditGroup?:(eventId:string)=>Promise<import('./history-command-group.ts').AuditCommandGroup|null>;trustedAcceptanceRecord?:(id:string,hash:string)=>Promise<boolean>;trustedDecisionVersion?:(id:string,version:number,hash:string)=>Promise<boolean>;attachmentAccess?:{hasPhysicalIdentity?:(record:import('./evidence-contract.ts').AttachmentRecord)=>Promise<boolean>;ownerNamespace:string;store:import('./attachments.ts').BlobStore;resolveNamespace?:(record:import('./evidence-contract.ts').AttachmentRecord)=>Promise<string|null>};verifyAttachment?:(record:import('./evidence-contract.ts').AttachmentRecord)=>Promise<import('./evidence-requirements.ts').VerifiedAttachment|null>;readImport:(id:string)=>ReturnType<typeof readStagedImport>; }
export interface CommandHandler { prepare(context: PrepareContext): Promise<MutationPlan>; }
export type CommandHandlerRegistry = ReadonlyMap<string, CommandHandler>;
export interface WorkspaceTransactionDeps {
 /** Trusted server callback, evaluated only after the request's admission ticket. */
 agentArtifactAtAdmission?:()=>Promise<{now:string;material:import('./agents/artifact-store.ts').AgentArtifactMaterial;attachmentAccess?:WorkspaceTransactionDeps['attachmentAccess'];verifyAttachment?:WorkspaceTransactionDeps['verifyAttachment']}>;
 fileBackupServices?:import('./automations/backup-archive-store.ts').FileBackupServices; agentArtifact?:import('./agents/artifact-store.ts').AgentArtifactMaterial; deviceEnrollment?:import('./runtime/command-contracts.ts').DeviceEnrollmentMaterial; db: SqlDatabase; now:()=>string; handlers: CommandHandlerRegistry; verifyAttachment?:PrepareContext['verifyAttachment'];attachmentAccess?:PrepareContext['attachmentAccess']; }
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a],[b])=>a < b ? -1 : a > b ? 1 : 0).map(([key,item])=>`${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  throw new CommandValidationError('Commands must contain JSON values.');
}
export async function hashJson(value: unknown): Promise<string> { const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonicalJson(value)));return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join(''); }
function validId(value:unknown): value is string { return typeof value==='string' && /^[A-Za-z0-9_-]{16,128}$/.test(value); }
interface ReceiptRow {command_hash:string; revision:number;}
async function receipt(db:SqlDatabase,user:string,id:string) {return db.prepare('SELECT command_hash, revision FROM workspace_mutations WHERE user_id = ? AND mutation_id = ?').bind(user,id).first<ReceiptRow>();}
export async function mutationOutcome(db:SqlDatabase,user:string,id:string):Promise<MutationOutcome> {
  if (!user || !validId(id)) throw new CommandValidationError('Invalid mutation identity.');
  const epoch=await checkMutationEpoch(db,user,id);
  if(epoch.status==='retired')return {status:'retired',retryAllowed:false};
  const current=await readCurrent(db,user),found=await receipt(db,user,id);
  return found ? {status:'committed',receipt:{mutationId:id,commandHash:found.command_hash,appliedRevision:found.revision},currentRevision:current.revision} : {status:'not-found',currentRevision:current.revision};
}
/** Every side effect is guarded by a transient transaction claim, never merely a historical receipt. */
export async function executeWorkspaceCommand(userId:string,input:{protocolVersion:number;expectedRevision:number;mutationId:string;command:unknown},deps:WorkspaceTransactionDeps):Promise<CommandResult> {
  if (!userId || input.protocolVersion!==1 || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision<1 || !validId(input.mutationId)) throw new CommandValidationError('A valid command envelope is required.');
  return withWorkspaceAdmission(userId,async()=>{
    if(!deps.agentArtifactAtAdmission)return executeWorkspaceCommandAdmitted(userId,input,deps);
    const commandType=(input.command as {type?:unknown}|null)?.type;
    if(commandType!=='jobs.artifact.reserve'&&commandType!=='jobs.artifact.finalize')throw new CommandValidationError('Fresh artifact authorization is limited to artifact commands.');
    const refreshed=await deps.agentArtifactAtAdmission();
    if(!Number.isFinite(Date.parse(refreshed.now)))throw new CommandValidationError('Fresh artifact authorization requires a valid server clock.');
    return executeWorkspaceCommandAdmitted(userId,input,{...deps,agentArtifactAtAdmission:undefined,agentArtifact:refreshed.material,attachmentAccess:refreshed.attachmentAccess,verifyAttachment:refreshed.verifyAttachment,now:()=>refreshed.now});
  });
}
async function executeWorkspaceCommandAdmitted(userId:string,input:{protocolVersion:number;expectedRevision:number;mutationId:string;command:unknown},deps:WorkspaceTransactionDeps):Promise<CommandResult> {
  if (!userId || input.protocolVersion!==1 || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision<1 || !validId(input.mutationId)) throw new CommandValidationError('A valid command envelope is required.');
  const {db}=deps,revision=input.expectedRevision,id=input.mutationId,now=deps.now();
  if (!input.command || typeof input.command!=='object' || Array.isArray(input.command) || typeof (input.command as {type?:unknown}).type!=='string') throw new CommandValidationError('A command type is required.');
  const command=input.command as WorkspaceCommand;
  const hash=await hashJson({protocolVersion:1,command});
  // Existing v2 receipts used the command-only hash; preserve their replay semantics.
  const legacyHash=await hashJson(command);
  const checkReceipt=async ():Promise<CommandResult|null>=>{const prior=await receipt(db,userId,id);if(!prior)return null;if(prior.command_hash!==hash && prior.command_hash!==legacyHash)throw new MutationIdReuseError('This mutation ID was reused for a different change.');return {status:'replayed',envelope:await readCurrent(db,userId,now),receipt:{mutationId:id,commandHash:prior.command_hash,appliedRevision:prior.revision}};};
  // One statement freezes the epoch, receipt and revision head together.
  // Later failure reconciliation and every atomic compiler guard stay intact.
  const admission=await readMutationAdmission(db,userId,id),epoch=admission.epoch;
  const decision=classifyMutationAdmission(admission,{commandHash:hash,legacyHash,expectedRevision:revision});
  if(decision.status==='retired')throw new RetiredMutationError('This mutation epoch is retired.');
  if(decision.status==='replayed')return {status:'replayed',envelope:await readCurrent(db,userId,now),receipt:{mutationId:id,commandHash:decision.receipt.command_hash,appliedRevision:decision.receipt.revision}};
  if(decision.status==='conflict')return {status:'conflict',currentRevision:decision.currentRevision};
  const {before,capture:planningCapture,readReceiptCount}=await capturePlanningPreflight(db,userId,{now,mutationId:id,expectedRevision:revision});if(before.revision!==revision)return {status:'conflict',currentRevision:before.revision};
  if(readReceiptCount()>=RECEIPT_CAPACITY.hard)throw new WorkspaceCapacityError();
  const handler=deps.handlers.get(command.type);if(!handler)throw new CommandValidationError('Unknown command.');
  let plan:MutationPlan;
  try {plan=await handler.prepare(ownerPrepareContext(db,userId,before,command,now,{attachmentAccess:deps.attachmentAccess,verifyAttachment:deps.verifyAttachment,deviceEnrollment:deps.deviceEnrollment,agentArtifact:deps.agentArtifact,fileBackupServices:deps.fileBackupServices},id));plan.planningAfter=parseWorkspaceExport(plan.planningAfter,now);}
  catch(error){throw new CommandValidationError(error instanceof Error?error.message:'This change is invalid.');}
  let normalizedMerge:NormalizedMergeControl|null=null;
  if(plan.normalizedMerge!==undefined){try{normalizedMerge=await validateNormalizedMergePlan(db,userId,revision,command,plan);plan.normalizedMerge=normalizedMerge;}catch(error){throw error instanceof CommandValidationError?error:new CommandValidationError('Invalid normalized merge control.');}}
  if(plan.attachmentMetadataDiscard!==undefined){try{await validateAttachmentMetadataDiscard(db,userId,command,plan,before.workspace);}catch(error){throw error instanceof CommandValidationError?error:new CommandValidationError('Invalid attachment metadata discard.');}}
  if(plan.fileBackupRemoval){
    const proof=fileBackupRemovalControlSchema.parse(plan.fileBackupRemoval),removal=plan.backupRemoval;
    if(command.type!=='workspace.backup.remove'||!removal||proof.selected.logical.id!==removal.id||proof.selected.logical.sha256!==removal.sha256||proof.newer.logical.id!==removal.newerId||proof.newer.logical.sha256!==removal.newerSha256||plan.writes.length||plan.jobs.length||plan.restoreEpoch||plan.replacements?.length||canonicalJson(plan.planningAfter)!==canonicalJson(before.workspace))throw new CommandValidationError('File backup removal requires one exact owner-reviewed recovery pair.');
  }
  const agentArtifact=await validateAgentArtifactPlan(db,userId,command,plan,before.workspace,deps.agentArtifact,now,id);
  if(plan.preserveModules && (command.type!=='workspace.import.commit'||command.mode!=='merge'||plan.replacements?.length||plan.writes.length||!plan.restoreEpoch||plan.backup?.reason!=='restore'||!plan.referenceSnapshot))throw new CommandValidationError('Only a reviewed planning merge may preserve normalized modules.');
  if(plan.backup?.reason==='restore'&&!plan.preserveModules&&!normalizedMerge){const query=ownerReader(db,userId);for(const table of OWNER_TABLES)if((await query.list(table,{limit:1})).length && !plan.replacements?.some(replacement=>replacement.table===table))throw new CommandValidationError('This restore requires a complete normalized bundle. Export all modules before replacing planning records.');}
  if(plan.writes.length>200 || plan.events.length>200 || plan.jobs.length>50)throw new CommandValidationError('Command batch is too large.');
  if(plan.restoreEpoch && (!plan.backup || plan.jobs.length))throw new CommandValidationError('Recovery must retain a backup and cannot dispatch new jobs.');
  if(new Set((plan.replacements??[]).map(replacement=>replacement.table)).size!==(plan.replacements??[]).length)throw new CommandValidationError('Duplicate replacement module.');
  for(const replacement of plan.replacements??[]){ownerTable(replacement.table);if(plan.backup?.reason!=='restore' || !plan.restoreEpoch)throw new CommandValidationError('Module replacement requires reviewed recovery authority.');if(plan.writes.some(write=>write.table===replacement.table) || replacement.beforeRows.length>10000 || replacement.records.length>10000)throw new CommandValidationError('Invalid replacement scope.');}
  // Preserve command validation and conflict semantics before serializing a prospective image.
  for(const event of plan.events)if(event.actorId!==userId||event.origin!==(agentArtifact?'connector':'owner')||event.occurredAt!==now)throw new CommandValidationError('Owner event authority is invalid.');
  const preparationReader=ownerReader(db,userId);
  for(const pre of plan.preconditions??[]){const row=await preparationReader.get(pre.table,pre.id);if(!row||row.row_revision!==pre.expectedRowRevision||pre.expectedHash!==undefined&&row.content_hash!==pre.expectedHash)throw new ModuleConflictError('An accepted source changed. Refresh and review again.');}
  for(const write of plan.writes){if(IMMUTABLE_MODULE_TABLES.has(write.table)&&write.operation!=='insert')throw new CommandValidationError('Immutable history cannot be updated or deleted.');const row=await preparationReader.get(write.table,write.id);if(write.operation==='insert'?Boolean(row):!row||row.row_revision!==write.expectedRowRevision)throw new ModuleConflictError('A related record changed. Refresh and review again.');}
  const {measureProspectiveRecoverability}=await import('./recoverability-snapshot.ts');
  let agentTerminalReserveDelta=plan.agentControls?.action==='approve'?1:0;
  if(plan.agentControls?.action==='cancel'||plan.agentControls?.action==='reject'){const state=await db.prepare("SELECT status,approval_id FROM agent_job_state WHERE user_id=? AND job_id=?").bind(userId,plan.agentControls.jobId).first<{status:string;approval_id:string|null}>();if(state?.status==='queued'&&state.approval_id)agentTerminalReserveDelta=-1;}
  if(plan.restoreEpoch){const count=await db.prepare("SELECT COUNT(*) AS count FROM agent_job_state WHERE user_id=? AND status='queued' AND approval_id IS NOT NULL").bind(userId).first<{count:number}>();agentTerminalReserveDelta=-(count?.count??0);}
  let recovery:Awaited<ReturnType<typeof measureProspectiveRecoverability>>;
  try{recovery=await measureProspectiveRecoverability(db,userId,{now,planningCapture,agentTerminalReserveDelta,planningAfter:plan.planningAfter,writes:plan.writes,replacements:plan.replacements,events:plan.events,historyImports:plan.historyImports});}
  catch(error){if((await checkMutationEpoch(db,userId,id)).status==='retired')throw new RetiredMutationError('This mutation epoch is retired.');const concurrentReplay=await checkReceipt();if(concurrentReplay)return concurrentReplay;const current=await readCurrent(db,userId,now);if(current.revision!==revision)return {status:'conflict',currentRevision:current.revision};throw error;}
  if(!recovery.measurement.allowed){if(plan.replacements?.length||plan.historyImports?.length)throw new CommandValidationError('Reviewed import exceeds the verified atomic recovery capacity.');throw new RecoverabilityCapacityError();}
  let preparedBackup:Awaited<ReturnType<typeof prepareWorkspaceBackup>>|null=null;
  try { if(plan.backup)preparedBackup=await prepareWorkspaceBackup(db,userId,before,plan.backup.reason,now); }
  catch(error){
    if((await checkMutationEpoch(db,userId,id)).status==='retired')throw new RetiredMutationError('This mutation epoch is retired.');
    const concurrentReplay=await checkReceipt();if(concurrentReplay)return concurrentReplay;
    const current=await readCurrent(db,userId,now);if(current.revision!==revision)return {status:'conflict',currentRevision:current.revision};
    if(await receiptCount(db,userId)>=RECEIPT_CAPACITY.hard)throw new WorkspaceCapacityError();
    throw error;
  }
  const privateQuote=await workspacePrivateCapacityGrowth(db,userId,{plan,before,command,mutationId:id,commandHash:hash,now,preparedBackup,agentArtifact});
  let privateCapacity:Awaited<ReturnType<typeof privateCapacityGuard>>;
  try{privateCapacity=await privateCapacityGuard(db,userId,{schemaContext:privateQuote.schemaContext,growth:privateQuote.growth,firstCancelAttemptIds:privateQuote.firstCancelAttemptIds,firstRevokeDeviceIds:privateQuote.firstRevokeDeviceIds});}
  catch(error){
    if((await checkMutationEpoch(db,userId,id)).status==='retired')throw new RetiredMutationError('This mutation epoch is retired.');
    const concurrentReplay=await checkReceipt();if(concurrentReplay)return concurrentReplay;
    const current=await readCurrent(db,userId,now);if(current.revision!==revision)return {status:'conflict',currentRevision:current.revision};
    throw error;
  }
  const claim='EXISTS (SELECT 1 FROM workspace_command_guards WHERE user_id = ? AND mutation_id = ? AND claim_token = ?)';
  const token=crypto.randomUUID(),guard=[userId,id,token];
  const statements:SqlStatement[]=[db.prepare(`INSERT INTO workspace_command_guards (user_id,mutation_id,claim_token,valid) SELECT ?,?,?,1 FROM workspaces WHERE user_id = ? AND revision = ? AND NOT EXISTS (SELECT 1 FROM workspace_mutations WHERE user_id = ? AND mutation_id = ?)${epoch.status==='active'?" AND EXISTS (SELECT 1 FROM workspace_mutation_epochs WHERE user_id = ? AND epoch = ? AND status = 'active')":''}`).bind(...guard,userId,revision,userId,id,...(epoch.status==='active'?[userId,epoch.epoch]:[]))];
  const assertion=(condition:string,values:(string|number|null)[])=>statements.push(db.prepare(`INSERT INTO workspace_assertions (user_id,mutation_id,valid) SELECT ?,?,CASE WHEN ${condition} THEN 1 ELSE 0 END WHERE ${claim}`).bind(userId,id,...values,...guard));
  // These are the original contiguous pre-write assertions, in the same order.
  // Keep the three native-calibrated twelve-table groups unchanged. Combining
  // only their prefix/suffix reduces prepare/bind calls without crossing a DML
  // barrier, dropping a predicate or replacing the authoritative atomic claim.
  const recoveryChecks=recoverabilityConditions(userId,id,recovery,guard),boundary=recoveryChecks[0],hasTerminalReserve=Boolean(recovery.agentTerminalReserveRows);
  const rowChecks=recoveryChecks.slice(1,hasTerminalReserve?-1:undefined),terminal=hasTerminalReserve?recoveryChecks.at(-1):undefined;
  const prefix=[privateCapacity,...privateQuote.guards,...(agentArtifact?[agentArtifact.material.guard]:[]),boundary];
  const suffix=[...(terminal?[terminal]:[]),{sql:'(SELECT COUNT(*) FROM workspace_mutations WHERE user_id=?) < ?',bindings:[userId,RECEIPT_CAPACITY.hard]}];
  // Extended private/artifact prefixes retain their original statement shape;
  // only the native-calibrated capacity/schema/boundary prefix is combined.
  const prefixChecks=!agentArtifact&&privateQuote.guards.length===1?combineClaimConditions(userId,id,claim,guard,prefix):prefix;
  statements.push(...prepareClaimAssertions(db,userId,id,claim,guard,prefixChecks));
  statements.push(...prepareClaimAssertions(db,userId,id,claim,guard,rowChecks));
  statements.push(...prepareClaimAssertions(db,userId,id,claim,guard,combineClaimConditions(userId,id,claim,guard,suffix)));
  if(plan.referenceSnapshot){
    const snapshot=plan.referenceSnapshot;
    if(snapshot.coveredModules.length!==OWNER_TABLES.length || new Set(snapshot.coveredModules).size!==OWNER_TABLES.length)throw new CommandValidationError('Incomplete reference snapshot.');
    for(const table of snapshot.coveredModules){
      ownerTable(table);const rows=snapshot.rows.filter(row=>row.module===table).map(row=>({id:row.id,row_revision:row.rowRevision,content_hash:row.contentHash}));
      if(rows.length>10000 || new Set(rows.map(row=>row.id)).size!==rows.length)throw new CommandValidationError('Invalid reference snapshot.');
      const payload=canonicalJson(rows);if(new TextEncoder().encode(payload).length>RECOVERABILITY_SQL_ARGUMENT_BYTES)throw new CommandValidationError('Reference assertions exceed atomic statement limit.');
      assertion(`(SELECT COUNT(*) FROM ${table} WHERE user_id=?) = ? AND NOT EXISTS (SELECT id,row_revision,content_hash FROM ${table} WHERE user_id=? EXCEPT SELECT json_extract(value,'$.id'),json_extract(value,'$.row_revision'),json_extract(value,'$.content_hash') FROM json_each(?))`,[userId,rows.length,userId,payload]);
    }
  }
  if(plan.historyRemovalRows){
    const rows=plan.historyRemovalRows,payload=canonicalJson(rows);
    if(command.type!=='history.source.remove'||rows.length>10000||new TextEncoder().encode(payload).length>RECOVERABILITY_SQL_ARGUMENT_BYTES)throw new CommandValidationError('Invalid history removal snapshot.');
    assertion(`(SELECT COUNT(*) FROM project_history WHERE user_id=?)=? AND NOT EXISTS(SELECT id,row_revision,content_hash FROM project_history WHERE user_id=? EXCEPT SELECT json_extract(value,'$.id'),json_extract(value,'$.row_revision'),json_extract(value,'$.content_hash') FROM json_each(?))`,[userId,rows.length,userId,payload]);
  }
  // Native source commands bind their new source boundary to the current
  // execution epoch. A restore racing preparation cannot install an obsolete
  // source or enqueue cleanup against a different execution authority.
  if(command.type.startsWith('history.source.'))for(const write of plan.writes)if(write.table==='project_history'&&write.operation!=='delete'){
    const record=parseHistoryRecord(write.value);
    if(record.kind==='source')assertion('COALESCE((SELECT epoch FROM workspace_execution_state WHERE user_id=?),0)=?',[userId,record.value.executionEpoch]);
  }
  for(const pre of plan.preconditions??[]){const table=ownerTable(pre.table);assertion(`EXISTS (SELECT 1 FROM ${table} WHERE user_id = ? AND id = ? AND row_revision = ?${pre.expectedHash===undefined?'':' AND content_hash = ?'})`,[userId,pre.id,pre.expectedRowRevision,...(pre.expectedHash===undefined?[]:[pre.expectedHash])]);}
  for(const grant of plan.decisionGrants??[])assertion('EXISTS (SELECT 1 FROM decision_owner_grants WHERE user_id=? AND decision_id=? AND version=? AND content_hash=?)',[userId,grant.id,grant.version,grant.hash]);
  if(plan.backupRemoval){if(plan.fileBackupRemoval)statements.push(...fileBackupRemovalStatements(db,userId,plan.fileBackupRemoval,now,claim,guard,id));else assertion('NOT EXISTS(SELECT 1 FROM backup_archives WHERE user_id=? AND id=?)',[userId,plan.backupRemoval.id]);const removal=plan.backupRemoval;assertion(`EXISTS (SELECT 1 FROM workspace_backups old JOIN workspace_backups newer ON newer.user_id=old.user_id WHERE old.user_id=? AND old.id=? AND old.sha256=? AND old.status='ready' AND newer.id=? AND newer.sha256=? AND newer.status='ready' AND (newer.source_revision>old.source_revision OR (newer.source_revision=old.source_revision AND newer.created_at>old.created_at)))`,[userId,removal.id,removal.sha256,removal.newerId,removal.newerSha256]);}
  for(const table of plan.emptyModules??[])assertion(`NOT EXISTS (SELECT 1 FROM ${ownerTable(table)} WHERE user_id=?)`,[userId]);
  if(plan.importSource)assertion('EXISTS (SELECT 1 FROM workspace_imports WHERE user_id=? AND id=? AND content_hash=? AND expires_at>?)',[userId,plan.importSource.id,plan.importSource.hash,now]);
  if(normalizedMerge)statements.push(...normalizedMergeAttachmentAssertions(db,userId,id,normalizedMerge,plan.importSource!,revision,now,claim,guard));
  if(plan.attachmentMetadataDiscard)assertion('NOT EXISTS (SELECT 1 FROM attachment_blob_objects WHERE user_id=? AND attachment_id=?)',[userId,plan.attachmentMetadataDiscard.id]);
  const replacementPayloads=new Map<RegisteredOwnerTable,string>();
  for(const replacement of plan.replacements??[]){
    const table=ownerTable(replacement.table);
    if(new Set(replacement.beforeRows.map(row=>row.id)).size!==replacement.beforeRows.length || new Set(replacement.records.map(row=>row.id)).size!==replacement.records.length)throw new CommandValidationError('Duplicate replacement identity.');
    const beforeRows=canonicalJson(replacement.beforeRows.map(({id,row_revision,content_hash})=>({id,row_revision,content_hash})));
    if(new TextEncoder().encode(beforeRows).length>RECOVERABILITY_SQL_ARGUMENT_BYTES)throw new CommandValidationError('Replacement preconditions exceed the atomic statement limit.');
    assertion(`(SELECT COUNT(*) FROM ${table} WHERE user_id=?) = ? AND NOT EXISTS (SELECT id,row_revision,content_hash FROM ${table} WHERE user_id=? EXCEPT SELECT json_extract(value,'$.id'),json_extract(value,'$.row_revision'),json_extract(value,'$.content_hash') FROM json_each(?))`,[userId,replacement.beforeRows.length,userId,beforeRows]);
    const beforeIndex=new Map(replacement.beforeRows.map(row=>[row.id,row.row_revision]));
    const rows=[];
    for(const row of replacement.records){if(!row.id || row.id.length>128)throw new CommandValidationError('Invalid imported module identity.');rows.push({id:row.id,row_revision:(beforeIndex.get(row.id)??0)+1,payload_json:canonicalJson(row.value),content_hash:await hashJson(row.value),...await moduleProjection(table,row.id,row.value)});}
    const payload=canonicalJson(rows);if(new TextEncoder().encode(payload).length>RECOVERABILITY_SQL_ARGUMENT_BYTES)throw new CommandValidationError('Replacement rows exceed the atomic statement limit.');replacementPayloads.set(table,payload);
  }
  for(const write of plan.writes){const table=ownerTable(write.table);if(IMMUTABLE_MODULE_TABLES.has(table)&&write.operation!=='insert')throw new CommandValidationError('Immutable versions and acceptance records cannot be rewritten.');if(!write.id || write.id.length>128)throw new CommandValidationError('Invalid module record ID.');
    if(write.operation==='insert'){if(write.expectedRowRevision!==null)throw new CommandValidationError('Insert must require an absent row.');assertion(`NOT EXISTS (SELECT 1 FROM ${table} WHERE user_id = ? AND id = ?)`,[userId,write.id]);}
    else {if(!Number.isSafeInteger(write.expectedRowRevision) || (write.expectedRowRevision??0)<1)throw new CommandValidationError('Module revision is required.');assertion(`EXISTS (SELECT 1 FROM ${table} WHERE user_id = ? AND id = ? AND row_revision = ?)`,[userId,write.id,write.expectedRowRevision]);}
  }
  if(plan.writes.some(write=>write.table==='automation_schedules'&&write.operation==='insert'))assertion('(SELECT COUNT(*) FROM automation_schedules WHERE user_id=?) + ? <= 100',[userId,plan.writes.filter(write=>write.table==='automation_schedules'&&write.operation==='insert').length]);
  // At most one operation per row avoids order-dependent hidden changes.
  if(new Set(plan.writes.map(w=>`${w.table}:${w.id}`)).size!==plan.writes.length)throw new CommandValidationError('A module row may change only once in one command.');
  statements.push(db.prepare(`INSERT INTO workspace_mutations (user_id,mutation_id,command_hash,revision,committed_at) SELECT ?,?,?,?,? WHERE ${claim}`).bind(userId,id,hash,revision+1,now,...guard));
  if(preparedBackup){
    const quota=backupQuotaGuard(userId,preparedBackup.manifest.bytes,1);assertion(quota.sql,quota.bindings);
    assertion('(SELECT COUNT(*) FROM workspace_backups WHERE user_id = ?) < ? AND (SELECT COALESCE(SUM(bytes),0) FROM workspace_backups WHERE user_id = ?) + ? <= ?',[userId,BACKUP_LIMITS.snapshots,userId,preparedBackup.manifest.bytes,BACKUP_LIMITS.ownerBytes]);
    const backup=preparedBackup.manifest;
    statements.push(db.prepare(`INSERT INTO workspace_backups (user_id,id,source_revision,created_at,reason,bytes,sha256,content,status,pinned) SELECT ?,?,?,?,?,?,?,?,'ready',? WHERE ${claim}`).bind(userId,backup.id,before.revision,now,backup.reason,backup.bytes,backup.sha256,preparedBackup.content,backup.reason==='manual'?1:0,...guard));
  }
  if(plan.backup?.reason==='restore'){
    // Until normalized restore is enabled, reject snapshots that would omit normalized records.
    for(const table of (plan.preserveModules||normalizedMerge)?[]:OWNER_TABLES)if(!plan.replacements?.some(replacement=>replacement.table===table))assertion(`NOT EXISTS (SELECT 1 FROM ${table} WHERE user_id = ?)`,[userId]);
    statements.push(db.prepare(`INSERT INTO workspace_recovery (user_id,content,revision,updated_at) SELECT user_id,content,revision,updated_at FROM workspaces WHERE user_id = ? AND ${claim} ON CONFLICT(user_id) DO UPDATE SET content=excluded.content,revision=excluded.revision,updated_at=excluded.updated_at`).bind(userId,...guard));
  }
  if(plan.backupRemoval)statements.push(db.prepare(`DELETE FROM workspace_backups WHERE user_id=? AND id=? AND sha256=? AND ${claim}`).bind(userId,plan.backupRemoval.id,plan.backupRemoval.sha256,...guard));
  // Device capabilities are never restored from portable history. Clear the private
  // telemetry plane before replacing device parents; frozen selected evidence remains portable.
  if(plan.restoreEpoch)for(const table of ['runtime_observations','device_heartbeats','device_live_windows','device_sessions','runtime_latest','runtime_minute_aggregates','device_credentials','device_enrollments','device_runtime'])statements.push(db.prepare(`DELETE FROM ${table} WHERE user_id=? AND ${claim}`).bind(userId,...guard));
  // Delete children first, then restore parents first. Each statement shares the claim.
  for(const table of [...OWNER_TABLES].reverse())if(replacementPayloads.has(table))statements.push(db.prepare(`DELETE FROM ${table} WHERE user_id=? AND ${claim}`).bind(userId,...guard));
  for(const table of OWNER_TABLES){const payload=replacementPayloads.get(table);if(payload===undefined)continue;
    const columns=['id','row_revision','payload_json','content_hash',...moduleColumnNames(table)];
    statements.push(db.prepare(`INSERT INTO ${table} (user_id,${columns.join(',')}) SELECT ?,${columns.map(column=>`json_extract(value,'$.${column}')`).join(',')} FROM json_each(?) WHERE ${claim}`).bind(userId,payload,...guard));
  }
  if(plan.restoreEpoch){
    if(!plan.preserveModules&&!normalizedMerge){
    statements.push(db.prepare(`DELETE FROM acceptance_owner_grants WHERE user_id=? AND ${claim}`).bind(userId,...guard));
    // Restored decision history is a claim, never a resurrected current exception grant.
    statements.push(db.prepare(`DELETE FROM decision_owner_grants WHERE user_id=? AND ${claim}`).bind(userId,...guard));
    }
    statements.push(db.prepare(`INSERT INTO workspace_execution_state (user_id,epoch,restored_at) SELECT ?,1,? WHERE ${claim} ON CONFLICT(user_id) DO UPDATE SET epoch=workspace_execution_state.epoch+1,restored_at=excluded.restored_at`).bind(userId,now,...guard));
    statements.push(db.prepare(`UPDATE workspace_job_intents SET status=CASE WHEN status='pending' THEN 'cancelled' ELSE status END,cancel_requested=CASE WHEN status IN ('running','claimed') THEN 1 ELSE cancel_requested END WHERE user_id=? AND ${claim}`).bind(userId,...guard));
  }
  for(const job of plan.jobs.filter(item=>item.kind==='agent.execute')){if(job.kind==='agent.execute'&&(plan.agentControls?.action!=='create'||job.id!==plan.agentControls.record.intentId))throw new CommandValidationError('Agent intent requires one exact immutable proposal.');statements.push(db.prepare(`INSERT INTO workspace_job_intents (user_id,id,kind,dedupe_key,payload_json,not_before,status,execution_epoch,cancel_requested) SELECT ?,?,?,?,?,?,?,COALESCE((SELECT epoch FROM workspace_execution_state WHERE user_id=?),0),0 WHERE ${claim}`).bind(userId,job.id,job.kind,job.dedupeKey,canonicalJson(job.payload),job.notBefore,job.kind==='agent.execute'?'awaiting_approval':'pending',userId,...guard));}
  // Dependency ordering for inserts is fixed by the closed registry; requests never choose SQL order.
  for(const write of [...plan.writes].sort((a,b)=>OWNER_TABLES.indexOf(a.table)-OWNER_TABLES.indexOf(b.table))){const table=ownerTable(write.table);
    if(write.operation==='insert'||write.operation==='update'){
      const projection=await moduleProjection(table,write.id,write.value!);const names=moduleColumnNames(table);const values=names.map(name=>projection[name]);
      if(write.operation==='insert')statements.push(db.prepare(`INSERT INTO ${table} (user_id,id,row_revision,payload_json,content_hash${names.length?','+names.join(','):''}) SELECT ?,?,1,?,?${names.map(()=>',?').join('')} WHERE ${claim}`).bind(userId,write.id,canonicalJson(write.value),await hashJson(write.value),...values,...guard));
      else statements.push(db.prepare(`UPDATE ${table} SET row_revision=row_revision+1,payload_json=?,content_hash=?${names.map(name=>`,${name}=?`).join('')} WHERE user_id=? AND id=? AND row_revision=? AND ${claim}`).bind(canonicalJson(write.value),await hashJson(write.value),...values,userId,write.id,write.expectedRowRevision,...guard));
    }
    else if(write.operation==='delete')statements.push(db.prepare(`DELETE FROM ${table} WHERE user_id=? AND id=? AND row_revision=? AND ${claim}`).bind(userId,write.id,write.expectedRowRevision,...guard));
    else throw new CommandValidationError('Unknown module operation.');
  }
  if((normalizedMerge&&plan.writes.some(write=>write.table==='attachments'))||plan.attachmentMetadataDiscard)assertion("EXISTS(SELECT 1 FROM attachment_usage q WHERE q.user_id=? AND q.id='quota' AND json_extract(q.payload_json,'$.files')=(SELECT COUNT(*) FROM attachments WHERE user_id=? AND status<>'deleted') AND json_extract(q.payload_json,'$.bytes')=(SELECT COALESCE(SUM(expected_bytes),0) FROM attachments WHERE user_id=? AND status<>'deleted'))",[userId,userId,userId]);
  if(command.type==='attachment.reserve'||command.type==='jobs.artifact.reserve')for(const write of plan.writes)if(write.table==='attachments'&&write.operation==='insert'){
    const value=write.value as unknown as {id:string;storageKey:string;expectedBytes:number;createdAt:string};
    assertion("EXISTS (SELECT 1 FROM workspace_source_namespaces WHERE user_id=? AND ?='attachments/'||blob_namespace||'/'||?)",[userId,value.storageKey,value.id]);
    statements.push(db.prepare(`INSERT INTO attachment_blob_objects(user_id,storage_key,attachment_id,namespace,bytes,sha256,created_at,verified_at,purged_at) SELECT ?,?,?,blob_namespace,?,NULL,?,NULL,NULL FROM workspace_source_namespaces WHERE user_id=? AND ${claim}`).bind(userId,value.storageKey,value.id,value.expectedBytes,value.createdAt,userId,...guard));
    assertion('(SELECT COUNT(*) FROM attachment_blob_objects WHERE user_id=? AND purged_at IS NULL)<=500 AND (SELECT COALESCE(SUM(bytes),0) FROM attachment_blob_objects WHERE user_id=? AND purged_at IS NULL)<=209715200',[userId,userId]);
  }
  // Only the actual verified finalize command can establish immutable physical identity.
  // Imported metadata never grants digest authority to an ordinary reservation.
  if(command.type==='attachment.finalize'||command.type==='jobs.artifact.finalize')for(const write of plan.writes)if(write.table==='attachments'&&write.operation==='update'){
    const value=write.value as unknown as {id:string;storageKey:string;expectedBytes:number;sha256:string|null;readyAt:string|null;status:string};
    if(value.status!=='ready'||!value.sha256||!value.readyAt)throw new CommandValidationError('Finalization requires verified attachment identity.');
    assertion('EXISTS (SELECT 1 FROM attachment_blob_objects WHERE user_id=? AND storage_key=? AND attachment_id=? AND bytes=? AND purged_at IS NULL AND (sha256 IS NULL OR sha256=?))',[userId,value.storageKey,value.id,value.expectedBytes,value.sha256]);
    statements.push(db.prepare(`UPDATE attachment_blob_objects SET sha256=?,verified_at=COALESCE(verified_at,?) WHERE user_id=? AND storage_key=? AND attachment_id=? AND bytes=? AND purged_at IS NULL AND (sha256 IS NULL OR sha256=?) AND ${claim}`).bind(value.sha256,value.readyAt,userId,value.storageKey,value.id,value.expectedBytes,value.sha256,...guard));
  }
  if(agentArtifact){
    const {material,record}=agentArtifact;
    if(command.type==='jobs.artifact.reserve'){
      assertion('NOT EXISTS(SELECT 1 FROM agent_artifacts WHERE user_id=? AND artifact_id=?)',[userId,record.id]);
      assertion('(SELECT COUNT(*) FROM agent_artifacts WHERE user_id=? AND attempt_id=?)<100 AND (SELECT COALESCE(SUM(bytes),0) FROM agent_artifacts WHERE user_id=? AND attempt_id=?)+?<=10485760',[userId,material.attemptId,userId,material.attemptId,material.bytes]);
      statements.push(db.prepare(`INSERT INTO agent_artifacts(user_id,attempt_id,artifact_id,logical_type,sha256,bytes,created_at) SELECT ?,?,?,?,?,?,? WHERE ${claim}`).bind(userId,material.attemptId,record.id,material.logicalType,material.sha256,material.bytes,now,...guard));
    }else assertion('EXISTS(SELECT 1 FROM agent_artifacts WHERE user_id=? AND attempt_id=? AND artifact_id=? AND logical_type=? AND sha256=? AND bytes=?)',[userId,material.attemptId,record.id,material.logicalType,material.sha256,material.bytes]);
  }
  statements.push(...await sourceControlStatements(db,userId,plan,command.type,claim,guard,now,before.workspace));
  // Permanent cleanup fences are private authority, including after full module replacement.
  // Every current or historical reference must remain unable to revive a fenced key.
  const generationReview={id:'generation_review.id',hash:'generation_review.hash',targetRevision:'generation_review.revision',now:'generation_review.now'};
  const generationFields={owner:'a.user_id',attachmentId:'a.id',storageKey:'a.storage_key',bytes:'a.expected_bytes',sha256:'a.sha256'};
  const generationAllowed=attachmentGenerationSql(generationFields,generationReview);
  const generationReviewValues=[plan.importSource?.id??'',plan.importSource?.hash??'',revision,now];
  const generationReviewSource='(SELECT ? AS id,? AS hash,? AS revision,? AS now) generation_review';
  // Materialize the proof separately from the assertion expression: deployed D1 limits
  // expression depth to 100, below the desktop SQLite default used by unit fixtures.
  const generationCte=`WITH admitted_generations AS MATERIALIZED (SELECT a.user_id,a.id,a.storage_key FROM attachments a CROSS JOIN ${generationReviewSource} WHERE a.user_id=? AND a.status='ready' AND ${generationAllowed})`;
  const generationConditions=[
    {sql:`NOT EXISTS (SELECT 1 FROM attachments a JOIN attachment_blob_fences f ON f.user_id=a.user_id AND (f.attachment_id=a.id OR f.storage_key=a.storage_key) LEFT JOIN admitted_generations admitted ON admitted.user_id=a.user_id AND admitted.id=a.id AND admitted.storage_key=a.storage_key WHERE a.user_id=? AND a.status IN ('reserved','ready') AND (f.storage_key=a.storage_key OR admitted.id IS NULL))`,bindings:[userId]},
    {sql:`NOT EXISTS (SELECT 1 FROM evidence_versions e JOIN json_each(e.payload_json,'$.attachmentIds') ref JOIN attachment_blob_fences f ON f.user_id=e.user_id AND f.attachment_id=ref.value LEFT JOIN admitted_generations admitted ON admitted.user_id=e.user_id AND admitted.id=ref.value WHERE e.user_id=? AND admitted.id IS NULL)`,bindings:[userId]},
  ];
  // Newly staged private namespaces become readable only in the exact reviewed import transaction.
  const stagedNamespace={sql:`NOT EXISTS (SELECT 1 FROM attachments a JOIN attachment_blob_namespaces n ON n.user_id=a.user_id AND a.storage_key='attachments/'||n.namespace||'/'||a.id WHERE a.user_id=? AND a.status='ready' AND NOT EXISTS (SELECT 1 FROM attachment_blob_objects o JOIN attachment_archive_stages s ON s.user_id=o.user_id AND s.namespace=o.namespace WHERE o.user_id=a.user_id AND o.storage_key=a.storage_key AND o.attachment_id=a.id AND o.bytes=a.expected_bytes AND o.sha256=a.sha256 AND o.verified_at IS NOT NULL AND o.purged_at IS NULL AND NOT EXISTS(SELECT 1 FROM attachment_archive_cleanup_claims c WHERE c.storage_key=o.storage_key) AND (s.status='committed' OR (s.status='verified' AND s.import_id=? AND s.import_hash=? AND s.target_revision=? AND s.expires_at>?))))`,bindings:[userId,plan.importSource?.id??'',plan.importSource?.hash??'',revision,now]};
  statements.push(...generationAssertionStatements(db,{cte:generationCte,cteBindings:[...generationReviewValues,userId],owner:userId,mutationId:id,claim,guard,conditions:generationConditions,...(!preparedBackup?{stagedNamespace}:{})}));
  if(preparedBackup){
    const bundle=JSON.parse(preparedBackup.content) as {modules:{attachments?:{records:Array<{id:string;value:{status?:string;storageKey?:string;expectedBytes?:number;sha256?:string|null}}>}}};
    // A deleted tombstone is not a promise of retained file bytes. Unknown legacy rows already fail closed in cleanup.
    for(const row of bundle.modules.attachments?.records??[])if(row.value.status!=='deleted'){
      const value=row.value;
      if(value.status==='ready'&&value.storageKey&&value.sha256&&Number.isSafeInteger(value.expectedBytes)){
        const generation=attachmentGenerationPredicate(userId,{attachmentId:row.id,storageKey:value.storageKey,bytes:value.expectedBytes!,sha256:value.sha256});
        assertion(`NOT EXISTS (SELECT 1 FROM attachment_blob_fences WHERE user_id=? AND (attachment_id=? OR storage_key=?)) OR ${generation.sql}`,[userId,row.id,value.storageKey,...generation.bindings]);
      }else assertion('NOT EXISTS (SELECT 1 FROM attachment_blob_fences WHERE user_id=? AND (attachment_id=? OR storage_key=?))',[userId,row.id,value.storageKey??'']);
    }
  }
  if(preparedBackup)assertion(stagedNamespace.sql,stagedNamespace.bindings);
  if(plan.importSource){
    assertion("NOT EXISTS (SELECT 1 FROM attachment_archive_stages WHERE user_id=? AND import_id=? AND (import_hash<>? OR status<>'verified' OR target_revision<>? OR expires_at<=?))",[userId,plan.importSource.id,plan.importSource.hash,revision,now]);
    statements.push(db.prepare(`UPDATE attachment_archive_stages SET status='committed' WHERE user_id=? AND import_id=? AND import_hash=? AND status='verified' AND target_revision=? AND expires_at>? AND ${claim}`).bind(userId,plan.importSource.id,plan.importSource.hash,revision,now,...guard));
  }
  // These native grants describe the CURRENT mutable pointer payload. Prior
  // owner changes remain in audit; obsolete hashes must not become unrestorable
  // attribution records after a rule edit or a new roadmap scope.
  for(const write of plan.writes)if(write.table==='project_history'&&write.operation==='update'){
    const value=parseHistoryRecord(write.value);
    if(value.kind==='roadmap_head'||value.kind==='association_rule')statements.push(db.prepare(`DELETE FROM acceptance_owner_grants WHERE user_id=? AND record_id=? AND ${claim}`).bind(userId,write.id,...guard));
  }
  if(['roadmap.agree','checkpoint.assess','history.association.set'].includes(command.type))for(const write of plan.writes)if(write.table==='project_history'){
    const value=parseHistoryRecord(write.value);
    if(value.id!==write.id)throw new CommandValidationError('History grant identity differs.');
    if(createsHistoryOwnerGrant(command.type,value,write.operation,now,id))
      statements.push(db.prepare(`INSERT OR IGNORE INTO acceptance_owner_grants(user_id,record_id,content_hash) SELECT ?,?,? WHERE ${claim}`).bind(userId,write.id,await hashJson(value),...guard));
  }
  if(command.type==='acceptance.record')for(const write of plan.writes)if(write.table==='acceptance_records'&&write.operation==='insert'){
    const value=write.value as unknown as import('./evidence-contract.ts').AcceptanceRecord;
    if(value.recordedAt!==now)throw new CommandValidationError('Owner assessment recording time must be current.');
    statements.push(db.prepare(`INSERT INTO acceptance_owner_grants(user_id,record_id,content_hash) SELECT ?,?,? WHERE ${claim}`).bind(userId,value.id,await hashJson(value),...guard));
  }
  if(command.type==='decisions.decide'||command.type==='decisions.supersede')for(const write of plan.writes)if(write.table==='decision_versions'&&write.operation==='insert'){
    const value=write.value as unknown as import('./evidence-contract.ts').DecisionVersion;
    if(value.status==='decided'&&value.decidedAt===now&&value.recordedAt===now)statements.push(db.prepare(`INSERT INTO decision_owner_grants(user_id,decision_id,version,content_hash) SELECT ?,?,?,? WHERE ${claim}`).bind(userId,value.id,value.version,await hashJson(value),...guard));
  }
  for(const [ordinal,event] of plan.events.entries()){
    if(event.actorId!==userId || event.origin!==(agentArtifact?'connector':'owner') || event.occurredAt!==now)throw new CommandValidationError('Owner event authority is invalid.');
    statements.push(db.prepare(`INSERT INTO audit_events (user_id,event_id,workspace_revision,ordinal,stream_id,stream_sequence,kind,entity_type,entity_id,occurred_at,payload_json,origin,actor_id,source_ref,undo_of) SELECT ?,?,?,?,NULL,NULL,?,?,?,?,?,?,?,?,? WHERE ${claim}`).bind(userId,event.id,revision+1,ordinal,event.kind,event.entityType,event.entityId,now,canonicalJson(event),event.origin,event.actorId,event.sourceRef,event.undoOf,...guard));
    for(const projectId of auditProjectIds(event,before.workspace,plan.planningAfter))statements.push(db.prepare(`INSERT INTO audit_project_links(user_id,event_id,project_id) SELECT ?,?,? WHERE ${claim}`).bind(userId,event.id,projectId,...guard));
  }
  if(plan.historyImports?.length){
    if(plan.historyImports.length>10000)throw new CommandValidationError('Imported history exceeds row limits.');
    for(const entry of plan.historyImports){
      if(entry.sourceIdentity!==undefined||entry.sourceHash!==undefined){
        if(!entry.sourceIdentity||entry.sourceIdentity.length>256||!entry.sourceHash||!/^[a-f0-9]{64}$/.test(entry.sourceHash))throw new CommandValidationError('Invalid stable imported history identity.');
        assertion('NOT EXISTS (SELECT 1 FROM audit_import_identities WHERE user_id=? AND source_identity=? AND (source_hash<>? OR event_id<>?))',[userId,entry.sourceIdentity,entry.sourceHash,entry.id]);
        assertion('NOT EXISTS (SELECT 1 FROM audit_events WHERE user_id=? AND event_id=?) OR EXISTS (SELECT 1 FROM audit_import_identities WHERE user_id=? AND source_identity=? AND source_hash=? AND event_id=?)',[userId,entry.id,userId,entry.sourceIdentity,entry.sourceHash,entry.id]);
        statements.push(db.prepare(`INSERT INTO audit_import_identities(user_id,source_identity,source_hash,event_id) SELECT ?,?,?,? WHERE ${claim} ON CONFLICT(user_id,source_identity) DO NOTHING`).bind(userId,entry.sourceIdentity,entry.sourceHash,entry.id,...guard));
      }
    }
    const history=plan.historyImports.map((entry,index)=>{
      if(!/^[a-f0-9]{64}$/.test(entry.importHash) || !entry.id)throw new CommandValidationError('Invalid imported history provenance.');
      const event:AuditEventDraft={id:entry.id,kind:'imported-history',entityType:'historical-claim',entityId:null,changes:[{path:['sourceClaim'],before:{exists:false,value:null},after:{exists:true,value:entry.source}}],origin:'owner',actorId:userId,occurredAt:now,sourceRef:entry.importHash,undoOf:null};
      return {id:entry.id,ordinal:plan.events.length+index,payload:canonicalJson(event)};
    });
    const payload=canonicalJson(history);if(new TextEncoder().encode(payload).length>RECOVERABILITY_SQL_ARGUMENT_BYTES)throw new CommandValidationError('Imported history exceeds the atomic statement limit.');
    statements.push(db.prepare(`INSERT INTO audit_events (user_id,event_id,workspace_revision,ordinal,stream_id,stream_sequence,kind,entity_type,entity_id,occurred_at,payload_json) SELECT ?,json_extract(value,'$.id'),?,json_extract(value,'$.ordinal'),NULL,NULL,'imported-history','historical-claim',NULL,?,json_extract(value,'$.payload') FROM json_each(?) WHERE ${claim} ON CONFLICT(user_id,event_id) DO NOTHING`).bind(userId,revision+1,now,payload,...guard));
  }
  for(const job of plan.jobs.filter(item=>item.kind!=='agent.execute')){if(job.kind==='agent.execute'&&(plan.agentControls?.action!=='create'||job.id!==plan.agentControls.record.intentId))throw new CommandValidationError('Agent intent requires one exact immutable proposal.');statements.push(db.prepare(`INSERT INTO workspace_job_intents (user_id,id,kind,dedupe_key,payload_json,not_before,status,execution_epoch,cancel_requested) SELECT ?,?,?,?,?,?,?,COALESCE((SELECT epoch FROM workspace_execution_state WHERE user_id=?),0),0 WHERE ${claim}`).bind(userId,job.id,job.kind,job.dedupeKey,canonicalJson(job.payload),job.notBefore,job.kind==='agent.execute'?'awaiting_approval':'pending',userId,...guard));}
  statements.push(...await agentControlStatements(db,userId,plan,command.type,claim,guard,now,before.workspace));
  statements.push(...await deviceControlStatements(db,userId,plan,command.type,claim,guard,now));
  statements.push(...await baselineControlStatements(db,userId,plan,command.type,claim,guard,now));
  statements.push(...await compileHistoryAnalysisConsent(db,userId,plan.historyAnalysisConsent,command.type,claim,guard,now));
  statements.push(...await reviewControlStatements(db,userId,plan,command.type,claim,guard,now));
  const sourceJobs=plan.jobs.filter(job=>job.kind==='source_refresh'),extensions=plan.integrationJobs??[];
  if(sourceJobs.length!==extensions.length||new Set(extensions.map(extension=>extension.intentId)).size!==extensions.length||sourceJobs.length&&command.type!=='sources.refresh.request')throw new CommandValidationError('Integration jobs must extend an explicit source refresh intent.');
  for(const extension of extensions){const job=sourceJobs.find(job=>job.id===extension.intentId);if(!job||!extension.sourceId||!/^[a-f0-9]{64}$/.test(extension.configurationHash)||canonicalJson(job.payload)!==canonicalJson({sourceId:extension.sourceId,configurationHash:extension.configurationHash,...(typeof command.manualImportHash==='string'&&/^[a-f0-9]{64}$/.test(command.manualImportHash)?{manualImportHash:command.manualImportHash}:{})}))throw new CommandValidationError('Invalid source refresh intent extension.');
    assertion(`EXISTS(SELECT 1 FROM source_sync_state WHERE user_id=? AND source_id=? AND configuration_hash=? AND paused=0 AND execution_epoch=COALESCE((SELECT epoch FROM workspace_execution_state WHERE user_id=?),0))`,[userId,extension.sourceId,extension.configurationHash,userId]);
    statements.push(db.prepare(`INSERT INTO integration_jobs(user_id,intent_id,source_id,subject_id,job_subject_kind,configuration_hash,operational_revision,attempt_count) SELECT ?,?,?,?,'source',?,1,0 WHERE ${claim}`).bind(userId,extension.intentId,extension.sourceId,extension.sourceId,extension.configurationHash,...guard));
  }
  statements.push(db.prepare(`UPDATE workspaces SET content=?,revision=revision+1,updated_at=? WHERE user_id=? AND revision=? AND ${claim}`).bind(encodePlanning(plan.planningAfter),now,userId,revision,...guard));
  assertion('EXISTS (SELECT 1 FROM workspaces WHERE user_id=? AND revision=?)',[userId,revision+1]);
  statements.push(db.prepare(`DELETE FROM workspace_assertions WHERE user_id=? AND mutation_id=? AND ${claim}`).bind(userId,id,...guard));
  statements.push(db.prepare('DELETE FROM workspace_command_guards WHERE user_id=? AND mutation_id=? AND claim_token=?').bind(...guard));
  let acquired=false;
  try {const results=await db.batch(statements);acquired=results[0]?.meta.changes===1;}catch {
    const currentEpoch=await checkMutationEpoch(db,userId,id);if(currentEpoch.status==='retired')throw new RetiredMutationError('This mutation epoch is retired.');
    const replay=await checkReceipt();if(replay)return replay;
    const current=await readCurrent(db,userId,now);if(current.revision!==revision)return {status:'conflict',currentRevision:current.revision};
    // Only classify a row conflict when an authoritative reread proves it; otherwise storage remains uncertain.
    if(await receiptCount(db,userId)>=RECEIPT_CAPACITY.hard)throw new WorkspaceCapacityError();
    // Reconcile the exact admitted quote only on failure; the same guard was the
    // first atomic assertion. No refreshed quote, deletion credit or refund.
    if(!await db.prepare('SELECT 1 WHERE '+privateCapacity.sql).bind(...privateCapacity.bindings).first())throw new PrivateCapacityError();
    if(plan.importSource){const source=await db.prepare('SELECT id FROM workspace_imports WHERE user_id=? AND id=? AND content_hash=? AND expires_at>?').bind(userId,plan.importSource.id,plan.importSource.hash,now).first<{id:string}>();if(!source)throw new ModuleConflictError('The staged import changed or expired. Review a new preview.');}
    const reader=ownerReader(db,userId);
    if(plan.referenceSnapshot){
      for(const table of plan.referenceSnapshot.coveredModules){
        const rows=[];let after='';for(;;){const page=await reader.list(table,{after,limit:200});for(const row of page){rows.push({id:row.id,rowRevision:row.row_revision,contentHash:row.content_hash});after=row.id;}if(page.length<200)break;if(rows.length>10000)throw new ModuleConflictError('Related records changed.');}
        const expected=plan.referenceSnapshot.rows.filter(row=>row.module===table).map(({id,rowRevision,contentHash})=>({id,rowRevision,contentHash}));
        if(canonicalJson(rows)!==canonicalJson(expected))throw new ModuleConflictError('Related records changed. Review deletion again.');
      }
    }
    for(const pre of plan.preconditions??[]){const row=await reader.get(pre.table,pre.id);if(!row || row.row_revision!==pre.expectedRowRevision || pre.expectedHash!==undefined && row.content_hash!==pre.expectedHash)throw new ModuleConflictError('An accepted source changed. Refresh and review again.');}
    for(const write of plan.writes){const row=await reader.get(write.table,write.id);if(write.operation==='insert'?Boolean(row):!row || row.row_revision!==write.expectedRowRevision)throw new ModuleConflictError('A related record changed. Refresh and review again.');}
    throw new WorkspaceStorageError('The change could not be confirmed. Reconcile its mutation ID before retrying.');
  }
  const finalRead=await readFinalMutation(db,userId,id,now),finalAdmission=finalRead.admission;
  if(finalAdmission.epoch.status==='retired')throw new RetiredMutationError('This mutation epoch is retired.');
  const committed=finalAdmission.receipt;if(!committed)return {status:'conflict',currentRevision:finalRead.readCurrent().revision};
  if(committed.command_hash!==hash&&committed.command_hash!==legacyHash)throw new MutationIdReuseError('This mutation ID was reused for a different change.');
  return {status:acquired&&committed.command_hash===hash?'committed':'replayed',envelope:finalRead.readCurrent(),receipt:{mutationId:id,commandHash:committed.command_hash,appliedRevision:committed.revision}};
}
