'use client';
import {useCallback,useContext,useEffect,useMemo,useRef,useState} from 'react';
import {CalendarDays,Plus,RefreshCw} from 'lucide-react';
import type {Project,Task,Workspace} from '@/lib/types';
import type {JsonValue,WorkspaceCommand} from '@/lib/workspace-protocol';
import {buildDashboardModel,type DashboardModel,type SignalTone} from '@/lib/dashboard/model';
import {emptyFeedSnapshot,LiveFeedScheduler,readFeedSnapshot,type FeedSnapshot} from '@/lib/dashboard/feed';
import {briefingRequest,sendPersonalAction} from '@/lib/project-briefing-client';
import {PersonalCompletedSaveRecovery} from '@/lib/personal-completed-save-recovery';
import {SessionExpiredContext} from './session-state';
import {decodeRuntimeRead} from './runtime-view';
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
type Notice={message:string;tone:SignalTone;retry?:boolean};
/** Mission control: one screen that answers "where is each project, what are the agents
 * doing right now, and what needs me". Feeds are read-only. The only commands issued here are
 * the owner's own briefing requests, keep-current switches and the save of a briefing the PC
 * completed; nothing approves, completes or spends. */
export function MissionControl({workspace,revision,busy,onProject,onProjectFolders,onTask,onPin,onCapture,onNavigate,onRepositories,onCommand,readSnapshot,sendAction}:MissionControlProps){
 const expired=useContext(SessionExpiredContext);
 const [snapshot,setSnapshot]=useState<FeedSnapshot>(emptyFeedSnapshot);
 const [now,setNow]=useState(()=>new Date().toISOString());
 const [briefingNotices,setBriefingNotices]=useState<Record<string,Notice>>({});
 const [briefingWorking,setBriefingWorking]=useState<Record<string,boolean>>({});
 const snapshotRef=useRef(snapshot),scheduler=useRef<LiveFeedScheduler|null>(null),network=useRef<AbortController|null>(null),reader=useRef(readSnapshot??readFeedSnapshot),sender=useRef(sendAction??sendPersonalAction),saver=useRef(onCommand);
 const saveAttempts=useRef(new Set<string>()),saveRecovery=useRef(new PersonalCompletedSaveRecovery()),mounted=useRef(true);
 useEffect(()=>{reader.current=readSnapshot??readFeedSnapshot;sender.current=sendAction??sendPersonalAction;saver.current=onCommand;},[readSnapshot,sendAction,onCommand]);
 useEffect(()=>{snapshotRef.current=snapshot;},[snapshot]);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
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
 const model:DashboardModel=useMemo(()=>buildDashboardModel({now,workspace,jobs:snapshot.jobs,jobDetails:snapshot.jobDetails,runtime:snapshot.runtime,connector:snapshot.connector,localReports:snapshot.localReports,cloudReports:snapshot.cloudReports,briefings:snapshot.briefings,feeds:snapshot.feeds}),[now,workspace,snapshot]);
 const modelRef=useRef(model);useEffect(()=>{modelRef.current=model;},[model]);
 const working=model.hud.agents.running+model.hud.agents.queued+model.hud.agents.cancelling+model.hud.agents.personalActive>0;
 useEffect(()=>{scheduler.current?.setPace(working?'fast':'slow');},[working]);
 // Elapsed timers tick every ten seconds while something is running; otherwise once a minute.
 useEffect(()=>{if(expired)return;const timer=window.setInterval(()=>setNow(new Date().toISOString()),working?10_000:60_000);return()=>window.clearInterval(timer);},[working,expired]);
 const notify=useCallback((projectId:string,notice:Notice|null)=>{if(!mounted.current)return;setBriefingNotices(current=>{const next={...current};if(notice)next[projectId]=notice;else delete next[projectId];return next;});},[]);
 const setWorking=useCallback((projectId:string,value:boolean)=>{if(!mounted.current)return;setBriefingWorking(current=>({...current,[projectId]:value}));},[]);
 const refreshSoon=useCallback(()=>{scheduler.current?.invalidateSlow();void scheduler.current?.refresh();},[]);
 /** A briefing the PC completed is saved once as immutable evidence, then acknowledged so the PC
  * stops holding it. The original save command is retained until its outcome is known. */
 const saveCompleted=useCallback(async(projectId:string,explicit:boolean)=>{
  const view=modelRef.current.projects.find(tile=>tile.project.id===projectId)?.briefing;const report=view?.report;
  if(!view?.unsaved||!report||!saver.current)return;
  const requestId=view.unsaved.requestId;
  if(!explicit&&saveAttempts.current.has(requestId))return;saveAttempts.current.add(requestId);
  setWorking(projectId,true);
  try{
   const saved=snapshotRef.current.briefings,existing=saved.find(row=>row.briefing.run.id===report.run.id);
   // Already saved elsewhere (another tab, an earlier retry): only the acknowledgment is still owed.
   if(!existing){
    const command=saveRecovery.current.commandFor(requestId,()=>{const previous=saved.find(row=>row.projectId===projectId);return {type:'project-briefing.save',projectId,...(previous?{evidenceId:previous.evidenceId,expectedVersion:previous.version}:{}),briefing:report as unknown as JsonValue} as unknown as WorkspaceCommand;});
    const ok=await saver.current(command);
    if(!ok)throw new Error('The briefing could not be saved yet. It stays on your PC; retry the save.');
    saveRecovery.current.markConfirmed(requestId);
   }
   await sender.current({action:'ack',requestId,runId:report.run.id,reportSha256:view.unsaved.briefingSha256});
   notify(projectId,null);refreshSoon();
  }catch(error){
   if(saveRecovery.current.releaseRejected(requestId,error))refreshSoon();
   notify(projectId,{message:error instanceof Error?error.message:'The briefing could not be saved yet. It stays on your PC.',tone:'bad',retry:true});
  }finally{setWorking(projectId,false);}
 },[notify,setWorking,refreshSoon]);
 useEffect(()=>{if(busy||expired||snapshot.feeds.briefings.status!=='ok')return;for(const tile of model.projects){const unsaved=tile.briefing.unsaved;if(unsaved&&!saveAttempts.current.has(unsaved.requestId)&&!briefingWorking[tile.project.id])void saveCompleted(tile.project.id,false);}},[model,busy,expired,snapshot.feeds.briefings.status,briefingWorking,saveCompleted]);
 const brief=useCallback(async(projectId:string,repositoryKey:string,provider:'codex'|'claude')=>{
  setWorking(projectId,true);
  try{await sender.current(briefingRequest(projectId,repositoryKey,provider));notify(projectId,{message:`Briefing requested. Waiting for ${provider==='codex'?'Codex':'Claude Code'} on your PC to start.`,tone:'good'});refreshSoon();}
  catch(error){notify(projectId,{message:error instanceof Error?error.message:'The briefing request could not be confirmed.',tone:'bad'});}
  finally{setWorking(projectId,false);}
 },[notify,setWorking,refreshSoon]);
 const keepCurrent=useCallback(async(projectId:string,repositoryKey:string,provider:'codex'|'claude',enabled:boolean)=>{
  setWorking(projectId,true);
  try{await sender.current({action:'keep-current',repositoryKey,projectId,provider,enabled});notify(projectId,{message:enabled?'Keep current is on. Your PC refreshes this briefing when new work lands, at most once per interval.':'Keep current is off. Briefings now run only when you ask.',tone:'good'});refreshSoon();}
  catch(error){notify(projectId,{message:error instanceof Error?error.message:'The change could not be confirmed.',tone:'bad'});}
  finally{setWorking(projectId,false);}
 },[notify,setWorking,refreshSoon]);
 const actions:DashboardActions=useMemo(()=>({onProject,onTask,onTaskId:id=>{const task=workspace.tasks.find(row=>row.id===id);if(task)onTask(task);},onPin,onProjects:()=>onNavigate('projects'),onAgents:()=>onNavigate('agents'),onRuntime:()=>onNavigate('runtime'),onRepositories,onAddFolder:projectId=>{const project=workspace.projects.find(row=>row.id===projectId);if(project)(onProjectFolders??onProject)(project);},onInbox:()=>onNavigate('inbox'),onAttention:()=>onNavigate('attention'),onWeekly:()=>onNavigate('weekly'),busy,
  onBrief:(projectId,repositoryKey,provider)=>void brief(projectId,repositoryKey,provider),onKeepCurrent:(projectId,repositoryKey,provider,enabled)=>void keepCurrent(projectId,repositoryKey,provider,enabled),onRetrySave:projectId=>void saveCompleted(projectId,true),briefingNotices,briefingWorking,choosingFolder:snapshot.connector?.jobs.some(job=>job.kind==='browse'&&(job.status==='queued'||job.status==='claimed'))??false}),[snapshot.connector,onProject,onProjectFolders,onTask,onPin,onNavigate,onRepositories,workspace,busy,brief,keepCurrent,saveCompleted,briefingNotices,briefingWorking]);
 if(expired)return null;
 return <div className="mc-root">
  <header className="page-heading today-heading mc-heading"><div><p className="eyebrow date-line"><CalendarDays size={13}/>{dateLabel(cairoToday(),true)}<span>CAIRO</span></p><h1>Mission control</h1><p>Every project, every agent, every open loop. One glance.</p></div><div className="dialog-actions"><button type="button" className="button secondary" disabled={busy} onClick={()=>void scheduler.current?.refresh()}><RefreshCw size={15}/>Refresh feeds</button><button type="button" className="button primary" onClick={onCapture}><Plus size={17}/>Capture</button></div></header>
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
