'use client';
import {useId,useState} from 'react';
import type {Project,Workspace} from '@/lib/types';
import type {WorkspaceCommand} from '@/lib/workspace-protocol';
import type {ProjectTile} from '@/lib/dashboard/model';
import type {readFeedSnapshot} from '@/lib/dashboard/feed';
import type {sendPersonalAction} from '@/lib/project-briefing-client';
import {relativeTime} from '@/lib/dashboard/format';
import {firstDisabledReason,projectActionDisabledReason} from '@/lib/project-action-reasons';
import {useBriefingFeed,type BriefingFeed} from './briefing-feed';
import {briefRequestReason,defaultBriefingProvider} from './briefing-actions';
import {BriefingBasis,IntentionTrail,PlanChanges,ProjectMap} from './briefing-card';

export interface ProjectBriefingProps {
 workspace:Workspace;revision:number;busy:boolean;project:Project;
 onCommand?:(command:WorkspaceCommand)=>Promise<boolean>;onProjectFolders?:()=>void;
 readSnapshot?:typeof readFeedSnapshot;sendAction?:typeof sendPersonalAction;
}
/** The project's briefing, first on its page: aim, where it stands, the owner's intentions and what
 * became of them, what needs the owner and the next steps. Detail stays in folds. */
export function ProjectBriefingBody({tile,now,feed,busy,loading,onProjectFolders}:{tile:ProjectTile;now:string;feed:Pick<BriefingFeed,'brief'|'keepCurrent'|'retrySave'|'notices'|'working'|'choosingFolder'>;busy:boolean;loading:boolean;onProjectFolders?:()=>void}){
 const id=useId(),view=tile.briefing,report=view.report,ledger=view.ledger,projectId=tile.project.id;
 const [area,setArea]=useState<string|null>(null);
 const [provider,setProvider]=useState<'codex'|'claude'>(()=>defaultBriefingProvider(view));
 const selected=area&&ledger.areas.some(row=>row.id===area)?area:null;
 const working=feed.working[projectId]??false,notice=feed.notices[projectId]??null;
 const reason=briefRequestReason(tile,{working,busy,choosingFolder:feed.choosingFolder,provider});
 const savingReason=projectActionDisabledReason('remove-folder',{saving:working||busy});
 const keepCurrent=view.policy?.enabled??false;
 const keepReason=firstDisabledReason(savingReason,!keepCurrent&&projectActionDisabledReason('choose-folder',{online:view.connector==='online'}));
 return <section className="project-briefing" aria-labelledby={`${id}-heading`}>
  <header className="project-briefing-head"><h2 id={`${id}-heading`}>Briefing</h2>{report&&<span className={`home-status tone-${view.status.tone}`}>{view.status.label}</span>}{report&&view.recordedAt&&<small>Briefed {relativeTime(view.recordedAt,now)}{view.providerLabel?` by ${view.providerLabel}`:''}{view.source==='completed'?' · saving…':''}</small>}</header>
  {view.activeJob&&<p className="home-live" role="status">{view.activeJob.status==='claimed'?`${view.activeJob.providerLabel} is writing a fresh briefing on your PC…`:'Waiting for your PC to start the briefing…'}</p>}
  {view.lastFailure&&<p className="home-flag tone-bad">{view.lastFailure.standalone?view.lastFailure.reason:<>The last briefing did not finish: {view.lastFailure.reason}.</>}</p>}
  {report?<>
   <div className="home-aim"><span className="home-label">The aim right now</span><p>{report.aim}</p></div>
   <div className="home-section"><span className="home-label">Where it stands</span><p>{report.status.reason}</p>{report.fitOrDrift&&<p>{report.fitOrDrift}</p>}{report.leftOff.map((text,index)=><p key={index}>{text}</p>)}{view.freshness.newWork&&<p className="home-flag tone-warn">{view.freshness.detail} {view.policy?.enabled?'A refresh is scheduled the next time your PC is on.':'Refresh to catch up.'}</p>}</div>
   {ledger.intentions.length>0&&<IntentionTrail ledger={ledger} area={selected} onClearArea={()=>setArea(null)}/>}
   <div className="project-briefing-columns">
    <div className="home-section home-needs"><span className="home-label">Needs you</span>{report.needsYou.length?<ul>{report.needsYou.map((text,index)=><li key={index}>{text}</li>)}</ul>:<p>Nothing waits on you right now.</p>}</div>
    <div className="home-section"><span className="home-label">Next steps</span>{report.nextSteps.length?<ol>{report.nextSteps.map((text,index)=><li key={index}>{text}</li>)}</ol>:<p>No next step recorded yet.</p>}</div>
   </div>
  </>:!view.activeJob&&<p className="home-quiet">{loading?'Loading the latest briefing…':'No briefing yet. A briefing reads your own recent chats and work on your PC, measures them against your framing, and tells you where this project stands.'}</p>}
  <div className="home-card-actions"><button type="button" className="button primary" disabled={!!reason} aria-describedby={reason?`${id}-reason`:undefined} onClick={()=>{if(view.repositoryKey)void feed.brief(projectId,view.repositoryKey,provider);}}>{report?'Refresh briefing':'Brief this project'}</button></div>
  {reason&&<p id={`${id}-reason`} className="home-reason">{reason}{view.repositories.length===0&&!tile.project.archivedAt&&onProjectFolders&&<> <button type="button" className="text-button" onClick={onProjectFolders}>Go to Folders on your PC</button></>}</p>}
  {notice&&<p className={`home-notice tone-${notice.tone}`} role={notice.tone==='bad'?'alert':'status'}>{notice.message}{notice.retry&&<> <button type="button" className="text-button" disabled={!!savingReason} aria-describedby={savingReason?`${id}-saving`:undefined} onClick={()=>void feed.retrySave(projectId)}>Retry save</button></>}</p>}
  {report&&(ledger.areas.length>0||ledger.bends>0)&&<details className="mc-brief-fold"><summary>Project map and how the plan changed</summary>{ledger.areas.length>0&&<><p className="home-quiet">Each area, how far it is proven, and what feeds what. Tap an area to see only its intentions above.</p><ProjectMap ledger={ledger} selected={selected} onSelect={setArea}/></>}<PlanChanges ledger={ledger}/></details>}
  {report&&<details className="mc-brief-fold"><summary>Still open, tried, done and not yet done</summary>
   <div className="project-briefing-columns"><div><strong>Still open</strong>{report.open.length?<ul>{report.open.map((text,index)=><li key={index}>{text}</li>)}</ul>:<p>Nothing unresolved was identified.</p>}</div><div><strong>Tried and did not work</strong>{report.tried.length?<ul>{report.tried.map((text,index)=><li key={index}>{text}</li>)}</ul>:<p>Nothing recorded.</p>}</div></div>
   <div className="project-briefing-columns"><div><strong>Done</strong>{report.done.length?<ul>{report.done.map((text,index)=><li key={index}>{text}</li>)}</ul>:<p>Nothing recorded as done yet.</p>}</div><div><strong>Not yet done</strong>{report.notDone.length?<ul>{report.notDone.map((text,index)=><li key={index}>{text}</li>)}</ul>:<p>Nothing outstanding was identified.</p>}</div></div>
  </details>}
  <BriefingBasis view={view} now={now}/>
  {!tile.project.archivedAt&&<details className="mc-brief-fold"><summary>Briefing settings</summary>
   <label className="field"><span className="field-label">Assistant</span><select value={provider} disabled={working} aria-describedby={working?`${id}-saving`:undefined} onChange={event=>setProvider(event.target.value as 'codex'|'claude')}>{view.providers.map(row=><option key={row.id} value={row.id}>{row.label}{row.ready?'':' (not signed in)'}</option>)}</select></label>
   {view.repositoryKey?<><label className="mc-brief-toggle"><input type="checkbox" checked={keepCurrent} disabled={!!keepReason} aria-describedby={keepReason?`${id}-keep`:undefined} onChange={event=>void feed.keepCurrent(projectId,view.repositoryKey!,provider,event.target.checked)}/><span>Keep this briefing current{keepCurrent&&view.policy?` · ${view.policy.provider==='codex'?'Codex':'Claude Code'}, at most every ${view.policy.minIntervalMinutes>=120?`${Math.round(view.policy.minIntervalMinutes/60)} h`:`${view.policy.minIntervalMinutes} min`}`:''}</span></label>{keepReason&&<p id={`${id}-keep`} className="home-reason">{keepReason}</p>}</>:<p className="home-quiet">Add a folder to keep this briefing current automatically.</p>}
  </details>}
  {savingReason&&<p id={`${id}-saving`} className="home-reason">{savingReason}</p>}
 </section>;
}
export function ProjectBriefing({workspace,revision,busy,project,onCommand,onProjectFolders,readSnapshot,sendAction}:ProjectBriefingProps){
 const id=useId();
 const feed=useBriefingFeed({workspace,revision,busy,onCommand,readSnapshot,sendAction,reports:false});
 if(feed.expired)return null;
 const tile=feed.model.projects.find(row=>row.project.id===project.id);
 if(!tile)return <section className="project-briefing" aria-labelledby={`${id}-heading`}><header className="project-briefing-head"><h2 id={`${id}-heading`}>Briefing</h2></header><p className="home-quiet">This project is archived. Its saved briefings are kept; restore the project to brief it again.</p></section>;
 return <ProjectBriefingBody tile={tile} now={feed.model.now} feed={feed} busy={busy} loading={feed.snapshot.feeds.briefings.status==='loading'} onProjectFolders={onProjectFolders}/>;
}
