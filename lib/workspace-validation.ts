import { z } from 'zod';
import { validateTaskGraph } from './task-graph.ts';
import { migratePlanningV3ToV4 } from './planning-migration.ts';
import { currentWeek } from './calendar.ts';
import type { Workspace } from './types.ts';
import { migratePlanningV1ToV2, migratePlanningV2ToV3, measurePlanning } from './workspace-migrations.ts';
export const WORKSPACE_LIMITS = { tasks: 2000, captures: 1000, milestones: 100, bytes: 1_000_000, serializedBytes: 1_250_000 } as const;
export class WorkspaceValidationError extends Error {}
const id = z.string().min(1).max(128).regex(/^\S(?:[\s\S]*\S)?(?![\s\S])/u, 'Invalid input');
const text = (max: number, required = false) => required ? z.string().max(max).regex(/\S/u, 'Invalid input') : z.string().max(max);
const stamp = z.string().datetime({ offset: true });
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => { try { return new Date(`${s}T00:00:00Z`).toISOString().slice(0,10) === s; } catch { return false; } });
const url = z.string().max(2048).refine(s => { try { const u = new URL(s); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password && !/[\u0000-\u0020\u007f]/.test(s); } catch { return false; } });
const liveStatus = z.enum(['proposed', 'todo', 'doing', 'review', 'done']);
const taskSchema = z.object({
  id, projectId:id, milestoneId:id.nullable(), title:text(200,true), notes:text(10000), status:z.enum(['proposed','todo','doing','review','done','archived']),
  horizon:z.enum(['now','next','later']), priority:z.enum(['high','normal','low']), dueDate:day.nullable(), weekly:z.boolean(), dependsOn:z.array(id).max(50),
  blocker:text(1000), sourceUrl:url.nullable(), evidence:text(5000), createdAt:stamp, updatedAt:stamp, completedAt:stamp.nullable(),
  estimateMinutes:z.number().int().min(1).max(10080).nullable().optional(), weeklyWeek:day.nullable().optional(), archivedFromStatus:liveStatus.nullable().optional(),
}).strict();
const workspaceSchema = z.object({
  schemaVersion:z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  projects:z.array(z.object({id,name:text(200,true),description:text(5000),goal:text(5000),color:z.enum(['orange','teal']),priority:z.literal('equal'),archivedAt:stamp.nullable().optional(),repositories:z.array(z.object({name:text(200,true),url}).strict()).max(100)}).strict()).max(100),
  milestones:z.array(z.object({id,projectId:id,title:text(200,true),description:text(5000),acceptance:text(5000),status:z.enum(['planned','active','achieved']),targetDate:day.nullable(),evidence:text(5000),updatedAt:stamp,archivedAt:stamp.nullable().optional(),sortKey:z.number().int().nonnegative().safe().optional()}).strict()).max(WORKSPACE_LIMITS.milestones),
  tasks:z.array(taskSchema).max(WORKSPACE_LIMITS.tasks),
  captures:z.array(z.object({id,title:text(200,true),body:text(10000),projectId:id.nullable(),kind:z.enum(['idea','task','decision']),sourceUrl:url.nullable(),status:z.enum(['inbox','filed','archived']),createdAt:stamp,convertedTaskId:id.nullable()}).strict()).max(WORKSPACE_LIMITS.captures),
  activity:z.array(z.object({id,text:text(10000,true),at:stamp,projectId:id.nullable()}).strict()).max(100),
}).strict();
function fail(message: string): never { throw new WorkspaceValidationError(message); }
/** Strict import and storage boundary. The saved timestamp anchors legacy weekly commitments. */
export function parseWorkspaceExport(value: unknown, savedAt?: string, options: { allowLegacyMigrationOverflow?: boolean } = {}): Workspace {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Workspace export must be an object.');
  const wrapper = value as Record<string,unknown>;
  const raw = 'workspace' in wrapper ? wrapper.workspace : value;
  const version = raw && typeof raw === 'object' ? (raw as Record<string,unknown>).schemaVersion : undefined;
  if (version !== 1 && version !== 2 && version !== 3 && version !== 4) fail('Unsupported workspace schema version.');
  const parsed = workspaceSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    fail(`Invalid workspace ${issue.path.join('.') || 'document'}: ${issue.message}`);
  }
  void options; // Legacy callers no longer need a migration overflow exception.
  const anchor = savedAt ?? (typeof wrapper.updatedAt === 'string' ? wrapper.updatedAt : undefined);
  if (anchor && !stamp.safeParse(anchor).success) fail('Workspace saved timestamp is invalid.');
  let ws: Workspace = parsed.data as Workspace;
  if (ws.schemaVersion === 1) ws = migratePlanningV1ToV2(ws, anchor);
  if (ws.schemaVersion === 2) {
    if (ws.tasks.some(task => task.weeklyWeek === undefined || task.archivedFromStatus === undefined)) fail('Version 2 tasks require weekly and archive history fields.');
    ws = migratePlanningV2ToV3(ws);
  }
  if(ws.schemaVersion===3)ws=migratePlanningV3ToV4(ws);
  const milestonePositions=new Map<string,number>();
  ws.projects=ws.projects.map(project=>({...project,archivedAt:project.archivedAt??null}));
  ws.milestones=ws.milestones.map(milestone=>{const next=milestonePositions.get(milestone.projectId)??0;milestonePositions.set(milestone.projectId,next+1);return {...milestone,archivedAt:milestone.archivedAt??null,sortKey:milestone.sortKey??next};});
  const milestoneKeys=new Set<string>();for(const milestone of ws.milestones){const key=JSON.stringify([milestone.projectId,milestone.sortKey]);if(milestoneKeys.has(key))fail('Milestone ordering keys must be unique per project.');milestoneKeys.add(key);}
  ws.tasks = ws.tasks.map(task => ({ ...task, estimateMinutes:task.estimateMinutes??null, weeklyWeek: task.weeklyWeek ?? null, archivedFromStatus: task.archivedFromStatus ?? null }));
  const allIds = new Set<string>();
  for (const entry of [...ws.projects, ...ws.milestones, ...ws.tasks, ...ws.captures, ...ws.activity]) {
    if (allIds.has(entry.id)) fail('Workspace IDs must be unique.');
    allIds.add(entry.id);
  }
  const projects = new Set(ws.projects.map(p => p.id));
  const tasks = new Map(ws.tasks.map(t => [t.id,t]));
  const milestones = new Map(ws.milestones.map(m => [m.id,m]));
  const project = (id:string|null) => { if (id !== null && !projects.has(id)) fail('Workspace refers to a missing project.'); };
  for (const milestone of ws.milestones) { project(milestone.projectId); if (milestone.status === 'achieved' && !milestone.evidence.trim()) fail('Achieved milestones require evidence.'); }
  for (const capture of ws.captures) { project(capture.projectId); if (capture.convertedTaskId !== null && !tasks.has(capture.convertedTaskId)) fail('Capture refers to a missing converted task.'); }
  for (const activity of ws.activity) project(activity.projectId);
  for (const task of ws.tasks) {
    project(task.projectId);
    if (task.milestoneId !== null && milestones.get(task.milestoneId)?.projectId !== task.projectId) fail('Task milestone belongs to a missing or different project.');
    if (new Set(task.dependsOn).size !== task.dependsOn.length) fail('Duplicate dependencies are invalid.');
    for (const dependencyId of task.dependsOn) if (!tasks.has(dependencyId)) fail('Dependency refers to a missing task.');
    if (task.weeklyWeek !== null && currentWeek(task.weeklyWeek!) !== task.weeklyWeek) fail('Weekly commitment must identify a Monday.');
    if (task.weekly && !task.weeklyWeek) fail('Weekly commitment requires its saved week.');
    if (task.status === 'archived' && (task.weekly || !task.archivedFromStatus)) fail('Archived tasks require their previous status and cannot be pinned.');
    if (task.status !== 'archived' && task.archivedFromStatus !== null) fail('Only archived tasks have a previous status.');
    const completed = task.status === 'done' || task.status === 'archived' && task.archivedFromStatus === 'done';
    if (completed !== Boolean(task.completedAt)) fail('Task completion history must agree with its status.');
  }
  try{validateTaskGraph(ws);}catch(error){fail(error instanceof Error?error.message:'Invalid dependency graph.');}
  const measured = measurePlanning(ws);
  if (measured.contentBytes > WORKSPACE_LIMITS.bytes) fail('Workspace exceeds the 1 MB user-content storage limit.');
  if (measured.serializedBytes > WORKSPACE_LIMITS.serializedBytes) fail('Workspace exceeds the 1.25 MB serialized storage limit.');
  return ws;
}
