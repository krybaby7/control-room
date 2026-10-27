'use client';

import {SubjectReviewLink} from './subject-review-link';

import { Suspense, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, CalendarDays, Check, ChevronRight, Edit3, Plus, Search, SlidersHorizontal } from 'lucide-react';
import type { Milestone, Project, Task, Workspace } from '@/lib/types';
import type { WorkspaceCommand } from '@/lib/workspace-protocol';
import type { BaselineId } from '@/lib/project-baselines';
import { ProjectBaseline } from './project-baseline';
import {ProjectFolders} from './project-folders';
import {ProjectBriefing} from './project-briefing';
import {AreaManager} from './area-editor';
import type {Command} from '@/lib/types';
import { dateLabel, EmptyState, ProjectIcon, statusLabels, TaskRow } from './ui';

export function ProjectsView({ workspace, onProject, onCreate }: { workspace: Workspace; onProject: (project: Project) => void; onCreate?: () => void }) {
  const [filter,setFilter]=useState<'active'|'archived'|'all'>('active');
  const active=workspace.projects.filter(project=>!project.archivedAt).length;
  const visible=workspace.projects.filter(project=>filter==='all'||(filter==='archived'?!!project.archivedAt:!project.archivedAt));
  return <section className="projects-simple" aria-labelledby="projects-heading">
    <header className="page-heading simple-heading"><div><h1 id="projects-heading">Projects</h1><p>Open a project to see its briefing, folders and plan.</p></div>{onCreate&&<button type="button" className="button primary" onClick={onCreate}><Plus size={16} />New project</button>}</header>
    <div className="projects-filter"><label className="field"><span className="field-label">Show</span><select aria-label="Filter project status" value={filter} onChange={event=>setFilter(event.target.value as typeof filter)}><option value="active">Active projects</option><option value="archived">Archived projects</option><option value="all">All projects</option></select></label><p className="field-hint">Showing {visible.length} of {workspace.projects.length} projects · {active} active · {workspace.projects.length-active} archived.</p></div>
    {visible.length?<ul className="project-rows">{visible.map(project=><li key={project.id}><button type="button" className={`project-row ${project.color}`} onClick={()=>onProject(project)}><ProjectIcon project={project} small /><span className="project-row-copy"><span className="project-row-name">{project.name}{project.archivedAt&&<em> · Archived</em>}</span><span className="project-row-goal">{project.goal||'No goal written yet.'}</span></span><ChevronRight size={18} aria-hidden="true" /></button></li>)}</ul>:<EmptyState title="No projects match this filter" text="Choose another project status to see retained projects." />}
  </section>;
}

// The plan fold remembers being open for this tab, so returning from a milestone or task keeps it open.
const openPlans=new Set<string>();
export function ProjectDetail({ project, workspace, revision, busy, onBack, onProjectEdit, onMilestone, onNewMilestone, onTask, onNewTask, onPin, onApplyBaseline, onProjectLifecycle, baselineRemovedIds, onUnderstanding, onCommand, onBriefingCommand, onHome, onProjectFolders, planTools }: { onHome?:()=>void; onCommand?:(command:Command)=>Promise<void>; onBriefingCommand?:(command:WorkspaceCommand)=>Promise<boolean>; onProjectFolders?:()=>void; planTools?:ReactNode; project: Project; workspace: Workspace; revision:number; busy: boolean; onBack: () => void; onProjectEdit: () => void; onMilestone: (milestone: Milestone) => void; onNewMilestone: () => void; onTask: (task: Task) => void; onNewTask: () => void; onPin: (task: Task) => void; onApplyBaseline?: (project: Project, baselineId: BaselineId) => void; baselineRemovedIds?:readonly string[]; onUnderstanding?:()=>void; onProjectLifecycle?: (project: Project, action: 'archive' | 'restore') => void }) {
  const [horizon, setHorizon] = useState('all');
  const [status, setStatus] = useState('active');
  const [query, setQuery] = useState('');
  const [showArchivedMilestones,setShowArchivedMilestones]=useState(false);
  const [planOpen,setPlanOpen]=useState(()=>openPlans.has(project.id));
  const archived=!!project.archivedAt;
  const tasks = workspace.tasks.filter(t => t.projectId === project.id);
  const allMilestones = workspace.milestones.filter(m => m.projectId === project.id).sort((a,b)=>a.sortKey-b.sortKey||a.id.localeCompare(b.id));
  const milestones=allMilestones.filter(m=>showArchivedMilestones||!m.archivedAt);
  const archivedMilestones=allMilestones.filter(m=>!!m.archivedAt).length;
  const openTasks=tasks.filter(task=>!['done','archived'].includes(task.status)).length;
  const visible = tasks.filter(t => (horizon === 'all' || t.horizon === horizon) && (status === 'all' || (status === 'active' ? !['done', 'archived'].includes(t.status) : t.status === status)) && `${t.title} ${t.notes}`.toLowerCase().includes(query.toLowerCase()));
  const togglePlan=(open:boolean)=>{setPlanOpen(open);if(open)openPlans.add(project.id);else openPlans.delete(project.id);};
  return <>
    <button className="back-button" onClick={onBack}><ArrowLeft size={16} />All projects</button>
    <header className="project-detail-heading"><div className="project-title-group"><ProjectIcon project={project} /><h1>{project.name}</h1></div></header>
    {archived&&<div className="restore-preview" role="status"><h2>This project is archived</h2><p>Its tasks, milestones, evidence and completion history are retained. Restore the project to add new work or apply a baseline.</p></div>}
    <ProjectBriefing workspace={workspace} revision={revision} busy={busy} project={project} onCommand={onBriefingCommand} onProjectFolders={onProjectFolders}/>
    <ProjectFolders project={project} projects={workspace.projects} busy={busy} onCommand={onCommand} onHome={onHome}/>
    <details className="project-fold" open={planOpen} onToggle={event=>togglePlan(event.currentTarget.open)}><summary><span className="project-fold-title">Plan: milestones and tasks</span><span className="project-fold-hint">{allMilestones.filter(m=>!m.archivedAt).length} milestone{allMilestones.filter(m=>!m.archivedAt).length===1?'':'s'} · {openTasks} open task{openTasks===1?'':'s'}</span></summary>
    {planOpen&&<div className="project-fold-body">
    {onCommand&&<AreaManager project={project} workspace={workspace} busy={busy} onSave={onCommand} />}
    <ProjectBaseline removedIds={baselineRemovedIds} project={project} workspace={workspace} busy={busy||archived} onApply={archived?undefined:onApplyBaseline} />
    <section className="milestone-section" aria-labelledby="milestones-heading"><div className="section-heading"><h2 id="milestones-heading">Milestones <span className="count">{milestones.length}</span></h2><button className="text-button" disabled={busy||archived} onClick={onNewMilestone}><Plus size={16} />Add milestone</button></div><label className="check-card"><input type="checkbox" aria-label="Show archived milestones" checked={showArchivedMilestones} onChange={event=>setShowArchivedMilestones(event.target.checked)} /><span>Show archived milestones ({archivedMilestones})</span></label><p className="field-hint">Showing {milestones.length} of {allMilestones.length} milestones · {archivedMilestones} archived.</p>{milestones.length ? <div className="milestone-grid">{milestones.map((milestone, index) => { const linked = tasks.filter(t => t.milestoneId === milestone.id && t.status !== 'archived'); return <button className={`milestone-card ${milestone.status}`} key={milestone.id} onClick={() => onMilestone(milestone)}><span className="milestone-top"><span className="milestone-number">{milestone.status === 'achieved' ? <Check size={15} /> : String(index + 1).padStart(2, '0')}</span><span className={`milestone-status ${milestone.status}`}>{milestone.archivedAt?'Archived':milestone.status === 'achieved' ? 'Achieved' : milestone.status === 'active' ? 'Active' : 'Planned'}</span><ChevronRight size={15} /></span><h3>{milestone.title}</h3><p>{milestone.acceptance || 'Add acceptance criteria to define the finish line.'}</p><span className="milestone-bottom"><span><CalendarDays size={13} />{milestone.targetDate ? dateLabel(milestone.targetDate) : 'No target date'}</span><span>{linked.filter(t => t.status === 'done').length}/{linked.length} tasks done</span></span></button>; })}</div> : <div className="panel"><EmptyState title={allMilestones.length?'No milestones match this filter':'Give the goal a finish line'} text={allMilestones.length?'Enable archived milestones to inspect retained work.':'Define a milestone and the evidence you’ll need to call it achieved.'} action={<button className="button secondary" disabled={busy||archived} onClick={onNewMilestone}><Plus size={15} />Add a milestone</button>} /></div>}</section>
    <section className="project-tasks" aria-labelledby="tasks-heading"><div className="section-heading"><h2 id="tasks-heading">The work <span className="count">{visible.length}</span></h2><button className="button primary" disabled={busy||archived} onClick={onNewTask}><Plus size={16} />New task</button></div><div className="task-toolbar"><div className="segmented" role="group" aria-label="Task horizon">{['all', 'now', 'next', 'later'].map(value => <button key={value} aria-pressed={horizon === value} onClick={() => setHorizon(value)}>{value === 'all' ? 'All work' : value[0].toUpperCase() + value.slice(1)}</button>)}</div><div className="task-search-filters"><label className="search-field"><Search size={16} /><input aria-label="Search tasks" placeholder="Find a task…" value={query} onChange={e => setQuery(e.target.value)} /></label><label className="status-filter"><SlidersHorizontal size={15} /><select aria-label="Filter task status" value={status} onChange={e => setStatus(e.target.value)}><option value="active">Open tasks</option><option value="all">Every status</option>{Object.entries(statusLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label></div></div><p className="field-hint">Showing {visible.length} of {tasks.length} tasks · {tasks.filter(task=>task.status==='archived').length} archived. Use Every status to include all retained tasks.</p><div className="panel task-board">{visible.length ? visible.map(task => <TaskRow key={task.id} task={task} workspace={workspace} onEdit={onTask} onPin={onPin} busy={busy} showProject={false} />) : <EmptyState title={tasks.length ? 'A little breathing room' : 'Start with one clear step'} text={tasks.length ? 'No tasks match these filters. Try another horizon or status.' : 'Add a concrete action that moves this project toward its goal.'} action={<button className="text-button" disabled={busy||(!tasks.length&&archived)} onClick={tasks.length ? () => { setHorizon('all'); setStatus('all'); setQuery(''); } : onNewTask}>{tasks.length ? 'Show every task' : 'Create a task'}<ArrowRight size={14} /></button>} />}</div><p className="table-help">Open a task to edit, accept a suggestion, record completion, or restore archived work.</p></section>
    <Suspense fallback={<p role="status" className="muted">Loading task tools…</p>}>{planTools}</Suspense>
    </div>}
    </details>
    <section className="panel project-about" aria-labelledby="project-about-heading"><div className="section-heading"><h2 id="project-about-heading">About this project</h2><div className="data-actions">{onProjectLifecycle&&<button type="button" className="button secondary" disabled={busy} aria-describedby={busy?'project-about-saving':undefined} onClick={()=>onProjectLifecycle(project,archived?'restore':'archive')}>{archived?'Restore project':'Archive project'}</button>}<button className="button secondary" disabled={busy} aria-describedby={busy?'project-about-saving':undefined} onClick={onProjectEdit}><Edit3 size={15} />Edit project</button></div></div>
      {busy&&<p id="project-about-saving" className="home-reason">Saving… wait a moment.</p>}
      <div className="home-section"><span className="home-label">Your goal</span><p>{project.goal || 'No goal written yet. Use Edit project to add one.'}</p>{project.description && <p className="goal-description">{project.description}</p>}</div>
      <div className="home-section"><span className="home-label">Your framing</span>{project.framing?<p className="project-framing-preview">{project.framing}</p>:<p>No framing written yet. Framing tells briefings what this project is, why it matters and your standing rules. Use Edit project to write it.</p>}</div>
      {(onUnderstanding||!archived)&&<details className="mc-brief-fold"><summary>Technical details</summary><div className="data-actions"><SubjectReviewLink subject={{type:'project',id:project.id}}/>{onUnderstanding&&<button type="button" className="button secondary" onClick={onUnderstanding}>Project understanding</button>}</div><p className="field-hint">Review context and the technical analysis of this project&apos;s folders, for your engineers.</p></details>}
    </section>
  </>;
}
