'use client';
import {useMemo} from 'react';
import {CalendarDays,Plus,RefreshCw} from 'lucide-react';
import type {Project,Task,Workspace} from '@/lib/types';
import type {WorkspaceCommand} from '@/lib/workspace-protocol';
import type {readFeedSnapshot} from '@/lib/dashboard/feed';
import type {sendPersonalAction} from '@/lib/project-briefing-client';
import {useBriefingFeed} from './briefing-feed';
import {cairoToday,dateLabel} from './ui';
import {NextUpPanel} from './next-up-panel';
import {TodayReviewSummary} from './today-review-summary';
import {AttentionPanel,FeedWarning,HudStrip,MissionLog,OperationsPanel,ProjectTile,WeekPanel,type DashboardActions} from './mission-control-panels';

export interface MissionControlProps {
 workspace:Workspace;revision:number;busy:boolean;
 onProject:(project:Project)=>void;onProjectFolders?:(project:Project)=>void;onTask:(task:Task)=>void;onPin:(task:Task)=>void;onCapture:()=>void;
 onNavigate:(view:'projects'|'agents'|'runtime'|'inbox'|'attention'|'weekly'|'reviews')=>void;onRepositories:(projectId?:string)=>void;
 /** Saves an owner command (used for `project-briefing.save`); resolves false when the save is unconfirmed. */
 onCommand?:(command:WorkspaceCommand)=>Promise<boolean>;
 /** Test seams: override the network layer and the personal PC channel. */
 readSnapshot?:typeof readFeedSnapshot;sendAction?:typeof sendPersonalAction;
}
/** Mission control: one screen that answers "where is each project, what are the agents
 * doing right now, and what needs me". Feeds are read-only. The only commands issued here are
 * the owner's own briefing requests, keep-current switches and the save of a briefing the PC
 * completed; nothing approves, completes or spends. */
export function MissionControl({workspace,revision,busy,onProject,onProjectFolders,onTask,onPin,onCapture,onNavigate,onRepositories,onCommand,readSnapshot,sendAction}:MissionControlProps){
 const feed=useBriefingFeed({workspace,revision,busy,onCommand,readSnapshot,sendAction});
 const {model,brief,keepCurrent,retrySave,notices:briefingNotices,working:briefingWorking,choosingFolder}=feed;
 const actions:DashboardActions=useMemo(()=>({onProject,onTask,onTaskId:id=>{const task=workspace.tasks.find(row=>row.id===id);if(task)onTask(task);},onPin,onProjects:()=>onNavigate('projects'),onAgents:()=>onNavigate('agents'),onRuntime:()=>onNavigate('runtime'),onRepositories,onAddFolder:projectId=>{const project=workspace.projects.find(row=>row.id===projectId);if(project)(onProjectFolders??onProject)(project);},onInbox:()=>onNavigate('inbox'),onAttention:()=>onNavigate('attention'),onWeekly:()=>onNavigate('weekly'),busy,
  onBrief:(projectId,repositoryKey,provider)=>void brief(projectId,repositoryKey,provider),onKeepCurrent:(projectId,repositoryKey,provider,enabled)=>void keepCurrent(projectId,repositoryKey,provider,enabled),onRetrySave:projectId=>void retrySave(projectId),briefingNotices,briefingWorking,choosingFolder}),[choosingFolder,onProject,onProjectFolders,onTask,onPin,onNavigate,onRepositories,workspace,busy,brief,keepCurrent,retrySave,briefingNotices,briefingWorking]);
 if(feed.expired)return null;
 return <div className="mc-root">
  <header className="page-heading today-heading mc-heading"><div><p className="eyebrow date-line"><CalendarDays size={13}/>{dateLabel(cairoToday(),true)}<span>CAIRO</span></p><h1>Mission control</h1><p>Every project, every agent, every open loop. One glance.</p></div><div className="dialog-actions"><button type="button" className="button secondary" disabled={busy} onClick={feed.refresh}><RefreshCw size={15}/>Refresh feeds</button><button type="button" className="button primary" onClick={onCapture}><Plus size={17}/>Capture</button></div></header>
  <HudStrip model={model} actions={actions}/>
  <FeedWarning model={model}/>
  <section aria-labelledby="projects-heading" className="mc-projects"><div className="section-heading"><h2 id="projects-heading">Your projects <span className="count">{model.projects.length}</span></h2><button type="button" className="text-button" onClick={()=>onNavigate('projects')}>View projects</button></div>
   {model.projects.length?<div className="mc-project-grid">{model.projects.map(tile=><ProjectTile workspace={workspace} key={tile.project.id} tile={tile} now={model.now} actions={actions}/>)}</div>:<div className="panel mc-empty"><h3>No active project</h3><p>Create a project or restore an archived one to see it here.</p><button type="button" className="button secondary" onClick={()=>onNavigate('projects')}>Open projects</button></div>}
  </section>
  <div className="mc-lower">
   <div className="mc-main-column"><OperationsPanel model={model} actions={actions}/><NextUpPanel workspace={workspace} onProject={onProject} onTask={onTask} onPin={onPin} onProjects={()=>onNavigate('projects')} busy={busy}/></div>
   <aside className="mc-side-column"><AttentionPanel model={model} actions={actions}/><WeekPanel workspace={workspace} now={model.now} actions={actions}/><MissionLog log={model.log} now={model.now} actions={actions}/></aside>
  </div>
  <TodayReviewSummary workspace={workspace} busy={busy} onOpenReviews={()=>onNavigate('reviews')}/>
  <p className="workspace-note">Briefings are written on your PC from your repositories, chats and plan; lights and meters describe saved records, heartbeats and recorded results. Nothing here approves, completes or spends on its own.</p>
 </div>;
}
