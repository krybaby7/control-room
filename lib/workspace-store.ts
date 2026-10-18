import type { Workspace, WorkspaceEnvelope } from './types.ts';
import { parseWorkspaceExport, WORKSPACE_LIMITS } from './workspace-validation.ts';
import { applyCommand } from './planning.ts';

export interface SqlStatement {
  bind(...values: (string | number | null)[]): SqlStatement;
  first<T>(): Promise<T | null>;
  run(): Promise<{ meta: { changes?: number } }>;
}
export interface SqlDatabase {
  prepare(sql: string): SqlStatement;
  batch(statements: SqlStatement[]): Promise<{ meta: { changes?: number } }[]>;
}
interface Row { content: string; revision: number; updated_at: string; }
interface Receipt { command_hash: string; revision: number; }
export class MutationIdReuseError extends Error {}
export class CommandValidationError extends Error {}
function owner(userId:string): void { if (!userId) throw new Error('A signed-in user is required.'); }
function envelope(row:Row):WorkspaceEnvelope { return { workspace:parseWorkspaceExport(JSON.parse(row.content),row.updated_at,{allowLegacyMigrationOverflow:true}),revision:row.revision,updatedAt:row.updated_at }; }
async function readCurrent(db:SqlDatabase,userId:string):Promise<WorkspaceEnvelope> {
  const row = await db.prepare('SELECT content, revision, updated_at FROM workspaces WHERE user_id = ?').bind(userId).first<Row>();
  if (!row) throw new Error('The workspace could not be loaded.');
  const previous = await db.prepare('SELECT revision FROM workspace_recovery WHERE user_id = ?').bind(userId).first<{revision:number}>();
  return { ...envelope(row), previousBackupAvailable:Boolean(previous) };
}
export async function loadWorkspace(db: SqlDatabase, userId: string, seed: () => Workspace, now: string): Promise<WorkspaceEnvelope> {
  owner(userId);
  const existing = await db.prepare('SELECT revision FROM workspaces WHERE user_id = ?').bind(userId).first<{revision:number}>();
  if (!existing) {
    const initial = parseWorkspaceExport(seed(),now);
    await db.prepare('INSERT INTO workspaces (user_id, content, revision, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT(user_id) DO NOTHING').bind(userId, JSON.stringify(initial), now).run();
  }
  // Existing content is migrated in memory and saved at the next successful mutation, never reseeded.
  return readCurrent(db,userId);
}
export async function loadPreviousWorkspace(db:SqlDatabase,userId:string):Promise<WorkspaceEnvelope|null> {
  owner(userId);
  const row = await db.prepare('SELECT content, revision, updated_at FROM workspace_recovery WHERE user_id = ?').bind(userId).first<Row>();
  return row ? envelope(row) : null;
}
/** Kept for low-level CAS compatibility; application commands use mutateWorkspace receipts. */
export async function saveWorkspace(db: SqlDatabase, userId: string, revision: number, workspace: Workspace, now: string): Promise<WorkspaceEnvelope | null> {
  owner(userId);
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('A valid revision is required.');
  const validated = parseWorkspaceExport(workspace,now);
  const result = await db.prepare('UPDATE workspaces SET content = ?, revision = revision + 1, updated_at = ? WHERE user_id = ? AND revision = ?').bind(JSON.stringify(validated),now,userId,revision).run();
  if (result.meta.changes !== 1) return null;
  return readCurrent(db,userId);
}
function canonical(value:unknown):string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([,v]) => v !== undefined).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
async function commandHash(command:unknown):Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(command)));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2,'0')).join('');
}
/** A D1 batch is one transaction: receipt, pre-restore snapshot and CAS commit succeed together. */
export async function mutateWorkspace(db:SqlDatabase,userId:string,revision:number,mutationId:string,command:unknown,now:string):Promise<WorkspaceEnvelope|null> {
  owner(userId);
  if (!Number.isSafeInteger(revision) || revision < 1 || !/^[A-Za-z0-9_-]{16,128}$/.test(mutationId)) throw new CommandValidationError('A valid revision and mutation ID are required.');
  const hash = await commandHash(command);
  const readReceipt = () => db.prepare('SELECT command_hash, revision FROM workspace_mutations WHERE user_id = ? AND mutation_id = ?').bind(userId,mutationId).first<Receipt>();
  const prior = await readReceipt();
  if (prior) {
    if (prior.command_hash !== hash) throw new MutationIdReuseError('This mutation ID was reused for a different change. Start a fresh submission.');
    // Return current authoritative state, so replay never rolls back a later edit in the client.
    return readCurrent(db,userId);
  }
  const current = await readCurrent(db,userId);
  if (current.revision !== revision) return null;
  let workspace:Workspace;
  try { workspace = parseWorkspaceExport(applyCommand(current.workspace,command,now),now); }
  catch(error) { throw new CommandValidationError(error instanceof Error ? error.message : 'This change is invalid.'); }
  const content = JSON.stringify(workspace);
  if (new TextEncoder().encode(content).byteLength > WORKSPACE_LIMITS.bytes) throw new CommandValidationError('Workspace exceeds the 1 MB storage limit.');
  const statements = [db.prepare('INSERT INTO workspace_mutations (user_id, mutation_id, command_hash, revision, committed_at) SELECT ?, ?, ?, ?, ? FROM workspaces WHERE user_id = ? AND revision = ? ON CONFLICT(user_id, mutation_id) DO NOTHING').bind(userId,mutationId,hash,revision+1,now,userId,revision)];
  const restore = command !== null && typeof command === 'object' && (command as {type?:unknown}).type === 'workspace.restore';
  if (restore) statements.push(db.prepare('INSERT INTO workspace_recovery (user_id, content, revision, updated_at) SELECT user_id, content, revision, updated_at FROM workspaces WHERE user_id = ? AND revision = ? AND EXISTS (SELECT 1 FROM workspace_mutations WHERE user_id = ? AND mutation_id = ? AND command_hash = ? AND revision = ?) ON CONFLICT(user_id) DO UPDATE SET content = excluded.content, revision = excluded.revision, updated_at = excluded.updated_at').bind(userId,revision,userId,mutationId,hash,revision+1));
  statements.push(db.prepare('UPDATE workspaces SET content = ?, revision = revision + 1, updated_at = ? WHERE user_id = ? AND revision = ? AND EXISTS (SELECT 1 FROM workspace_mutations WHERE user_id = ? AND mutation_id = ? AND command_hash = ? AND revision = ?)').bind(content,now,userId,revision,userId,mutationId,hash,revision+1));
  await db.batch(statements);
  const committed = await readReceipt();
  if (!committed) return null;
  if (committed.command_hash !== hash) throw new MutationIdReuseError('This mutation ID was reused for a different change. Start a fresh submission.');
  return readCurrent(db,userId);
}
