import type { Workspace, WorkspaceEnvelope } from './types.ts';

export interface SqlStatement {
  bind(...values: (string | number | null)[]): SqlStatement;
  first<T>(): Promise<T | null>;
  run(): Promise<{ meta: { changes?: number } }>;
}
export interface SqlDatabase { prepare(sql: string): SqlStatement; }

interface Row { content: string; revision: number; updated_at: string; }

export async function loadWorkspace(db: SqlDatabase, userId: string, seed: () => Workspace, now: string): Promise<WorkspaceEnvelope> {
  if (!userId) throw new Error('A signed-in user is required.');
  let row = await db.prepare('SELECT content, revision, updated_at FROM workspaces WHERE user_id = ?').bind(userId).first<Row>();
  if (!row) {
    await db.prepare('INSERT INTO workspaces (user_id, content, revision, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT(user_id) DO NOTHING').bind(userId, JSON.stringify(seed()), now).run();
    row = await db.prepare('SELECT content, revision, updated_at FROM workspaces WHERE user_id = ?').bind(userId).first<Row>();
  }
  if (!row) throw new Error('The workspace could not be loaded.');
  return { workspace: JSON.parse(row.content) as Workspace, revision: row.revision, updatedAt: row.updated_at };
}

export async function saveWorkspace(db: SqlDatabase, userId: string, revision: number, workspace: Workspace, now: string): Promise<WorkspaceEnvelope | null> {
  if (!userId || !Number.isSafeInteger(revision) || revision < 1) throw new Error('A valid owner and revision are required.');
  const content = JSON.stringify(workspace);
  if (new TextEncoder().encode(content).byteLength > 1_000_000) throw new Error('Your workspace has reached its storage limit. Export a backup and shorten large saved excerpts.');
  const result = await db.prepare('UPDATE workspaces SET content = ?, revision = revision + 1, updated_at = ? WHERE user_id = ? AND revision = ?').bind(content, now, userId, revision).run();
  if (result.meta.changes !== 1) return null;
  return { workspace, revision: revision + 1, updatedAt: now };
}
