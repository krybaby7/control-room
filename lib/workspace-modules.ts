import type { SqlDatabase } from './workspace-store.ts';
import type { JsonValue } from './workspace-protocol.ts';
// Closed server registry. Each payload is JSON data; SQL identifiers never come from requests.
export const OWNER_TABLES = ['weekly_plans', 'weekly_reviews', 'recurrence_rules', 'recurrence_occurrences', 'evidence_records', 'evidence_versions', 'evidence_mappings', 'evidence_links', 'evidence_requirements', 'acceptance_records', 'decisions', 'decision_records', 'decision_versions', 'attachments', 'attachment_usage', 'workspace_configuration', 'source_connections', 'source_targets', 'source_observations', 'source_sync_runs', 'source_proposals', 'integration_history'] as const;
export type RegisteredOwnerTable = typeof OWNER_TABLES[number];
export interface ModuleRow { id: string; row_revision: number; payload_json: string; content_hash: string; }
export interface GuardedWrite { table: RegisteredOwnerTable; operation: 'insert' | 'update' | 'delete'; id: string; value?: JsonValue; expectedRowRevision: number | null; }
export interface RowPrecondition { table: RegisteredOwnerTable; id: string; expectedRowRevision: number; expectedHash?: string; }
export function ownerTable(value: string): RegisteredOwnerTable {
  if (!(OWNER_TABLES as readonly string[]).includes(value)) throw new Error('Unknown owner module.');
  return value as RegisteredOwnerTable;
}
export interface OwnerScopedReader { get(table: RegisteredOwnerTable, id: string): Promise<ModuleRow | null>; list(table: RegisteredOwnerTable, options?: {after?: string; limit?: number}): Promise<ModuleRow[]>; }
export function ownerReader(db: SqlDatabase, userId: string): OwnerScopedReader {
  if (!userId) throw new Error('A signed-in owner is required.');
  return {
    get: (table,id) => db.prepare(`SELECT id, row_revision, payload_json, content_hash FROM ${ownerTable(table)} WHERE user_id = ? AND id = ?`).bind(userId,id).first<ModuleRow>(),
    async list(table, options = {}) {
      const limit = options.limit ?? 100;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('Invalid page size.');
      const result = await db.prepare(`SELECT id, row_revision, payload_json, content_hash FROM ${ownerTable(table)} WHERE user_id = ? AND id > ? ORDER BY id LIMIT ?`).bind(userId, options.after ?? '', limit).all<ModuleRow>();
      return result.results;
    },
  };
}
