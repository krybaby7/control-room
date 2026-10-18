import type { Workspace, WorkspaceEnvelope } from './types.ts';
import { readCurrent, type SqlDatabase, type SqlStatement } from './workspace-store.ts';
import { parseWorkspaceExport } from './workspace-validation.ts';
import { encodePlanning } from './workspace-codec.ts';
import { ownerReader, ownerTable, type GuardedWrite, type RowPrecondition, type OwnerScopedReader } from './workspace-modules.ts';
import type { AuditEventDraft, CommandResult, JobIntent, MutationOutcome, WorkspaceCommand } from './workspace-protocol.ts';
import { prepareWorkspaceBackup, BACKUP_LIMITS } from './workspace-backups.ts';
import { checkMutationEpoch } from './idempotency-retention.ts';
import { RetiredMutationError, CommandValidationError, MutationIdReuseError, ModuleConflictError, WorkspaceStorageError } from './workspace-errors.ts';
export interface MutationPlan { planningAfter: Workspace; writes: GuardedWrite[]; preconditions?: RowPrecondition[]; events: AuditEventDraft[]; backup?: {reason:'restore'|'delete'|'repair'|'manual'}; jobs: JobIntent[]; }
export interface PrepareContext { userId: string; before: WorkspaceEnvelope; command: WorkspaceCommand; now: string; query: OwnerScopedReader; }
export interface CommandHandler { prepare(context: PrepareContext): Promise<MutationPlan>; }
export type CommandHandlerRegistry = ReadonlyMap<string, CommandHandler>;
export interface WorkspaceTransactionDeps { db: SqlDatabase; now:()=>string; handlers: CommandHandlerRegistry; }
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
  const {db}=deps,revision=input.expectedRevision,id=input.mutationId;
  if (!input.command || typeof input.command!=='object' || Array.isArray(input.command) || typeof (input.command as {type?:unknown}).type!=='string') throw new CommandValidationError('A command type is required.');
  const command=input.command as WorkspaceCommand;
  const hash=await hashJson({protocolVersion:1,command});
  // Existing v2 receipts used the command-only hash; preserve their replay semantics.
  const legacyHash=await hashJson(command);
  const checkReceipt=async ():Promise<CommandResult|null>=>{const prior=await receipt(db,userId,id);if(!prior)return null;if(prior.command_hash!==hash && prior.command_hash!==legacyHash)throw new MutationIdReuseError('This mutation ID was reused for a different change.');return {status:'replayed',envelope:await readCurrent(db,userId),receipt:{mutationId:id,commandHash:prior.command_hash,appliedRevision:prior.revision}};};
  const epoch=await checkMutationEpoch(db,userId,id);
  if(epoch.status==='retired')throw new RetiredMutationError('This mutation epoch is retired.');
  const replay=await checkReceipt();if(replay)return replay;
  const before=await readCurrent(db,userId);if(before.revision!==revision)return {status:'conflict',currentRevision:before.revision};
  const handler=deps.handlers.get(command.type);if(!handler)throw new CommandValidationError('Unknown command.');
  const now=deps.now();let plan:MutationPlan;
  try {plan=await handler.prepare({userId,before,command,now,query:ownerReader(db,userId)});plan.planningAfter=parseWorkspaceExport(plan.planningAfter,now);}
  catch(error){throw new CommandValidationError(error instanceof Error?error.message:'This change is invalid.');}
  if(plan.backup?.reason==='restore'){const query=ownerReader(db,userId);for(const table of ['weekly_plans','weekly_reviews','recurrence_rules','recurrence_occurrences','evidence_records','evidence_links','decisions','attachments','workspace_configuration'] as const)if((await query.list(table,{limit:1})).length)throw new CommandValidationError('This restore requires a complete normalized bundle. Export all modules before replacing planning records.');}
  if(plan.writes.length>200 || plan.events.length>200 || plan.jobs.length>50)throw new CommandValidationError('Command batch is too large.');
  const preparedBackup=plan.backup?await prepareWorkspaceBackup(db,userId,before,plan.backup.reason,now):null;
  const claim='EXISTS (SELECT 1 FROM workspace_command_guards WHERE user_id = ? AND mutation_id = ? AND claim_token = ?)';
  const token=crypto.randomUUID(),guard=[userId,id,token];
  const statements:SqlStatement[]=[db.prepare(`INSERT INTO workspace_command_guards (user_id,mutation_id,claim_token,valid) SELECT ?,?,?,1 FROM workspaces WHERE user_id = ? AND revision = ? AND NOT EXISTS (SELECT 1 FROM workspace_mutations WHERE user_id = ? AND mutation_id = ?)${epoch.status==='active'?" AND EXISTS (SELECT 1 FROM workspace_mutation_epochs WHERE user_id = ? AND epoch = ? AND status = 'active')":''}`).bind(...guard,userId,revision,userId,id,...(epoch.status==='active'?[userId,epoch.epoch]:[]))];
  const assertion=(condition:string,values:(string|number|null)[])=>statements.push(db.prepare(`INSERT INTO workspace_assertions (user_id,mutation_id,valid) SELECT ?,?,CASE WHEN ${condition} THEN 1 ELSE 0 END WHERE ${claim}`).bind(userId,id,...values,...guard));
  for(const pre of plan.preconditions??[]){const table=ownerTable(pre.table);assertion(`EXISTS (SELECT 1 FROM ${table} WHERE user_id = ? AND id = ? AND row_revision = ?${pre.expectedHash===undefined?'':' AND content_hash = ?'})`,[userId,pre.id,pre.expectedRowRevision,...(pre.expectedHash===undefined?[]:[pre.expectedHash])]);}
  for(const write of plan.writes){const table=ownerTable(write.table);if(!write.id || write.id.length>128)throw new CommandValidationError('Invalid module record ID.');
    if(write.operation==='insert'){if(write.expectedRowRevision!==null)throw new CommandValidationError('Insert must require an absent row.');assertion(`NOT EXISTS (SELECT 1 FROM ${table} WHERE user_id = ? AND id = ?)`,[userId,write.id]);}
    else {if(!Number.isSafeInteger(write.expectedRowRevision) || (write.expectedRowRevision??0)<1)throw new CommandValidationError('Module revision is required.');assertion(`EXISTS (SELECT 1 FROM ${table} WHERE user_id = ? AND id = ? AND row_revision = ?)`,[userId,write.id,write.expectedRowRevision]);}
  }
  // At most one operation per row avoids order-dependent hidden changes.
  if(new Set(plan.writes.map(w=>`${w.table}:${w.id}`)).size!==plan.writes.length)throw new CommandValidationError('A module row may change only once in one command.');
  statements.push(db.prepare(`INSERT INTO workspace_mutations (user_id,mutation_id,command_hash,revision,committed_at) SELECT ?,?,?,?,? WHERE ${claim}`).bind(userId,id,hash,revision+1,now,...guard));
  if(preparedBackup){
    assertion('(SELECT COUNT(*) FROM workspace_backups WHERE user_id = ?) < ? AND (SELECT COALESCE(SUM(bytes),0) FROM workspace_backups WHERE user_id = ?) + ? <= ?',[userId,BACKUP_LIMITS.snapshots,userId,preparedBackup.manifest.bytes,BACKUP_LIMITS.ownerBytes]);
    const backup=preparedBackup.manifest;
    statements.push(db.prepare(`INSERT INTO workspace_backups (user_id,id,source_revision,created_at,reason,bytes,sha256,content,status,pinned) SELECT ?,?,?,?,?,?,?,?,'ready',? WHERE ${claim}`).bind(userId,backup.id,before.revision,now,backup.reason,backup.bytes,backup.sha256,preparedBackup.content,backup.reason==='manual'?1:0,...guard));
  }
  if(plan.backup?.reason==='restore'){
    // Until normalized restore is enabled, reject snapshots that would omit normalized records.
    for(const table of ['weekly_plans','weekly_reviews','recurrence_rules','recurrence_occurrences','evidence_records','evidence_links','decisions','attachments','workspace_configuration'])assertion(`NOT EXISTS (SELECT 1 FROM ${table} WHERE user_id = ?)`,[userId]);
    statements.push(db.prepare(`INSERT INTO workspace_recovery (user_id,content,revision,updated_at) SELECT user_id,content,revision,updated_at FROM workspaces WHERE user_id = ? AND ${claim} ON CONFLICT(user_id) DO UPDATE SET content=excluded.content,revision=excluded.revision,updated_at=excluded.updated_at`).bind(userId,...guard));
  }
  for(const write of plan.writes){const table=ownerTable(write.table);
    if(write.operation==='insert')statements.push(db.prepare(`INSERT INTO ${table} (user_id,id,row_revision,payload_json,content_hash) SELECT ?,?,1,?,? WHERE ${claim}`).bind(userId,write.id,canonicalJson(write.value),await hashJson(write.value),...guard));
    else if(write.operation==='update')statements.push(db.prepare(`UPDATE ${table} SET row_revision=row_revision+1,payload_json=?,content_hash=? WHERE user_id=? AND id=? AND row_revision=? AND ${claim}`).bind(canonicalJson(write.value),await hashJson(write.value),userId,write.id,write.expectedRowRevision,...guard));
    else if(write.operation==='delete')statements.push(db.prepare(`DELETE FROM ${table} WHERE user_id=? AND id=? AND row_revision=? AND ${claim}`).bind(userId,write.id,write.expectedRowRevision,...guard));
    else throw new CommandValidationError('Unknown module operation.');
  }
  for(const [ordinal,event] of plan.events.entries()){
    if(event.actorId!==userId || event.origin!=='owner' || event.occurredAt!==now)throw new CommandValidationError('Owner event authority is invalid.');
    statements.push(db.prepare(`INSERT INTO audit_events (user_id,event_id,workspace_revision,ordinal,stream_id,stream_sequence,kind,entity_type,entity_id,occurred_at,payload_json) SELECT ?,?,?,?,NULL,NULL,?,?,?,?,? WHERE ${claim}`).bind(userId,event.id,revision+1,ordinal,event.kind,event.entityType,event.entityId,now,canonicalJson(event),...guard));
  }
  for(const job of plan.jobs)statements.push(db.prepare(`INSERT INTO workspace_job_intents (user_id,id,kind,dedupe_key,payload_json,not_before,status) SELECT ?,?,?,?,?,?,'pending' WHERE ${claim}`).bind(userId,job.id,job.kind,job.dedupeKey,canonicalJson(job.payload),job.notBefore,...guard));
  statements.push(db.prepare(`UPDATE workspaces SET content=?,revision=revision+1,updated_at=? WHERE user_id=? AND revision=? AND ${claim}`).bind(encodePlanning(plan.planningAfter),now,userId,revision,...guard));
  assertion('EXISTS (SELECT 1 FROM workspaces WHERE user_id=? AND revision=?)',[userId,revision+1]);
  statements.push(db.prepare(`DELETE FROM workspace_assertions WHERE user_id=? AND mutation_id=? AND ${claim}`).bind(userId,id,...guard));
  statements.push(db.prepare('DELETE FROM workspace_command_guards WHERE user_id=? AND mutation_id=? AND claim_token=?').bind(...guard));
  let acquired=false;
  try {const results=await db.batch(statements);acquired=results[0]?.meta.changes===1;}catch {
    const currentEpoch=await checkMutationEpoch(db,userId,id);if(currentEpoch.status==='retired')throw new RetiredMutationError('This mutation epoch is retired.');
    const replay=await checkReceipt();if(replay)return replay;
    const current=await readCurrent(db,userId);if(current.revision!==revision)return {status:'conflict',currentRevision:current.revision};
    // Only classify a row conflict when an authoritative reread proves it; otherwise storage remains uncertain.
    const reader=ownerReader(db,userId);
    for(const pre of plan.preconditions??[]){const row=await reader.get(pre.table,pre.id);if(!row || row.row_revision!==pre.expectedRowRevision || pre.expectedHash!==undefined && row.content_hash!==pre.expectedHash)throw new ModuleConflictError('An accepted source changed. Refresh and review again.');}
    for(const write of plan.writes){const row=await reader.get(write.table,write.id);if(write.operation==='insert'?Boolean(row):!row || row.row_revision!==write.expectedRowRevision)throw new ModuleConflictError('A related record changed. Refresh and review again.');}
    throw new WorkspaceStorageError('The change could not be confirmed. Reconcile its mutation ID before retrying.');
  }
  const finalEpoch=await checkMutationEpoch(db,userId,id);if(finalEpoch.status==='retired')throw new RetiredMutationError('This mutation epoch is retired.');
  const committed=await receipt(db,userId,id);if(!committed)return {status:'conflict',currentRevision:(await readCurrent(db,userId)).revision};
  if(committed.command_hash!==hash) return (await checkReceipt())!;
  return {status:acquired?'committed':'replayed',envelope:await readCurrent(db,userId),receipt:{mutationId:id,commandHash:hash,appliedRevision:committed.revision}};
}
