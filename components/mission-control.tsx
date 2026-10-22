'use client';
import {useCallback,useContext,useEffect,useMemo,useRef,useState} from 'react';
import {CalendarDays,Plus,RefreshCw} from 'lucide-react';
import type {Project,Task,Workspace} from '@/lib/types';
import {buildDashboardModel,type DashboardModel} from '@/lib/dashboard/model';
import {emptyFeedSnapshot,LiveFeedScheduler,readFeedSnapshot,type FeedSnapshot} from '@/lib/dashboard/feed';
import {SessionExpiredContext} from './session-state';
import {decodeRuntimeRead} from './runtime-view';
import {cairoToday,dateLabel} from './ui';
import {NextUpPanel} from './next-up-panel';
import {TodayReviewSummary} from './today-review-summary';
import {AttentionPanel,FeedWarning,HudStrip,MissionLog,OperationsPanel,ProjectTile,WeekPanel,type DashboardActions} from './mission-control-panels';

export interface MissionControlProps {
 workspace:Workspace;revision:number;busy:boolean;
 onProject:(project:Project)=>void;onTask:(task:Task)=>void;onPin:(task:Task)=>void;onCapture:()=>void;
 onNavigate:(view:'projects'|'agents'|'runtime'|'inbox'|'attention'|'weekly'|'reviews')=>void;onRepositories:(projectId?:string)=>void;
 /** Test seam: override the network layer. Production uses the bounded owner feeds. */
 readSnapshot?:typeof readFeedSnapshot;
}
/** Mission control: one screen that answers "where is each project, what are the agents
 * doing right now, and what needs me". Feeds are read-only; commands stay in their panels. */
export function MissionControl({workspace,revision,busy,onProject,onTask,onPin,onCapture,onNavigate,onRepositories,readSnapshot}:MissionControlProps){
 const expired=useContext(SessionExpiredContext);
 const [snapshot,setSnapshot]=useState<FeedSnapshot>(emptyFeedSnapshot);
 const [now,setNow]=useState(()=>new Date().toISOString());
 const snapshotRef=useRef(snapshot),scheduler=useRef<LiveFeedScheduler|null>(null),network=useRef<AbortController|null>(null),reader=useRef(readSnapshot??readFeedSnapshot);
 useEffect(()=>{reader.current=readSnapshot??readFeedSnapshot;},[readSnapshot]);
 useEffect(()=>{snapshotRef.current=snapshot;},[snapshot]);
 const expire=useCallback(()=>window.dispatchEvent(new Event('control-room-session-expired')),[]);
 useEffect(()=>{
  if(expired)return;
  const controller=new AbortController();network.current=controller;let active=true;
  const loop=new LiveFeedScheduler({visible:document.visibilityState!=='hidden',signedIn:true,read:async includeSlow=>{
   const next=await reader.current(snapshotRef.current,{includeSlow,signal:controller.signal,runtimeDecode:decodeRuntimeRead});
   if(!active||controller.signal.aborted)return;
   snapshotRef.current=next;setSnapshot(next);setNow(new Date().toISOString());
  },onError:()=>{if(active)setNow(new Date().toISOString());},onExpire:expire});
  scheduler.current=loop;
  const focus=()=>void loop.refresh(),online=()=>void loop.refresh(),visibility=()=>loop.setVisible(document.visibilityState!=='hidden'),sessionExpired=()=>{loop.setSignedIn(false);controller.abort();};
  window.addEventListener('focus',focus);window.addEventListener('online',online);document.addEventListener('visibilitychange',visibility);window.addEventListener('control-room-session-expired',sessionExpired);
  loop.start();
  return()=>{active=false;controller.abort();loop.dispose();if(scheduler.current===loop)scheduler.current=null;window.removeEventListener('focus',focus);window.removeEventListener('online',online);document.removeEventListener('visibilitychange',visibility);window.removeEventListener('control-room-session-expired',sessionExpired);};
 },[expired,expire]);
 // A saved workspace change can add reports or jobs: re-read the slow feeds on the next tick.
 useEffect(()=>{scheduler.current?.invalidateSlow();void scheduler.current?.refresh();},[revision]);
 const model:DashboardModel=useMemo(()=>buildDashboardModel({now,workspace,jobs:snapshot.jobs,jobDetails:snapshot.jobDetails,runtime:snapshot.runtime,connector:snapshot.connector,localReports:snapshot.localReports,cloudReports:snapshot.cloudReports,feeds:snapshot.feeds}),[now,workspace,snapshot]);
 const working=model.hud.agents.running+model.hud.agents.queued+model.hud.agents.cancelling+model.hud.agents.personalActive>0;
 useEffect(()=>{scheduler.current?.setPace(working?'fast':'slow');},[working]);
 // Elapsed timers tick every ten seconds while something is running; otherwise once a minute.
 useEffect(()=>{if(expired)return;const timer=window.setInterval(()=>setNow(new Date().toISOString()),working?10_000:60_000);return()=>window.clearInterval(timer);},[working,expired]);
 const actions:DashboardActions=useMemo(()=>({onProject,onTask,onTaskId:id=>{const task=workspace.tasks.find(row=>row.id===id);if(task)onTask(task);},onPin,onProjects:()=>onNavigate('projects'),onAgents:()=>onNavigate('agents'),onRuntime:()=>onNavigate('runtime'),onRepositories,onInbox:()=>onNavigate('inbox'),onAttention:()=>onNavigate('attention'),onWeekly:()=>onNavigate('weekly'),busy}),[onProject,onTask,onPin,onNavigate,onRepositories,workspace,busy]);
 if(expired)return null;
 return <div className="mc-root">
  <header className="page-heading today-heading mc-heading"><div><p className="eyebrow date-line"><CalendarDays size={13}/>{dateLabel(cairoToday(),true)}<span>CAIRO</span></p><h1>Mission control</h1><p>Every project, every agent, every open loop. One glance.</p></div><div className="dialog-actions"><button type="button" className="button secondary" disabled={busy} onClick={()=>void scheduler.current?.refresh()}><RefreshCw size={15}/>Refresh feeds</button><button type="button" className="button primary" onClick={onCapture}><Plus size={17}/>Capture</button></div></header>
  <HudStrip model={model} actions={actions}/>
  <FeedWarning model={model}/>
  <section aria-labelledby="projects-heading" className="mc-projects"><div className="section-heading"><h2 id="projects-heading">Your projects <span className="count">{model.projects.length}</span></h2><button type="button" className="text-button" onClick={()=>onNavigate('projects')}>View projects</button></div>
   {model.projects.length?<div className="mc-project-grid">{model.projects.map(tile=><ProjectTile key={tile.project.id} tile={tile} now={model.now} actions={actions}/>)}</div>:<div className="panel mc-empty"><h3>No active project</h3><p>Create a project or restore an archived one to see it here.</p><button type="button" className="button secondary" onClick={()=>onNavigate('projects')}>Open projects</button></div>}
  </section>
  <div className="mc-lower">
   <div className="mc-main-column"><OperationsPanel model={model} actions={actions}/><NextUpPanel workspace={workspace} onProject={onProject} onTask={onTask} onPin={onPin} onProjects={()=>onNavigate('projects')} busy={busy}/></div>
   <aside className="mc-side-column"><AttentionPanel model={model} actions={actions}/><WeekPanel workspace={workspace} now={model.now} actions={actions}/><MissionLog log={model.log} now={model.now} actions={actions}/></aside>
  </div>
  <TodayReviewSummary workspace={workspace} busy={busy} onOpenReviews={()=>onNavigate('reviews')}/>
  <p className="workspace-note">Lights and meters describe saved records, heartbeats and recorded results. Nothing here approves, completes or spends on its own.</p>
 </div>;
}
