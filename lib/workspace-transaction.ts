import type { Workspace, WorkspaceEnvelope } from './types.ts';
import { readCurrent, type SqlDatabase, type SqlStatement } from './workspace-store.ts';
import { parseWorkspaceExport } from './workspace-validation.ts';
import { encodePlanning } from './workspace-codec.ts';
import { OWNER_TABLES, ownerReader, ownerTable, type GuardedWrite, type RowPrecondition, type OwnerScopedReader, type RegisteredOwnerTable, type ModuleRow } from './workspace-modules.ts';
import type { AuditEventDraft, CommandResult, JobIntent, MutationOutcome, WorkspaceCommand } from './workspace-protocol.ts';
import { readStagedImport } from './import-staging.ts';
import { prepareWorkspaceBackup, readWorkspaceBackup, listWorkspaceBackups, BACKUP_LIMITS } from './workspace-backups.ts';
import { checkMutationEpoch } from './idempotency-retention.ts';
import { RetiredMutationError, CommandValidationError, MutationIdReuseError, ModuleConflictError, WorkspaceStorageError } from './workspace-errors.ts';
export interface ModuleReplacement {table:RegisteredOwnerTable;beforeRows:ModuleRow[];records:Array<{id:string;value:import('./workspace-protocol.ts').JsonValue}>;}
export interface MutationPlan { referenceSnapshot?:import('./workspace-references.ts').ReferenceSnapshot; backupRemoval?:{id:string;sha256:string;newerId:string;newerSha256:string};emptyModules?:RegisteredOwnerTable[];importSource?:{id:string;hash:string};replacements?:ModuleReplacement[];restoreEpoch?:boolean;historyImports?:Array<{id:string;source:import('./workspace-protocol.ts').JsonValue;importHash:string}>; planningAfter: Workspace; writes: GuardedWrite[]; preconditions?: RowPrecondition[]; events: AuditEventDraft[]; backup?: {reason:'restore'|'delete'|'repair'|'manual'}; jobs: JobIntent[]; }
export interface PrepareContext { userId: string; before: WorkspaceEnvelope; command: WorkspaceCommand; now: string; query: OwnerScopedReader; backups?:{get:(id:string)=>ReturnType<typeof readWorkspaceBackup>;list:()=>ReturnType<typeof listWorkspaceBackups>};readImport:(id:string)=>ReturnType<typeof readStagedImport>; }
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
  try {plan=await handler.prepare({userId,before,command,now,query:ownerReader(db,userId),readImport:id=>readStagedImport(db,userId,id,now),backups:{get:id=>readWorkspaceBackup(db,userId,id),list:()=>listWorkspaceBackups(db,userId)}});plan.planningAfter=parseWorkspaceExport(plan.planningAfter,now);}
  catch(error){throw new CommandValidationError(error instanceof Error?error.message:'This change is invalid.');}
  if(plan.backup?.reason==='restore'){const query=ownerReader(db,userId);for(const table of ['weekly_plans','weekly_reviews','recurrence_rules','recurrence_occurrences','evidence_records','evidence_links','decisions','attachments','workspace_configuration'] as const)if((await query.list(table,{limit:1})).length && !plan.replacements?.some(replacement=>replacement.table===table))throw new CommandValidationError('This restore requires a complete normalized bundle. Export all modules before replacing planning records.');}
  if(plan.writes.length>200 || plan.events.length>200 || plan.jobs.length>50)throw new CommandValidationError('Command batch is too large.');
  if(plan.restoreEpoch && (!plan.backup || plan.jobs.length))throw new CommandValidationError('Recovery must retain a backup and cannot dispatch new jobs.');
  if(new Set((plan.replacements??[]).map(replacement=>replacement.table)).size!==(plan.replacements??[]).length)throw new CommandValidationError('Duplicate replacement module.');
  for(const replacement of plan.replacements??[]){ownerTable(replacement.table);if(plan.writes.some(write=>write.table===replacement.table) || replacement.beforeRows.length>10000 || replacement.records.length>10000)throw new CommandValidationError('Invalid replacement scope.');}
  let preparedBackup:Awaited<ReturnType<typeof prepareWorkspaceBackup>>|null=null;
  try { if(plan.backup)preparedBackup=await prepareWorkspaceBackup(db,userId,before,plan.backup.reason,now); }
  catch(error){
    if((await checkMutationEpoch(db,userId,id)).status==='retired')throw new RetiredMutationError('This mutation epoch is retired.');
    const concurrentReplay=await checkReceipt();if(concurrentReplay)return concurrentReplay;
    const current=await readCurrent(db,userId);if(current.revision!==revision)return {status:'conflict',currentRevision:current.revision};
    throw error;
  }
  const claim='EXISTS (SELECT 1 FROM workspace_command_guards WHERE user_id = ? AND mutation_id = ? AND claim_token = ?)';
  const token=crypto.randomUUID(),guard=[userId,id,token];
  const statements:SqlStatement[]=[db.prepare(`INSERT INTO workspace_command_guards (user_id,mutation_id,claim_token,valid) SELECT ?,?,?,1 FROM workspaces WHERE user_id = ? AND revision = ? AND NOT EXISTS (SELECT 1 FROM workspace_mutations WHERE user_id = ? AND mutation_id = ?)${epoch.status==='active'?" AND EXISTS (SELECT 1 FROM workspace_mutation_epochs WHERE user_id = ? AND epoch = ? AND status = 'active')":''}`).bind(...guard,userId,revision,userId,id,...(epoch.status==='active'?[userId,epoch.epoch]:[]))];
  const assertion=(condition:string,values:(string|number|null)[])=>statements.push(db.prepare(`INSERT INTO workspace_assertions (user_id,mutation_id,valid) SELECT ?,?,CASE WHEN ${condition} THEN 1 ELSE 0 END WHERE ${claim}`).bind(userId,id,...values,...guard));
  if(plan.referenceSnapshot){
    const snapshot=plan.referenceSnapshot;
    if(snapshot.coveredModules.length!==OWNER_TABLES.length || new Set(snapshot.coveredModules).size!==OWNER_TABLES.length)throw new CommandValidationError('Incomplete reference snapshot.');
    for(const table of snapshot.coveredModules){
      ownerTable(table);const rows=snapshot.rows.filter(row=>row.module===table).map(row=>({id:row.id,row_revision:row.rowRevision,content_hash:row.contentHash}));
      if(rows.length>10000 || new Set(rows.map(row=>row.id)).size!==rows.length)throw new CommandValidationError('Invalid reference snapshot.');
      const payload=canonicalJson(rows);if(new TextEncoder().encode(payload).length>1_800_000)throw new CommandValidationError('Reference assertions exceed atomic statement limit.');
      assertion(`(SELECT COUNT(*) FROM ${table} WHERE user_id=?) = ? AND NOT EXISTS (SELECT id,row_revision,content_hash FROM ${table} WHERE user_id=? EXCEPT SELECT json_extract(value,'$.id'),json_extract(value,'$.row_revision'),json_extract(value,'$.content_hash') FROM json_each(?))`,[userId,rows.length,userId,payload]);
    }
  }
  for(const pre of plan.preconditions??[]){const table=ownerTable(pre.table);assertion(`EXISTS (SELECT 1 FROM ${table} WHERE user_id = ? AND id = ? AND row_revision = ?${pre.expectedHash===undefined?'':' AND content_hash = ?'})`,[userId,pre.id,pre.expectedRowRevision,...(pre.expectedHash===undefined?[]:[pre.expectedHash])]);}
  if(plan.backupRemoval){const removal=plan.backupRemoval;assertion(`EXISTS (SELECT 1 FROM workspace_backups old JOIN workspace_backups newer ON newer.user_id=old.user_id WHERE old.user_id=? AND old.id=? AND old.sha256=? AND old.status='ready' AND newer.id=? AND newer.sha256=? AND newer.status='ready' AND (newer.source_revision>old.source_revision OR (newer.source_revision=old.source_revision AND newer.created_at>old.created_at)))`,[userId,removal.id,removal.sha256,removal.newerId,removal.newerSha256]);}
  for(const table of plan.emptyModules??[])assertion(`NOT EXISTS (SELECT 1 FROM ${ownerTable(table)} WHERE user_id=?)`,[userId]);
  if(plan.importSource)assertion('EXISTS (SELECT 1 FROM workspace_imports WHERE user_id=? AND id=? AND content_hash=? AND expires_at>?)',[userId,plan.importSource.id,plan.importSource.hash,now]);
  const replacementPayloads=new Map<RegisteredOwnerTable,string>();
  for(const replacement of plan.replacements??[]){
    const table=ownerTable(replacement.table);
    if(new Set(replacement.beforeRows.map(row=>row.id)).size!==replacement.beforeRows.length || new Set(replacement.records.map(row=>row.id)).size!==replacement.records.length)throw new CommandValidationError('Duplicate replacement identity.');
    const beforeRows=canonicalJson(replacement.beforeRows.map(({id,row_revision,content_hash})=>({id,row_revision,content_hash})));
    if(new TextEncoder().encode(beforeRows).length>1_800_000)throw new CommandValidationError('Replacement preconditions exceed the atomic statement limit.');
    assertion(`(SELECT COUNT(*) FROM ${table} WHERE user_id=?) = ? AND NOT EXISTS (SELECT id,row_revision,content_hash FROM ${table} WHERE user_id=? EXCEPT SELECT json_extract(value,'$.id'),json_extract(value,'$.row_revision'),json_extract(value,'$.content_hash') FROM json_each(?))`,[userId,replacement.beforeRows.length,userId,beforeRows]);
    const beforeIndex=new Map(replacement.beforeRows.map(row=>[row.id,row.row_revision]));
    const rows=[];
    for(const row of replacement.records){if(!row.id || row.id.length>128)throw new CommandValidationError('Invalid imported module identity.');rows.push({id:row.id,row_revision:(beforeIndex.get(row.id)??0)+1,payload_json:canonicalJson(row.value),content_hash:await hashJson(row.value)});}
    const payload=canonicalJson(rows);if(new TextEncoder().encode(payload).length>1_800_000)throw new CommandValidationError('Replacement rows exceed the atomic statement limit.');replacementPayloads.set(table,payload);
  }
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
    for(const table of ['weekly_plans','weekly_reviews','recurrence_rules','recurrence_occurrences','evidence_records','evidence_links','decisions','attachments','workspace_configuration'])if(!plan.replacements?.some(replacement=>replacement.table===table))assertion(`NOT EXISTS (SELECT 1 FROM ${table} WHERE user_id = ?)`,[userId]);
    statements.push(db.prepare(`INSERT INTO workspace_recovery (user_id,content,revision,updated_at) SELECT user_id,content,revision,updated_at FROM workspaces WHERE user_id = ? AND ${claim} ON CONFLICT(user_id) DO UPDATE SET content=excluded.content,revision=excluded.revision,updated_at=excluded.updated_at`).bind(userId,...guard));
  }
  if(plan.backupRemoval)statements.push(db.prepare(`DELETE FROM workspace_backups WHERE user_id=? AND id=? AND sha256=? AND ${claim}`).bind(userId,plan.backupRemoval.id,plan.backupRemoval.sha256,...guard));
  for(const [table,payload] of replacementPayloads){
    statements.push(db.prepare(`DELETE FROM ${table} WHERE user_id=? AND ${claim}`).bind(userId,...guard));
    statements.push(db.prepare(`INSERT INTO ${table} (user_id,id,row_revision,payload_json,content_hash) SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.row_revision'),json_extract(value,'$.payload_json'),json_extract(value,'$.content_hash') FROM json_each(?) WHERE ${claim}`).bind(userId,payload,...guard));
  }
  if(plan.restoreEpoch){
    statements.push(db.prepare(`INSERT INTO workspace_execution_state (user_id,epoch,restored_at) SELECT ?,1,? WHERE ${claim} ON CONFLICT(user_id) DO UPDATE SET epoch=workspace_execution_state.epoch+1,restored_at=excluded.restored_at`).bind(userId,now,...guard));
    statements.push(db.prepare(`UPDATE workspace_job_intents SET status=CASE WHEN status='pending' THEN 'cancelled' ELSE status END,cancel_requested=CASE WHEN status IN ('running','claimed') THEN 1 ELSE cancel_requested END WHERE user_id=? AND ${claim}`).bind(userId,...guard));
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
  if(plan.historyImports?.length){
    if(plan.historyImports.length>10000)throw new CommandValidationError('Imported history exceeds row limits.');
    const history=plan.historyImports.map((entry,index)=>{
      if(!/^[a-f0-9]{64}$/.test(entry.importHash) || !entry.id)throw new CommandValidationError('Invalid imported history provenance.');
      const event:AuditEventDraft={id:entry.id,kind:'imported-history',entityType:'historical-claim',entityId:null,changes:[{path:['sourceClaim'],before:{exists:false,value:null},after:{exists:true,value:entry.source}}],origin:'owner',actorId:userId,occurredAt:now,sourceRef:entry.importHash,undoOf:null};
      return {id:entry.id,ordinal:plan.events.length+index,payload:canonicalJson(event)};
    });
    const payload=canonicalJson(history);if(new TextEncoder().encode(payload).length>1_800_000)throw new CommandValidationError('Imported history exceeds the atomic statement limit.');
    statements.push(db.prepare(`INSERT INTO audit_events (user_id,event_id,workspace_revision,ordinal,stream_id,stream_sequence,kind,entity_type,entity_id,occurred_at,payload_json) SELECT ?,json_extract(value,'$.id'),?,json_extract(value,'$.ordinal'),NULL,NULL,'imported-history','historical-claim',NULL,?,json_extract(value,'$.payload') FROM json_each(?) WHERE ${claim} ON CONFLICT(user_id,event_id) DO NOTHING`).bind(userId,revision+1,now,payload,...guard));
  }
  for(const job of plan.jobs)statements.push(db.prepare(`INSERT INTO workspace_job_intents (user_id,id,kind,dedupe_key,payload_json,not_before,status,execution_epoch,cancel_requested) SELECT ?,?,?,?,?,?,'pending',COALESCE((SELECT epoch FROM workspace_execution_state WHERE user_id=?),0),0 WHERE ${claim}`).bind(userId,job.id,job.kind,job.dedupeKey,canonicalJson(job.payload),job.notBefore,userId,...guard));
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
  const finalEpoch=await checkMutationEpoch(db,userId,id);if(finalEpoch.status==='retired')throw new RetiredMutationError('This mutation epoch is retired.');
  const committed=await receipt(db,userId,id);if(!committed)return {status:'conflict',currentRevision:(await readCurrent(db,userId)).revision};
  if(committed.command_hash!==hash) return (await checkReceipt())!;
  return {status:acquired?'committed':'replayed',envelope:await readCurrent(db,userId),receipt:{mutationId:id,commandHash:hash,appliedRevision:committed.revision}};
}
