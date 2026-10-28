'use client';
import {useCallback,useContext,useEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import type {Workspace} from '@/lib/types';
import type {JsonValue,WorkspaceCommand} from '@/lib/workspace-protocol';
import {buildDashboardModel,type DashboardModel,type SignalTone} from '@/lib/dashboard/model';
import {emptyFeedSnapshot,LiveFeedScheduler,readFeedSnapshot,type FeedSnapshot} from '@/lib/dashboard/feed';
import {briefingRequest,sendPersonalAction} from '@/lib/project-briefing-client';
import {PersonalCompletedSaveRecovery} from '@/lib/personal-completed-save-recovery';
import {SessionExpiredContext} from './session-state';
import {decodeRuntimeRead} from './runtime-view';

export type BriefingNotice={message:string;tone:SignalTone;retry?:boolean};
export interface FeedState {snapshot:FeedSnapshot;readAt:string}
/** One live read of the owner feeds (PC connection, jobs, runtime and saved briefings), shared by
 * every mounted briefing view and the menu's Needs you count so that several readers never
 * multiply the polling. It reads only; it starts with its first user and stops after its last. */
export class FeedSource {
 private state:FeedState={snapshot:emptyFeedSnapshot(),readAt:new Date().toISOString()};
 private readonly listeners=new Set<()=>void>();
 private users=0;private reportUsers=0;private revision:number|null=null;
 private loop:LiveFeedScheduler|null=null;private halt:(()=>void)|null=null;
 constructor(private readonly read:typeof readFeedSnapshot=readFeedSnapshot){}
 readonly subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
 readonly current=()=>this.state;
 private publish(next:FeedState){this.state=next;for(const listener of [...this.listeners])listener();}
 /** Registers a reader and returns its release. Views without technical analysis pass `reports: false`
  * so saved technical reports stay unread (lazy) until a view that shows them is open. */
 acquire(reports:boolean):()=>void{
  this.users++;if(reports)this.reportUsers++;
  if(!this.loop)this.start();else if(reports&&this.reportUsers===1)this.refreshSoon();
  let released=false;
  return()=>{if(released)return;released=true;this.users--;if(reports)this.reportUsers--;if(this.users===0)this.stop();};
 }
 /** A saved workspace change can add reports or jobs: re-read the slow feeds once per new revision. */
 observeRevision(revision:number){if(this.revision===revision)return;const first=this.revision===null;this.revision=revision;if(!first)this.refreshSoon();}
 /** Fast pace while any agent is working. */
 setPace(pace:'fast'|'slow'){this.loop?.setPace(pace);}
 refresh(){void this.loop?.refresh();}
 refreshSoon(){this.loop?.invalidateSlow();void this.loop?.refresh();}
 private start(){
  const controller=new AbortController();let active=true;
  const loop=new LiveFeedScheduler({visible:document.visibilityState!=='hidden',signedIn:true,read:async includeSlow=>{
   const snapshot=await this.read(this.state.snapshot,{includeSlow,signal:controller.signal,runtimeDecode:decodeRuntimeRead,reports:this.reportUsers>0});
   if(!active||controller.signal.aborted)return;
   this.publish({snapshot,readAt:new Date().toISOString()});
  },onError:()=>{if(active)this.publish({...this.state,readAt:new Date().toISOString()});},onExpire:()=>window.dispatchEvent(new Event('control-room-session-expired'))});
  // An expired session closes private content: stop reading and forget what was read.
  const focus=()=>void loop.refresh(),visibility=()=>loop.setVisible(document.visibilityState!=='hidden'),expired=()=>{loop.setSignedIn(false);controller.abort();this.publish({snapshot:emptyFeedSnapshot(),readAt:new Date().toISOString()});};
  window.addEventListener('focus',focus);window.addEventListener('online',focus);document.addEventListener('visibilitychange',visibility);window.addEventListener('control-room-session-expired',expired);
  this.loop=loop;
  this.halt=()=>{active=false;controller.abort();loop.dispose();window.removeEventListener('focus',focus);window.removeEventListener('online',focus);document.removeEventListener('visibilitychange',visibility);window.removeEventListener('control-room-session-expired',expired);};
  loop.start();
 }
 private stop(){this.halt?.();this.halt=null;this.loop=null;this.revision=null;}
}
const sharedFeed=new FeedSource();

export interface FeedModelOptions {
 workspace:Workspace;revision:number;
 /** Test seam: overrides the network layer with a private, unshared feed. */
 readSnapshot?:typeof readFeedSnapshot;
 /** Views without technical analysis leave the saved reports unread (they stay lazy until opened). */
 reports?:boolean;
}
export interface FeedModel {expired:boolean;model:DashboardModel;snapshot:FeedSnapshot;source:FeedSource}
/** The dashboard model over the shared live feed. Read-only: it issues no command. */
export function useFeedModel({workspace,revision,readSnapshot,reports=true}:FeedModelOptions):FeedModel{
 const expired=useContext(SessionExpiredContext);
 const [source]=useState(()=>readSnapshot?new FeedSource(readSnapshot):sharedFeed);
 const {snapshot,readAt}=useSyncExternalStore(source.subscribe,source.current,source.current);
 const [tick,setTick]=useState(()=>new Date().toISOString());
 useEffect(()=>{if(expired)return;return source.acquire(reports);},[source,expired,reports]);
 useEffect(()=>{if(!expired)source.observeRevision(revision);},[source,expired,revision]);
 const now=readAt>tick?readAt:tick;
 const model:DashboardModel=useMemo(()=>buildDashboardModel({now,workspace,jobs:snapshot.jobs,jobDetails:snapshot.jobDetails,runtime:snapshot.runtime,connector:snapshot.connector,localReports:snapshot.localReports,cloudReports:snapshot.cloudReports,briefings:snapshot.briefings,feeds:snapshot.feeds}),[now,workspace,snapshot]);
 const active=model.hud.agents.running+model.hud.agents.queued+model.hud.agents.cancelling+model.hud.agents.personalActive>0;
 useEffect(()=>{source.setPace(active?'fast':'slow');},[source,active]);
 // Elapsed timers tick every ten seconds while something is running; otherwise once a minute.
 useEffect(()=>{if(expired)return;const timer=window.setInterval(()=>setTick(new Date().toISOString()),active?10_000:60_000);return()=>window.clearInterval(timer);},[active,expired]);
 return {expired,model,snapshot,source};
}

export interface BriefingFeedOptions extends FeedModelOptions {
 busy:boolean;
 /** Saves an owner command (used for `project-briefing.save`); resolves false when the save is unconfirmed. */
 onCommand?:(command:WorkspaceCommand)=>Promise<boolean>;
 /** Test seam: overrides the personal PC channel. */
 sendAction?:typeof sendPersonalAction;
}
export interface BriefingFeed {
 expired:boolean;model:DashboardModel;snapshot:FeedSnapshot;refresh:()=>void;
 brief:(projectId:string,repositoryKey:string,provider:'codex'|'claude')=>Promise<void>;
 keepCurrent:(projectId:string,repositoryKey:string,provider:'codex'|'claude',enabled:boolean)=>Promise<void>;
 retrySave:(projectId:string)=>Promise<void>;
 notices:Record<string,BriefingNotice>;working:Record<string,boolean>;choosingFolder:boolean;
}
/** The owner feeds behind every briefing view (Home, project pages, Needs you and Mission control).
 * The only commands issued are the owner's own briefing requests, keep-current switches and the
 * save of a briefing the PC completed; nothing approves, completes or spends. */
export function useBriefingFeed({workspace,revision,busy,onCommand,readSnapshot,sendAction,reports=true}:BriefingFeedOptions):BriefingFeed{
 const {expired,model,snapshot,source}=useFeedModel({workspace,revision,readSnapshot,reports});
 const [notices,setNotices]=useState<Record<string,BriefingNotice>>({});
 const [working,setWorkingState]=useState<Record<string,boolean>>({});
 const sender=useRef(sendAction??sendPersonalAction),saver=useRef(onCommand);
 const saveAttempts=useRef(new Set<string>()),saveRecovery=useRef(new PersonalCompletedSaveRecovery()),mounted=useRef(true);
 useEffect(()=>{sender.current=sendAction??sendPersonalAction;saver.current=onCommand;},[sendAction,onCommand]);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 const modelRef=useRef(model);useEffect(()=>{modelRef.current=model;},[model]);
 const notify=useCallback((projectId:string,notice:BriefingNotice|null)=>{if(!mounted.current)return;setNotices(current=>{const next={...current};if(notice)next[projectId]=notice;else delete next[projectId];return next;});},[]);
 const setWorking=useCallback((projectId:string,value:boolean)=>{if(!mounted.current)return;setWorkingState(current=>({...current,[projectId]:value}));},[]);
 const refreshSoon=useCallback(()=>source.refreshSoon(),[source]);
 /** A briefing the PC completed is saved once as immutable evidence, then acknowledged so the PC
  * stops holding it. The original save command is retained until its outcome is known. */
 const saveCompleted=useCallback(async(projectId:string,explicit:boolean)=>{
  const view=modelRef.current.projects.find(tile=>tile.project.id===projectId)?.briefing;const report=view?.report;
  if(!view?.unsaved||!report||!saver.current)return;
  const requestId=view.unsaved.requestId;
  if(!explicit&&saveAttempts.current.has(requestId))return;saveAttempts.current.add(requestId);
  setWorking(projectId,true);
  try{
   const saved=source.current().snapshot.briefings,existing=saved.find(row=>row.briefing.run.id===report.run.id);
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
 },[source,notify,setWorking,refreshSoon]);
 useEffect(()=>{if(busy||expired||snapshot.feeds.briefings.status!=='ok')return;for(const tile of model.projects){const unsaved=tile.briefing.unsaved;if(unsaved&&!saveAttempts.current.has(unsaved.requestId)&&!working[tile.project.id])void saveCompleted(tile.project.id,false);}},[model,busy,expired,snapshot.feeds.briefings.status,working,saveCompleted]);
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
 const retrySave=useCallback((projectId:string)=>saveCompleted(projectId,true),[saveCompleted]);
 const refresh=useCallback(()=>source.refresh(),[source]);
 const choosingFolder=snapshot.connector?.jobs.some(job=>job.kind==='browse'&&(job.status==='queued'||job.status==='claimed'))??false;
 return {expired,model,snapshot,refresh,brief,keepCurrent,retrySave,notices,working,choosingFolder};
}
