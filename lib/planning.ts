import type { Workspace, Task, TaskInput, MilestoneInput, CaptureInput, Capture, Recommendation } from './types.ts';
import { validateTaskGraph } from './task-graph.ts';
import { currentWeek, isCurrentWeek } from './calendar.ts';
import { parseWorkspaceExport } from './workspace-validation.ts';
import { applyProjectBaseline, BASELINE_ID } from './project-baselines.ts';

const TASK_FIELDS = ['estimateMinutes','projectId', 'milestoneId', 'title', 'notes', 'status', 'horizon', 'priority', 'dueDate', 'weekly', 'dependsOn', 'blocker', 'sourceUrl', 'evidence'];
const MILESTONE_FIELDS = ['projectId', 'title', 'description', 'acceptance', 'status', 'targetDate', 'evidence'];
const CAPTURE_FIELDS = ['title', 'body', 'projectId', 'kind', 'sourceUrl'];
const DAY_MS = 86_400_000;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function fields(value: unknown, allowed: string[], label: string): Record<string, unknown> {
  const result = object(value, label);
  const unexpected = Object.keys(result).find((key) => !allowed.includes(key));
  if (unexpected) throw new Error(`${label} contains an unsupported field: ${unexpected}.`);
  return result;
}

function text(value: unknown, label: string, maximum: number, required = false): string {
  if (typeof value !== 'string') throw new Error(`${label} must be text.`);
  const result = value.trim();
  if (required && !result) throw new Error(`${label} is required.`);
  if (result.length > maximum) throw new Error(`${label} must be ${maximum} characters or fewer.`);
  return result;
}

function choice<T extends string>(value: unknown, options: readonly T[], label: string): T {
  if (typeof value !== 'string' || !options.includes(value as T)) throw new Error(`${label} must be one of: ${options.join(', ')}.`);
  return value as T;
}

function date(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${label} must be a real date in YYYY-MM-DD format.`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new Error(`${label} must be a real date in YYYY-MM-DD format.`);
  return value;
}

function optionalDate(value: unknown, label: string): string | null {
  return value === null ? null : date(value, label);
}

function sourceUrl(value: unknown): string | null {
  if (value === null) return null;
  const result = text(value, 'Source URL', 2048, true);
  let parsed: URL;
  try { parsed = new URL(result); } catch { throw new Error('Source URL must be a valid HTTP or HTTPS URL.'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || /[\u0000-\u0020\u007f]/.test(result) || parsed.username || parsed.password) {
    throw new Error('Source URL must be an HTTP or HTTPS URL without credentials or whitespace.');
  }
  return result;
}

function projectId(value: unknown, workspace: Workspace): string {
  const id = text(value, 'Project', 128, true);
  if (!workspace.projects.some((project) => project.id === id)) throw new Error('Select an existing project.');
  return id;
}

function milestoneId(value: unknown, project: string, workspace: Workspace, previousId?:string|null): string | null {
  if (value === null) return null;
  const id = text(value, 'Milestone', 128, true);
  const found = workspace.milestones.find((milestone) => milestone.id === id);
  if (!found || found.projectId !== project) throw new Error('Select a milestone belonging to this project.');
  if(found.archivedAt&&previousId!==id)throw new Error('Select an active milestone.');
  return id;
}

function validateTask(value: unknown, workspace: Workspace, existing?:Task): TaskInput {
  const data = fields(value, TASK_FIELDS, 'Task');
  const project = projectId(data.projectId, workspace);
  if(workspace.projects.find(row=>row.id===project)?.archivedAt&&existing?.projectId!==project)throw new Error('Select an active project.');
  if (typeof data.weekly !== 'boolean') throw new Error('Weekly focus must be true or false.');
  if (!Array.isArray(data.dependsOn) || data.dependsOn.length > 50) throw new Error('Dependencies must be a list of at most 50 task IDs.');
  const dependsOn = data.dependsOn.map((id) => text(id, 'Dependency ID', 128, true));
  if (new Set(dependsOn).size !== dependsOn.length) throw new Error('A dependency may appear only once; remove duplicate dependencies.');
  for (const id of dependsOn) {
    const dependency = workspace.tasks.find((task) => task.id === id);
    if (!dependency) throw new Error('Dependencies must be existing tasks in this workspace.');
  }
  if(data.estimateMinutes!==undefined && data.estimateMinutes!==null && (typeof data.estimateMinutes!=='number' || !Number.isInteger(data.estimateMinutes) || data.estimateMinutes<1 || data.estimateMinutes>10080))throw new Error('Estimate must be an integer from1 to10080 minutes, or unknown.');
  const status = choice(data.status, ['proposed', 'todo', 'doing', 'review', 'done', 'archived'] as const, 'Task status');
  if(data.weekly&&status==='proposed'&&!existing?.weekly)throw new Error('Accept a proposed task before committing it to a week.');
  return {
    estimateMinutes:(data.estimateMinutes as number|null|undefined)??null, projectId: project, milestoneId: milestoneId(data.milestoneId, project, workspace, existing?.milestoneId),
    title: text(data.title, 'Title', 200, true), notes: text(data.notes, 'Notes', 10000), status,
    horizon: choice(data.horizon, ['now', 'next', 'later'] as const, 'Horizon'),
    priority: choice(data.priority, ['high', 'normal', 'low'] as const, 'Priority'),
    dueDate: optionalDate(data.dueDate, 'Due date'), weekly: status === 'archived' ? false : data.weekly,
    dependsOn, blocker: text(data.blocker, 'Blocker', 1000), sourceUrl: sourceUrl(data.sourceUrl), evidence: text(data.evidence, 'Evidence', 5000),
  };
}

function validateMilestone(value: unknown, workspace: Workspace, previousProjectId?:string): MilestoneInput {
  const data = fields(value, MILESTONE_FIELDS, 'Milestone');
  const project=projectId(data.projectId,workspace);
  if(workspace.projects.find(row=>row.id===project)?.archivedAt&&previousProjectId!==project)throw new Error('Select an active project.');
  const status = choice(data.status, ['planned', 'active', 'achieved'] as const, 'Milestone status');
  const evidence = text(data.evidence, 'Evidence', 5000, status === 'achieved');
  return {
    projectId: project, title: text(data.title, 'Title', 200, true),
    description: text(data.description, 'Description', 5000), acceptance: text(data.acceptance, 'Acceptance criteria', 5000),
    status, targetDate: optionalDate(data.targetDate, 'Target date'), evidence,
  };
}

function validateCapture(value: unknown, workspace: Workspace): CaptureInput {
  const data = fields(value, CAPTURE_FIELDS, 'Capture');
  return {
    title: text(data.title, 'Title', 200, true), body: text(data.body, 'Capture text', 10000),
    projectId: data.projectId === null ? null : projectId(data.projectId, workspace),
    kind: choice(data.kind, ['idea', 'task', 'decision'] as const, 'Capture kind'), sourceUrl: sourceUrl(data.sourceUrl),
  };
}

function pick(source: object, names: string[]): Record<string, unknown> {
  return Object.fromEntries(names.map((name) => [name, (source as Record<string, unknown>)[name]]));
}

function findById<T extends { id: string }>(items: T[], value: unknown, label: string): T {
  const id = text(value, `${label} ID`, 128, true);
  const item = items.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`${label} could not be found. Refresh and try again.`);
  return item;
}

function capacity(current: number, maximum: number, label: string): void {
  if (current >= maximum) throw new Error(`This workspace has reached its limit of ${maximum} ${label}.`);
}

function timestamp(value: string | undefined): string {
  const parsed = value === undefined ? new Date() : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error('The current timestamp is invalid.');
  return parsed.toISOString();
}


/** Commands operate on a clone so rejected commands cannot partially change saved state. */
export function applyCommand(workspace: Workspace, command: unknown, now?: string, options:{baselineRemovedIds?:readonly string[]}={}): Workspace {
  const data = object(command, 'Command');
  const at = timestamp(now);
  const next = structuredClone(workspace);
  let activityText: string;
  let activityProject: string | null;

  switch (data.type) {
    case 'baseline.apply': {
      fields(data, ['type', 'projectId', 'baselineId'], 'Command');
      const project = projectId(data.projectId, next);
      const baseline = choice(data.baselineId, [BASELINE_ID] as const, 'Baseline');
      return applyProjectBaseline(next, project, baseline, at, options.baselineRemovedIds);
    }
    case 'workspace.restore': {
      fields(data, ['type', 'workspace'], 'Command');
      return parseWorkspaceExport(data.workspace);
    }
    case 'task.restore': {
      fields(data, ['type', 'id'], 'Command');
      const existing = findById(next.tasks, data.id, 'Task');
      if (existing.status !== 'archived') throw new Error('Only archived tasks can be restored.');
      existing.status = existing.archivedFromStatus ?? (existing.completedAt ? 'done' : 'todo');
      existing.archivedFromStatus = null;
      existing.updatedAt = at;
      validateTaskGraph(next);
      activityText = `Restored task: ${existing.title}`;
      activityProject = existing.projectId;
      break;
    }
    case 'task.create': {
      fields(data, ['type', 'task'], 'Command');
      capacity(next.tasks.length, 2000, 'tasks');
      const input = validateTask(data.task, next);
      const created: Task = { ...input, id: crypto.randomUUID(), createdAt: at, updatedAt: at, completedAt: input.status === 'done' ? at : null, weeklyWeek: input.weekly ? currentWeek(at) : null, archivedFromStatus: input.status === 'archived' ? 'todo' : null };
      next.tasks.push(created);
      validateTaskGraph(next);
      activityText = `Created task: ${created.title}`;
      activityProject = created.projectId;
      break;
    }
    case 'task.update': {
      fields(data, ['type', 'id', 'patch'], 'Command');
      const existing = findById(next.tasks, data.id, 'Task');
      const patch = fields(data.patch, TASK_FIELDS, 'Task patch');
      const input = validateTask({ ...pick(existing, TASK_FIELDS), ...patch }, next, existing);
      if (input.projectId !== existing.projectId) throw new Error('An existing task cannot move to another project. Create a new task in that project instead.');
      const archivedFromStatus = input.status === 'archived'
        ? existing.status === 'archived' ? existing.archivedFromStatus ?? (existing.completedAt ? 'done' : 'todo') : existing.status
        : null;
      const completedAt = input.status === 'done' || input.status === 'archived' && archivedFromStatus === 'done' ? existing.completedAt ?? at : null;
      const weeklyWeek = input.weekly ? ('weekly' in patch && patch.weekly === true ? currentWeek(at) : existing.weeklyWeek ?? currentWeek(existing.updatedAt)) : null;
      Object.assign(existing, input, { updatedAt: at, completedAt, archivedFromStatus, weeklyWeek });
      validateTaskGraph(next);
      activityText = `Updated task: ${existing.title}`;
      activityProject = existing.projectId;
      break;
    }
    case 'milestone.create': {
      fields(data, ['type', 'milestone'], 'Command');
      capacity(next.milestones.length, 100, 'milestones');
      const input = validateMilestone(data.milestone, next);
      next.milestones.push({ ...input, id: crypto.randomUUID(), updatedAt: at, archivedAt:null, sortKey:Math.max(-1,...next.milestones.filter(row=>row.projectId===input.projectId).map(row=>row.sortKey))+1 });
      activityText = `Created milestone: ${input.title}`;
      activityProject = input.projectId;
      break;
    }
    case 'milestone.update': {
      fields(data, ['type', 'id', 'patch'], 'Command');
      const existing = findById(next.milestones, data.id, 'Milestone');
      const patch = fields(data.patch, MILESTONE_FIELDS, 'Milestone patch');
      const input = validateMilestone({ ...pick(existing, MILESTONE_FIELDS), ...patch }, next, existing.projectId);
      if (input.projectId !== existing.projectId) throw new Error('An existing milestone cannot move to another project. Create a new milestone in that project instead.');
      Object.assign(existing, input, { updatedAt: at });
      activityText = `Updated milestone: ${existing.title}`;
      activityProject = existing.projectId;
      break;
    }
    case 'project.update': {
      fields(data, ['type', 'id', 'patch'], 'Command');
      const existing = findById(next.projects, data.id, 'Project');
      const patch = fields(data.patch, ['description', 'goal'], 'Project patch');
      if ('description' in patch) existing.description = text(patch.description, 'Description', 5000);
      if ('goal' in patch) existing.goal = text(patch.goal, 'Goal', 5000);
      activityText = `Updated project: ${existing.name}`;
      activityProject = existing.id;
      break;
    }
    case 'capture.create': {
      fields(data, ['type', 'capture'], 'Command');
      capacity(next.captures.length, 1000, 'captures');
      const input = validateCapture(data.capture, next);
      next.captures.push({ ...input, id: crypto.randomUUID(), status: 'inbox', createdAt: at, convertedTaskId: null });
      activityText = `Captured ${input.kind}: ${input.title}`;
      activityProject = input.projectId;
      break;
    }
    case 'capture.update': {
      fields(data, ['type', 'id', 'patch'], 'Command');
      const existing = findById(next.captures, data.id, 'Capture');
      const patch = fields(data.patch, [...CAPTURE_FIELDS, 'status'], 'Capture patch');
      const { status: newStatus, ...inputPatch } = patch;
      const input = validateCapture({ ...pick(existing, CAPTURE_FIELDS), ...inputPatch }, next);
      const status: Capture['status'] = 'status' in patch ? choice(newStatus, ['inbox', 'filed', 'archived'] as const, 'Capture status') : existing.status;
      Object.assign(existing, input, { status });
      activityText = `Updated capture: ${existing.title}`;
      activityProject = existing.projectId;
      break;
    }
    case 'capture.convert': {
      fields(data, ['type', 'id', 'milestoneId', 'horizon', 'projectId'], 'Command');
      const existing = findById(next.captures, data.id, 'Capture');
      if (existing.convertedTaskId) throw new Error('This capture has already been converted to a task.');
      if (existing.status === 'archived') throw new Error('Restore this archived capture before converting it.');
      const selectedProject = 'projectId' in data ? projectId(data.projectId, next) : existing.projectId;
      if (!selectedProject) throw new Error('Assign this capture to a project before converting it.');
      capacity(next.tasks.length, 2000, 'tasks');
      const input = validateTask({
        projectId: selectedProject, milestoneId: data.milestoneId, title: existing.title, notes: existing.body,
        status: 'proposed', horizon: data.horizon, priority: 'normal', dueDate: null, weekly: false,
        dependsOn: [], blocker: '', sourceUrl: existing.sourceUrl, evidence: '',
      }, next);
      const id = crypto.randomUUID();
      next.tasks.push({ ...input, id, createdAt: at, updatedAt: at, completedAt: null, weeklyWeek: null, archivedFromStatus: null });
      existing.projectId = input.projectId;
      existing.status = 'filed';
      existing.convertedTaskId = id;
      activityText = `Converted capture to suggested task: ${existing.title}`;
      activityProject = existing.projectId;
      break;
    }
    default: throw new Error('Unknown command. Refresh the app and try again.');
  }

  next.activity.push({ id: crypto.randomUUID(), text: activityText, at, projectId: activityProject });
  next.activity = next.activity.slice(-100);
  return next;
}

export function getBlockers(task: Task, workspace: Workspace): string[] {
  const blockers: string[] = [];
  if (task.blocker.trim()) blockers.push(task.blocker.trim());
  for (const id of task.dependsOn) {
    const dependency = workspace.tasks.find((candidate) => candidate.id === id);
    if (!dependency) blockers.push('A dependency is missing or unavailable.');
    else if (dependency.status === 'archived' && dependency.archivedFromStatus !== 'done') blockers.push(`Archived dependency “${dependency.title}” must be restored and completed, or removed.`);
    else if (dependency.status === 'archived' && dependency.archivedFromStatus === 'done') continue;
    else if (dependency.status !== 'done') blockers.push(`Complete “${dependency.title}” first.`);
  }
  return blockers;
}

function dateDistance(target: string, today: string): number {
  return Math.round((Date.parse(`${target}T00:00:00.000Z`) - Date.parse(`${today}T00:00:00.000Z`)) / DAY_MS);
}

function rank(task: Task, today: string): { score: number; reason: string } {
  let score = { high: 60, normal: 25, low: 0 }[task.priority] + { now: 25, next: 10, later: 0 }[task.horizon];
  const reasons: string[] = [];
  if (isCurrentWeek({ ...task, weeklyWeek: task.weeklyWeek ?? currentWeek(task.updatedAt) }, today)) { score += 100; reasons.push('selected for weekly focus'); }
  if (task.priority === 'high') reasons.push('high priority');
  if (task.status === 'review') { score += 40; reasons.push('ready for your review'); }
  if (task.status === 'doing') { score += 30; reasons.push('already in progress'); }
  if (task.dueDate) {
    const days = dateDistance(task.dueDate, today);
    if (days < 0) { score += 80; reasons.push(`overdue since ${task.dueDate}`); }
    else if (days === 0) { score += 75; reasons.push('due today'); }
    else if (days <= 7) { score += 60 - days * 3; reasons.push(`due in ${days} ${days === 1 ? 'day' : 'days'}`); }
  }
  if (task.horizon === 'now') reasons.push('in Now');
  if (!reasons.length) reasons.push(`ready to consider in ${task.horizon === 'next' ? 'Next' : 'Later'}`);
  return { score, reason: `${task.status === 'proposed' ? 'Suggestion: ' : ''}${reasons.join('; ')}.` };
}

/** Rank within each project, then alternate projects so neither crowds the other out. */
export function getRecommendations(workspace: Workspace, today: string): Recommendation[] {
  date(today, 'Today date');
  const ranked = workspace.tasks
    .filter((task) => !['done', 'archived'].includes(task.status) && !workspace.projects.find(project=>project.id===task.projectId)?.archivedAt && !workspace.milestones.find(milestone=>milestone.id===task.milestoneId)?.archivedAt && getBlockers(task, workspace).length === 0)
    .map((task, index) => ({ task, index, ...rank(task, today) }));
  const groups = workspace.projects.map((project) => ranked
    .filter((entry) => entry.task.projectId === project.id)
    .sort((a, b) => b.score - a.score || a.index - b.index));
  const result: Recommendation[] = [];
  for (let index = 0; ; index += 1) {
    let added = false;
    for (const group of groups) {
      const entry = group[index];
      if (entry) {
        result.push({ taskId: entry.task.id, reason: entry.reason });
        added = true;
      }
    }
    if (!added) break;
  }
  return result;
}
