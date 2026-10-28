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
type CompletedBriefing={requestId:string;runId:string;reportSha256:string;report:JsonValue};
interface CompletedSave {projectId:string;completed:CompletedBriefing;recovery:PersonalCompletedSaveRecovery;attempted:boolean;acknowledged:boolean;flight:Promise<void>|null}
/** Save outcomes belong to the shared feed, rather than a screen's mount. Keep the exact
 * uncertain command and acknowledgment until an explicit retry settles them. */
class CompletedBriefingSaves {
 private records=new Map<string,CompletedSave>();private generation=0;
 private listeners=new Set<()=>void>();
 private state:{notices:Record<string,BriefingNotice>;working:Record<string,boolean>}={notices:{},working:{}};
 readonly subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
 readonly current=()=>this.state;
 private readonly expired=()=>this.clear();
 private publish(projectId:string,busy:boolean,notice:BriefingNotice|null){const notices={...this.state.notices},working={...this.state.working};if(notice)notices[projectId]=notice;else delete notices[projectId];if(busy)working[projectId]=true;else delete working[projectId];this.state={notices,working};for(const listener of [...this.listeners])listener();}
 clear(){window.removeEventListener('control-room-session-expired',this.expired);this.generation++;this.records.clear();this.state={notices:{},working:{}};for(const listener of [...this.listeners])listener();}
 save(projectId:string,completed:CompletedBriefing|null,explicit:boolean,getSaved:()=>FeedSnapshot['briefings'],saver:NonNullable<BriefingFeedOptions['onCommand']>,sender:typeof sendPersonalAction,refresh:()=>void):Promise<void>{
  let record=completed?this.records.get(completed.requestId):[...this.records.values()].find(row=>row.projectId===projectId&&!row.acknowledged);
  if(!record&&completed){if(this.records.size===0)window.addEventListener('control-room-session-expired',this.expired);record={projectId,completed:{...completed,report:structuredClone(completed.report)},recovery:new PersonalCompletedSaveRecovery(),attempted:false,acknowledged:false,flight:null};this.records.set(completed.requestId,record);}
  if(!record||record.acknowledged)return Promise.resolve();
  if(record.flight)return record.flight;
  if(record.attempted&&!explicit)return Promise.resolve();
  const pending=record,generation=this.generation,{requestId,runId,reportSha256,report}=pending.completed;
  pending.attempted=true;this.publish(projectId,true,null);
  // Defer invocation until the synchronous in-flight guard has been installed for every mount.
  const flight=Promise.resolve().then(async()=>{
   if(generation!==this.generation)return;
   try{
    const saved=getSaved(),existing=saved.some(row=>row.briefing.run.id===runId);
    if(!pending.recovery.isConfirmed(requestId)){
     // An uncertain mutation must reconcile with its original command even if its result is
     // now visible in a read. A confirmed save only owes its PC acknowledgment.
     if(!existing||pending.recovery.pendingCommand(requestId)){
      const command=pending.recovery.commandFor(requestId,()=>{const previous=saved.find(row=>row.projectId===projectId);return {type:'project-briefing.save',projectId,...(previous?{evidenceId:previous.evidenceId,expectedVersion:previous.version}:{}),briefing:report} as unknown as WorkspaceCommand;});
      const ok=await saver(command);if(generation!==this.generation)return;
      if(!ok)throw new Error('The briefing could not be saved yet. It stays on your PC; retry the save.');
     }
     pending.recovery.markConfirmed(requestId);
    }
    if(generation!==this.generation)return;
    await sender({action:'ack',requestId,runId,reportSha256});if(generation!==this.generation)return;
    pending.acknowledged=true;pending.completed={requestId,runId,reportSha256,report:null};pending.recovery=new PersonalCompletedSaveRecovery();this.publish(projectId,false,null);refresh();
   }catch(error){
    if(generation!==this.generation)return;
    if(!pending.recovery.isConfirmed(requestId)&&pending.recovery.releaseRejected(requestId,error))refresh();
    this.publish(projectId,false,{message:error instanceof Error?error.message:'The briefing could not be saved yet. It stays on your PC.',tone:'bad',retry:true});
   }finally{pending.flight=null;}
  });
  pending.flight=flight;return flight;
 }
}
/** One live read of the owner feeds (PC connection, jobs, runtime and saved briefings), shared by
 * every mounted briefing view and the menu's Needs you count so that several readers never
 * multiply the polling. The read loop starts with its first user and stops after its last;
 * completed-save coordination also survives navigation until its outcome is settled. */
export class FeedSource {
 readonly completedSaves=new CompletedBriefingSaves();
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
  const focus=()=>void loop.refresh(),visibility=()=>loop.setVisible(document.visibilityState!=='hidden'),expired=()=>{loop.setSignedIn(false);controller.abort();this.completedSaves.clear();this.publish({snapshot:emptyFeedSnapshot(),readAt:new Date().toISOString()});};
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
 const sharedSaves=useSyncExternalStore(source.completedSaves.subscribe,source.completedSaves.current,source.completedSaves.current);
 const mounted=useRef(true);
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
  if(expired||!saver.current)return;
  const completed=view?.unsaved&&report?{requestId:view.unsaved.requestId,runId:report.run.id,reportSha256:view.unsaved.briefingSha256,report:report as unknown as JsonValue}:null;
  await source.completedSaves.save(projectId,completed,explicit,()=>source.current().snapshot.briefings,saver.current,sender.current,refreshSoon);
 },[source,expired,refreshSoon]);
 useEffect(()=>{if(busy||expired||snapshot.feeds.briefings.status!=='ok')return;for(const tile of model.projects){if(tile.briefing.unsaved&&!working[tile.project.id])void saveCompleted(tile.project.id,false);}},[model,busy,expired,snapshot.feeds.briefings.status,working,saveCompleted]);
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
 return {expired,model,snapshot,refresh,brief,keepCurrent,retrySave,notices:{...notices,...sharedSaves.notices},working:{...working,...sharedSaves.working},choosingFolder};
}
