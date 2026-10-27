'use client';
import {useId} from 'react';
import type {Project,Workspace} from '@/lib/types';
import type {WorkspaceCommand} from '@/lib/workspace-protocol';
import type {ProjectTile} from '@/lib/dashboard/model';
import type {readFeedSnapshot} from '@/lib/dashboard/feed';
import type {sendPersonalAction} from '@/lib/project-briefing-client';
import {relativeTime} from '@/lib/dashboard/format';
import {useBriefingFeed,type BriefingFeed} from './briefing-feed';
import {briefRequestReason,defaultBriefingProvider} from './briefing-actions';
import {HomeEmpty} from './home-view';

export interface HomeBriefingsProps {
 workspace:Workspace;revision:number;busy:boolean;
 onCommand?:(command:WorkspaceCommand)=>Promise<boolean>;
 onOpenProject:(project:Project)=>void;onProjectFolders:(project:Project)=>void;onNeedsYou:()=>void;
 readSnapshot?:typeof readFeedSnapshot;sendAction?:typeof sendPersonalAction;
}
const NEEDS_PREVIEW=3;
/** One calm card per project: the aim, where it stands, what needs the owner, the next step and
 * one action. Everything is read from the latest saved briefing; only Brief/Refresh sends a request. */
export function HomeCard({tile,now,feed,busy,loading,onOpenProject,onProjectFolders,onNeedsYou}:{tile:ProjectTile;now:string;feed:Pick<BriefingFeed,'brief'|'retrySave'|'notices'|'working'|'choosingFolder'>;busy:boolean;loading:boolean;onOpenProject:(project:Project)=>void;onProjectFolders:(project:Project)=>void;onNeedsYou:()=>void}){
 const id=useId(),view=tile.briefing,report=view.report,project=tile.project,projectId=project.id;
 const working=feed.working[projectId]??false,notice=feed.notices[projectId]??null,provider=defaultBriefingProvider(view);
 const reason=briefRequestReason(tile,{working,busy,choosingFolder:feed.choosingFolder,provider});
 const where=report?(report.leftOff[0]??report.status.reason):null,next=report?.nextSteps[0]??null,planNext=tile.nextAction?.task.title??null;
 return <article className="home-card" aria-labelledby={`${id}-name`}>
  <header className="home-card-head"><h2 id={`${id}-name`}>{project.name}</h2>{report&&<span className={`home-status tone-${view.status.tone}`}>{view.status.label}</span>}</header>
  {report?<>
   <div className="home-aim"><span className="home-label">The aim right now</span><p>{report.aim}</p></div>
   <div className="home-section"><span className="home-label">Where we&apos;re at</span><p className="home-clamp">{where}</p></div>
   {report.needsYou.length>0&&<div className="home-section home-needs"><span className="home-label">Needs you</span><ul>{report.needsYou.slice(0,NEEDS_PREVIEW).map((text,index)=><li key={index}>{text}</li>)}</ul>{report.needsYou.length>NEEDS_PREVIEW&&<button type="button" className="text-button" onClick={onNeedsYou}>{report.needsYou.length-NEEDS_PREVIEW} more in Needs you</button>}</div>}
   <div className="home-section"><span className="home-label">Next step</span><p>{next??planNext??'No next step recorded yet.'}</p></div>
  </>:<>
   <div className="home-aim"><span className="home-label">Your goal</span><p>{project.goal||'No goal written yet. Add one with Edit project on the project page.'}</p></div>
   {!view.activeJob&&<p className="home-quiet">{loading?'Loading the latest briefing…':'No briefing yet. A briefing reads your own recent chats and work on your PC and tells you where this project stands.'}</p>}
   {planNext&&<div className="home-section"><span className="home-label">Next step from your plan</span><p>{planNext}</p></div>}
  </>}
  {view.activeJob&&<p className="home-live" role="status">{view.activeJob.status==='claimed'?`${view.activeJob.providerLabel} is writing a fresh briefing on your PC…`:'Waiting for your PC to start the briefing…'}</p>}
  {view.lastFailure&&<p className="home-flag tone-bad">{view.lastFailure.standalone?view.lastFailure.reason:<>The last briefing did not finish: {view.lastFailure.reason}.</>}</p>}
  {report&&view.freshness.newWork&&<p className="home-flag tone-warn">There is new work since this briefing.</p>}
  {report&&view.recordedAt&&<p className="home-when">Briefed {relativeTime(view.recordedAt,now)}</p>}
  <footer className="home-card-actions">
   <button type="button" className="button primary" disabled={!!reason} aria-describedby={reason?`${id}-reason`:undefined} onClick={()=>{if(view.repositoryKey)void feed.brief(projectId,view.repositoryKey,provider);}}>{report?'Refresh briefing':'Brief this project'}</button>
   <button type="button" className="text-button" onClick={()=>onOpenProject(project)}>Open project</button>
  </footer>
  {reason&&<p id={`${id}-reason`} className="home-reason">{reason}{view.repositories.length===0&&!project.archivedAt&&<> <button type="button" className="text-button" onClick={()=>onProjectFolders(project)}>Add a folder</button></>}</p>}
  {notice&&<p className={`home-notice tone-${notice.tone}`} role={notice.tone==='bad'?'alert':'status'}>{notice.message}{notice.retry&&<> <button type="button" className="text-button" disabled={working||busy} aria-describedby={working||busy?`${id}-saving`:undefined} onClick={()=>void feed.retrySave(projectId)}>Retry save</button>{(working||busy)&&<span id={`${id}-saving`}> Saving… wait a moment.</span>}</>}</p>}
 </article>;
}
export function HomeBriefings({workspace,revision,busy,onCommand,onOpenProject,onProjectFolders,onNeedsYou,readSnapshot,sendAction}:HomeBriefingsProps){
 const feed=useBriefingFeed({workspace,revision,busy,onCommand,readSnapshot,sendAction,reports:false});
 if(feed.expired)return null;
 const {model}=feed,status=feed.snapshot.feeds.briefings.status;
 if(!model.projects.length)return <HomeEmpty/>;
 return <>
  <div className="home-cards">{model.projects.map(tile=><HomeCard key={tile.project.id} tile={tile} now={model.now} feed={feed} busy={busy} loading={status==='loading'} onOpenProject={onOpenProject} onProjectFolders={onProjectFolders} onNeedsYou={onNeedsYou}/>)}</div>
  {status==='failed'&&<p className="home-quiet" role="status">Saved briefings could not be read just now. Control Room tries again on its own.</p>}
 </>;
}
