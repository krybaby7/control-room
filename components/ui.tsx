import {taskContext,WORK_TYPE_LABELS} from '@/lib/areas';
import { ArrowUpRight, Check, Circle, CircleDashed, CircleDot, Clock3, GitBranch, Mountain, Pin, Sparkles } from 'lucide-react';
import type { Project, Task, TaskStatus, Workspace } from '@/lib/types';
import { getBlockers } from '@/lib/planning';
import { cairoDate, isCurrentWeek } from '@/lib/calendar';

export const statusLabels: Record<TaskStatus, string> = { proposed: 'Proposed', todo: 'To do', doing: 'In progress', review: 'In review', done: 'Done', archived: 'Archived' };
export const horizonLabels = { now: 'Now', next: 'Next', later: 'Later' };
export function cairoToday() {
  return cairoDate();
}
let shortDateFormatter:Intl.DateTimeFormat|undefined,fullDateFormatter:Intl.DateTimeFormat|undefined;
export function dateLabel(value: string | null, full = false) {
  if (!value) return 'No target date';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00Z`) : new Date(value);
  const formatter=full?(fullDateFormatter??=new Intl.DateTimeFormat('en-GB',{day:'numeric',month:'long',year:'numeric',timeZone:'Africa/Cairo'})):(shortDateFormatter??=new Intl.DateTimeFormat('en-GB',{day:'numeric',month:'short',timeZone:'Africa/Cairo'}));
  return formatter.format(date);
}
export function ProjectIcon({ project, small = false }: { project: Project; small?: boolean }) {
  return <span className={`project-icon ${project.color} ${small ? 'small' : ''}`} aria-hidden="true">{project.color === 'orange' ? <Mountain size={small ? 18 : 25} strokeWidth={1.8} /> : <GitBranch size={small ? 18 : 25} strokeWidth={1.8} />}</span>;
}
export function Status({ status }: { status: TaskStatus }) {
  const Icon = status === 'done' ? Check : status === 'doing' ? CircleDot : status === 'proposed' ? CircleDashed : status === 'review' ? Clock3 : Circle;
  return <span className={`status status-${status}`}><Icon size={12} />{statusLabels[status]}</span>;
}
export function EmptyState({ title, text, action }: { title: string; text: string; action?: React.ReactNode }) {
  return <div className="empty-state"><span className="empty-symbol"><Sparkles size={21} strokeWidth={1.5} /></span><h3>{title}</h3><p>{text}</p>{action}</div>;
}
export function TaskContext({task,workspace,showProject=true}:{task:Pick<Task,'projectId'|'areaId'|'workType'>;workspace:Workspace;showProject?:boolean}){
 const project=workspace.projects.find(row=>row.id===task.projectId),area=(workspace.areas??[]).find(row=>row.id===task.areaId&&row.projectId===task.projectId);
 const type=WORK_TYPE_LABELS[task.workType??'other'],label=taskContext(project?.name??'Unknown project',area?.name??null,type);
 return <span className="task-context" aria-label={label}>{showProject?label:[area?.name??'Unclassified',type].join(' / ')}{area?.archivedAt?' · Area archived':''}</span>;
}
export function TaskRow({ task, workspace, reason, onEdit, onPin, busy, showProject = true }: { task: Task; workspace: Workspace; reason?: string; onEdit: (task: Task) => void; onPin: (task: Task) => void; busy: boolean; showProject?: boolean }) {
  const project = workspace.projects.find(p => p.id === task.projectId);
  const blockers = getBlockers(task, workspace);
  const overdue = task.dueDate && task.dueDate < cairoToday() && !['done', 'archived'].includes(task.status);
  const pinned = isCurrentWeek(task);
  return <article className={`task-row ${task.status === 'done' ? 'task-done' : ''}`}>
    <button className="task-open" onClick={() => onEdit(task)} aria-label={`Edit task: ${task.title} · ${taskContext(project?.name??'Unknown project',(workspace.areas??[]).find(area=>area.id===task.areaId)?.name??null,WORK_TYPE_LABELS[task.workType??'other'])}`}>
      <span className={`task-check ${task.status}`} aria-hidden="true">{task.status === 'done' ? <Check size={15} /> : task.status === 'doing' ? <span /> : null}</span>
      <span className="task-copy"><span className="task-title">{task.title}</span>{reason && <span className="task-reason">{reason}</span>}
        <span className="task-meta">{showProject && project && <span className={`project-label ${project.color}`}><i />{project.name}</span>}<TaskContext task={task} workspace={workspace} showProject={false} /><Status status={task.status} />{task.priority === 'high' && <span className="priority">High priority</span>}{task.dueDate && <span className={overdue ? 'overdue' : ''}>{overdue ? 'Overdue · ' : ''}{dateLabel(task.dueDate)}</span>}</span>
        {blockers.length > 0 && <span className="blocker-text">Blocked: {blockers.join(' · ')}</span>}
      </span>
    </button>
    <button className={`icon-button pin-button ${pinned ? 'pinned' : ''}`} aria-label={`${pinned ? 'Remove from' : 'Add to'} this week's focus: ${task.title}`} title={task.status==='proposed'&&!pinned?'Accept this task before committing it to a week':pinned ? "Remove from this week's focus" : "Add to this week's focus"} aria-pressed={pinned} disabled={busy || task.status === 'archived'||(task.status==='proposed'&&!pinned)} onClick={() => onPin(task)}><Pin size={16} /></button>
  </article>;
}
export function ProjectCard({ project, workspace, onOpen }: { project: Project; workspace: Workspace; onOpen: () => void }) {
  const tasks = workspace.tasks.filter(t => t.projectId === project.id && t.status !== 'archived');
  const active = tasks.filter(t => !['done', 'proposed'].includes(t.status)).length;
  const proposed = tasks.filter(t => t.status === 'proposed').length;
  const milestones = workspace.milestones.filter(m => m.projectId === project.id);
  const milestone = milestones.find(m => m.status === 'active') ?? milestones.find(m => m.status === 'planned');
  return <button className={`project-card ${project.color}`} onClick={onOpen}>
    <span className="project-card-top"><ProjectIcon project={project} /><span className="equal-priority">Equal priority</span><ArrowUpRight className="project-arrow" size={20} /></span>
    <span className="project-card-name">{project.name}</span><span className="project-card-goal">{project.goal || 'Define the outcome you want to work toward.'}</span>
    <span className="milestone-preview"><span className="eyebrow">{milestone?.status === 'active' ? 'Current milestone' : 'Next milestone'}</span><span>{milestone?.title ?? 'Set your next milestone'}</span></span>
    <span className="project-card-footer"><span><b>{active}</b> active tasks</span><span><b>{proposed}</b> proposed tasks</span><span><b>{tasks.filter(t => t.status === 'done').length}</b> done tasks</span></span>
  </button>;
}
