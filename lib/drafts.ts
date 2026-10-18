import { z } from 'zod';
import type { SqlDatabase } from './workspace-store.ts';

export const DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const DRAFT_MAX_BYTES = 64 * 1024;
const token = z.string().min(1).max(160);
export const draftSchema = z.object({
  id: token, baseRevision: z.number().int().nonnegative(), entityType: token,
  entityId: token.optional(), baseSnapshot: z.record(z.unknown()), changedFields: z.record(z.unknown()),
  command: z.record(z.unknown()).optional(), mutationId: token.optional(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(), expiresAt: z.string().datetime(),
}).strict();
export type Draft = z.infer<typeof draftSchema>;
export type SavedDraft = Draft & { draftRevision: number };
/** Only ordinary bounded JSON data is retained; never serialize getters, classes or credentials. */
export function validateDraft(value: unknown): Draft {
  const visit = (v: unknown, depth = 0): void => {
    if (depth > 24) throw new Error('Draft nesting exceeds limit.');
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
    if (typeof v === 'number' && Number.isFinite(v)) return;
    if (typeof v !== 'object' || (Object.getPrototypeOf(v) !== Object.prototype && !Array.isArray(v))) throw new Error('Draft must contain plain JSON.');
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(v))) {
      if (Array.isArray(v) && key === 'length') continue;
      if (!('value' in descriptor) || /^(?:__proto__|prototype|constructor|password|authorization|accessToken|refreshToken|deviceKey|executionApproval)$/i.test(key)) throw new Error('Unsupported private or executable draft field.');
      visit(descriptor.value, depth + 1);
    }
  };
  visit(value);
  const draft = draftSchema.parse(value);
  if (new TextEncoder().encode(JSON.stringify(draft)).byteLength > DRAFT_MAX_BYTES) throw new Error('Draft exceeds 64 KiB.');
  if (Date.parse(draft.expiresAt) <= Date.parse(draft.updatedAt) || Date.parse(draft.expiresAt) - Date.parse(draft.updatedAt) > DRAFT_TTL_MS) throw new Error('Invalid draft retention.');
  return JSON.parse(JSON.stringify(draft)) as Draft;
}
function owner(id: string) { if (!id) throw new Error('Authenticated owner required.'); }
interface Row { payload_json: string; row_revision: number }
function decode(row: Row): SavedDraft { return { ...validateDraft(JSON.parse(row.payload_json)), draftRevision: row.row_revision }; }
export async function listDrafts(db: SqlDatabase, userId: string, now = new Date().toISOString()): Promise<SavedDraft[]> {
  owner(userId);
  const rows = await db.prepare('SELECT payload_json, row_revision FROM workspace_drafts WHERE user_id = ? AND expires_at > ? ORDER BY id LIMIT 100').bind(userId, now).all<Row>();
  return rows.results.map(decode);
}
export async function saveDraft(db: SqlDatabase, userId: string, value: unknown, expectedRevision: number, now = new Date().toISOString()): Promise<{ status: 'saved'; draft: SavedDraft } | { status: 'conflict'; draft: SavedDraft | null }> {
  owner(userId);
  const input = validateDraft(value);
  if (!Number.isFinite(Date.parse(now)) || Date.parse(input.createdAt) > Date.parse(now)) throw new Error('Invalid draft creation time.');
  const draft = validateDraft({...input, updatedAt:now, expiresAt:new Date(Date.parse(now)+DRAFT_TTL_MS).toISOString()});
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || draft.expiresAt <= now) throw new Error('Invalid draft revision or expiry.');
  const result = expectedRevision === 0
    ? await db.prepare('INSERT INTO workspace_drafts(user_id,id,row_revision,payload_json,expires_at) SELECT ?,?,1,?,? WHERE (SELECT COUNT(*) FROM workspace_drafts WHERE user_id = ? AND expires_at > ?) < 100 ON CONFLICT(user_id,id) DO NOTHING').bind(userId,draft.id,JSON.stringify(draft),draft.expiresAt,userId,now).run()
    : await db.prepare('UPDATE workspace_drafts SET row_revision=row_revision+1,payload_json=?,expires_at=? WHERE user_id=? AND id=? AND row_revision=? AND expires_at > ?').bind(JSON.stringify(draft),draft.expiresAt,userId,draft.id,expectedRevision,now).run();
  const row = await db.prepare('SELECT payload_json,row_revision FROM workspace_drafts WHERE user_id=? AND id=? AND expires_at > ?').bind(userId,draft.id,now).first<Row>();
  if (result.meta.changes !== 1) return { status:'conflict', draft:row ? decode(row) : null };
  return { status:'saved', draft:{...draft,draftRevision:expectedRevision+1} };
}
/** Call only after confirmed committed receipt, or explicit owner discard. CAS protects a newer edit. */
export async function deleteDraft(db:SqlDatabase,userId:string,id:string,revision:number):Promise<boolean> {
  owner(userId); token.parse(id);
  return (await db.prepare('DELETE FROM workspace_drafts WHERE user_id=? AND id=? AND row_revision=?').bind(userId,id,revision).run()).meta.changes === 1;
}
export async function expireDrafts(db:SqlDatabase,userId:string,now=new Date().toISOString()):Promise<void> {
  owner(userId); await db.prepare('DELETE FROM workspace_drafts WHERE user_id=? AND expires_at <= ?').bind(userId,now).run();
}
/** Serial saves coalesce edits; cancel invalidates both scheduled and in-flight callbacks. */
export function createDraftDebouncer<T>(save:(value:T)=>Promise<void>,delay=1000,onError:(error:unknown)=>void=()=>{}) {
  let timer:ReturnType<typeof setTimeout>|undefined; let generation=0; let chain=Promise.resolve();
  return {
    schedule(value:T) { clearTimeout(timer); const current=generation; timer=setTimeout(()=>{ chain=chain.then(async()=>{ if(current===generation) await save(value); }).catch(onError); },delay); },
    cancel() { generation++; clearTimeout(timer); },
    async settled() { await chain; },
  };
}
