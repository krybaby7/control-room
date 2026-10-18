import {currentWeek} from './calendar.ts';
import {weeklyPlanSchema,hydrateCurrentWeeklyPins} from './weekly-planning.ts';
import {getProjectBaseline,baselineRecordId} from './project-baselines.ts';
import type { Workspace, WorkspaceEnvelope } from './types.ts';
import { parseWorkspaceExport } from './workspace-validation.ts';
import { encodePlanning, decodePlanning } from './workspace-codec.ts';
export { MutationIdReuseError, CommandValidationError } from './workspace-errors.ts';

export interface SqlStatement {
  bind(...values: (string | number | null)[]): SqlStatement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{results:T[]}>;
  run(): Promise<{ meta: { changes?: number } }>;
}
export interface SqlDatabase {
  prepare(sql: string): SqlStatement;
  batch(statements: SqlStatement[]): Promise<{ meta: { changes?: number } }[]>;
}
interface Row { content: string; revision: number; updated_at: string; }
function owner(userId:string): void { if (!userId) throw new Error('A signed-in user is required.'); }
function envelope(row:Row):WorkspaceEnvelope { return { workspace:decodePlanning(row.content,row.updated_at),revision:row.revision,updatedAt:row.updated_at }; }
export async function readCurrent(db:SqlDatabase,userId:string,now:string=new Date().toISOString()):Promise<WorkspaceEnvelope> {
  const row = await db.prepare('SELECT content, revision, updated_at FROM workspaces WHERE user_id = ?').bind(userId).first<Row>();
  if (!row) throw new Error('The workspace could not be loaded.');
  const previous = await db.prepare('SELECT revision FROM workspace_recovery WHERE user_id = ?').bind(userId).first<{revision:number}>();
  const current=envelope(row);
  const weekly=await db.prepare('SELECT payload_json FROM weekly_plans WHERE user_id=? AND id=?').bind(userId,currentWeek(now)).first<{payload_json:string}>();
  if(weekly)current.workspace=hydrateCurrentWeeklyPins(current.workspace,weeklyPlanSchema.parse(JSON.parse(weekly.payload_json)),now);
  const candidates=current.workspace.projects.flatMap(project=>{const baseline=getProjectBaseline(project);return baseline?[...baseline.actions.map(action=>baselineRecordId(project.id,action.key)),baselineRecordId(project.id,'context')]:[];});
  const removed=candidates.length?(await db.prepare("SELECT DISTINCT entity_id FROM audit_events WHERE user_id=? AND kind='entity.delete' AND entity_type IN ('task','capture') AND entity_id IN (SELECT value FROM json_each(?)) ORDER BY entity_id").bind(userId,JSON.stringify(candidates)).all<{entity_id:string}>()).results.map(row=>row.entity_id):[];
  return {...current,previousBackupAvailable:Boolean(previous),...(removed.length?{baselineRemovedIds:removed}:{})};
}
export async function loadWorkspace(db: SqlDatabase, userId: string, seed: () => Workspace, now: string): Promise<WorkspaceEnvelope> {
  owner(userId);
  const existing = await db.prepare('SELECT revision FROM workspaces WHERE user_id = ?').bind(userId).first<{revision:number}>();
  if (!existing) {
    const initial = parseWorkspaceExport(seed(),now);
    await db.prepare('INSERT INTO workspaces (user_id, content, revision, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT(user_id) DO NOTHING').bind(userId, encodePlanning(initial), now).run();
  }
  // Existing content is migrated in memory and saved at the next successful mutation, never reseeded.
  return readCurrent(db,userId,now);
}
export async function loadPreviousWorkspace(db:SqlDatabase,userId:string):Promise<WorkspaceEnvelope|null> {
  owner(userId);
  const row = await db.prepare('SELECT content, revision, updated_at FROM workspace_recovery WHERE user_id = ?').bind(userId).first<Row>();
  return row ? envelope(row) : null;
}
/** Legacy adapter; all production commands now reach the shared executor. */
export async function mutateWorkspace(db:SqlDatabase,userId:string,revision:number,mutationId:string,command:unknown,now:string):Promise<WorkspaceEnvelope|null> {
  const { executeWorkspaceCommand } = await import('./workspace-transaction.ts');
  const { workspaceHandlers } = await import('./workspace-handlers.ts');
  const result = await executeWorkspaceCommand(userId,{protocolVersion:1,expectedRevision:revision,mutationId,command}, {db,now:()=>now,handlers:workspaceHandlers});
  return result.status === 'conflict' ? null : result.envelope;
}
