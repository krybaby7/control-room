'use client';
import type {ReactNode} from 'react';
import {useState} from 'react';
import {Activity,AlertTriangle,ArrowRight,Bot,CheckCheck,ChevronRight,CircleDashed,Cloud,Flag,GitBranch,HelpCircle,Inbox,Laptop,ListChecks,Pin,RefreshCw,Sparkles,Timer,Zap} from 'lucide-react';
import type {Project,Task,Workspace} from '@/lib/types';
import type {ActiveJob,AttentionItem,DashboardModel,LogEntry,PersonalJob,ProjectTile as ProjectTileModel,RecentJob,SignalTone} from '@/lib/dashboard/model';
import {clockLabel,compactNumber,durationLabel,relativeTime} from '@/lib/dashboard/format';
import {isCurrentWeek} from '@/lib/calendar';
import {weeklyCompletionCount} from '@/lib/weekly-summary';
import {archivedEntity} from '@/lib/entity-links';
import {TaskContext,dateLabel,ProjectIcon} from './ui';

export interface DashboardActions {
 onProject:(project:Project)=>void;onTask:(task:Task)=>void;onTaskId:(taskId:string)=>void;onPin:(task:Task)=>void;onProjects:()=>void;onAgents:()=>void;onRuntime:()=>void;
 onRepositories:(projectId?:string)=>void;onInbox:()=>void;onAttention:()=>void;onWeekly:()=>void;busy:boolean;
 onBrief:(projectId:string,repositoryKey:string,provider:'codex'|'claude')=>void;onKeepCurrent:(projectId:string,repositoryKey:string,provider:'codex'|'claude',enabled:boolean)=>void;onRetrySave:(projectId:string)=>void;
 briefingNotices:Record<string,{message:string;tone:SignalTone;retry?:boolean}>;briefingWorking:Record<string,boolean>;
}
export function StatusLight({tone,label}:{tone:SignalTone;label?:string}){return <span className={`mc-light tone-${tone}`} role={label?'img':undefined} aria-label={label} aria-hidden={label?undefined:true}/>;}
export function Meter({value,tone='good',label}:{value:number|null;tone?:SignalTone;label:string}){
 return <span className={`mc-meter tone-${tone}`} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value??undefined} aria-valuetext={value===null?'unknown':`${value}%`}><span style={{width:`${value??0}%`}} className={value===null?'indeterminate':''}/></span>;}
function Chip({children,tone='idle',title}:{children:ReactNode;tone?:SignalTone;title?:string}){return <span className={`mc-chip tone-${tone}`} title={title}>{children}</span>;}
function ProjectChip({name,color}:{name:string|null;color:Project['color']|null}){return name?<span className={`project-label ${color??''}`}><i/>{name}</span>:null;}

export function HudStrip({model,actions}:{model:DashboardModel;actions:DashboardActions}){
 const {pc,connector,cloud,agents,attention}=model.hud,metrics=pc.metrics;
 const failed=(Object.entries(model.feeds) as [string,{status:string}][]).filter(([,state])=>state.status==='failed').map(([key])=>key);
 const checked=Object.values(model.feeds).map(state=>state.checkedAt).filter((value):value is string=>!!value).sort().at(-1)??null;
 return <section className="mc-hud" aria-label="Status overview">
  <button type="button" className={`mc-hud-tile tone-${pc.tone}`} onClick={actions.onRuntime}><span className="mc-hud-icon"><Laptop size={18}/></span><span className="mc-hud-copy"><span className="mc-hud-label"><StatusLight tone={pc.tone}/>{pc.label}</span><span className="mc-hud-detail">{pc.deviceLabel?`${pc.deviceLabel} · `:''}{pc.detail}</span>{metrics&&<span className="mc-hud-meters" aria-label="PC load">{([['CPU',metrics.cpu],['MEM',metrics.memory],['GPU',metrics.gpu]] as const).map(([name,value])=><span key={name}><small>{name}</small><Meter value={value===null?null:Math.round(value)} label={`${name} ${value===null?'unavailable':Math.round(value)+'%'}`} tone={value!==null&&value>90?'warn':'good'}/><b>{value===null?'—':`${Math.round(value)}%`}</b></span>)}{pc.metricsAgeSeconds!==null&&<em>sample ≤{Math.round(pc.metricsAgeSeconds)}s old</em>}</span>}</span></button>
  <button type="button" className={`mc-hud-tile tone-${connector.tone}`} onClick={()=>actions.onRepositories()}><span className="mc-hud-icon"><Bot size={18}/></span><span className="mc-hud-copy"><span className="mc-hud-label"><StatusLight tone={connector.tone}/>{connector.label}</span><span className="mc-hud-detail">{connector.detail}</span><span className="mc-hud-chips">{connector.providers.map(provider=><Chip key={provider.id} tone={provider.ready?'good':connector.state==='unconfigured'||connector.state==='unknown'?'idle':'warn'}>{provider.label}: {provider.detail}</Chip>)}</span></span></button>
  <button type="button" className={`mc-hud-tile tone-${agents.tone}`} onClick={actions.onAgents}><span className="mc-hud-icon"><Zap size={18}/></span><span className="mc-hud-copy"><span className="mc-hud-label"><StatusLight tone={agents.tone}/>{agents.label}</span><span className="mc-hud-detail">{agents.running+agents.personalActive>0?'Live progress below updates every 10 seconds.':agents.queued?'Queued work starts when the PC claims it.':'Propose a bounded job or analyze a repository to put an agent to work.'}</span></span></button>
  <button type="button" className={`mc-hud-tile tone-${cloud.execution.tone}`} onClick={actions.onAgents}><span className="mc-hud-icon"><Cloud size={18}/></span><span className="mc-hud-copy"><span className="mc-hud-label"><StatusLight tone={cloud.execution.tone}/>{cloud.execution.label}</span><span className="mc-hud-detail">Codex Cloud: {cloud.lastReportAt?`last imported report ${relativeTime(cloud.lastReportAt,model.now)} (${cloud.reportCount} saved)`:'no imported report yet'}. Live cloud task status is not connected.</span></span></button>
  <button type="button" className={`mc-hud-tile tone-${attention.tone}`} onClick={actions.onAttention}><span className="mc-hud-icon"><ListChecks size={18}/></span><span className="mc-hud-copy"><span className="mc-hud-label"><StatusLight tone={attention.tone}/>{attention.label}</span><span className="mc-hud-detail">{attention.total?'Reviews, approvals, overdue work and inbox captures.':'Reviews, approvals and inbox are clear.'}</span></span></button>
  <p className="mc-hud-foot" role="status"><Activity size={12}/>Agent and PC feeds {checked?`checked ${clockLabel(checked)} Cairo`:'loading…'}{failed.length?` · could not read: ${failed.join(', ')} (last good values shown)`:''}. Status lights describe saved records and heartbeats, never inferred execution.</p>
 </section>;
}

function ActiveJobCard({job,now,compact=false,onOpen}:{job:ActiveJob;now:string;compact?:boolean;onOpen:()=>void}){
 return <article className={`mc-job tone-${job.tone}`} aria-label={`Agent job ${job.operationLabel} for ${job.projectName}`}>
  <header className="mc-job-head"><StatusLight tone={job.tone}/><strong>{job.operationLabel}</strong><Chip tone={job.tone}>{job.statusLabel}</Chip>{!compact&&<ProjectChip name={job.projectName} color={job.projectColor}/>}<span className="mc-job-when">{job.startedAt?`started ${relativeTime(job.startedAt,now)}`:'not started'}</span></header>
  <p className="mc-job-task">{job.taskTitle}</p>
  <p className="mc-job-meta"><Bot size={13}/>{job.providerLabel} · {job.observedModel??job.model}{job.observedModel&&job.observedModel!==job.model?` (requested ${job.model})`:''} · <Laptop size={13}/>{job.deviceLabel?`on ${job.deviceLabel}`:'PC executor'}</p>
  <div className="mc-job-progress"><span className="mc-job-track"><span className="mc-job-stage"><Sparkles size={13}/>{job.stageLabel}{job.completedUnits!==null&&<b>{job.totalUnits!==null?` ${job.completedUnits}/${job.totalUnits}`:` ${job.completedUnits} units`}</b>}</span><Meter value={job.percent} tone="live" label={`Work progress ${job.percent===null?'not reported':job.percent+'%'}`}/></span><span className="mc-job-track"><span className="mc-job-time"><Timer size={13}/>{durationLabel(job.elapsedSeconds)} of {durationLabel(job.timeoutSeconds)} budget</span><Meter value={job.timePercent} tone={job.timePercent!==null&&job.timePercent>85?'warn':'idle'} label={`Time used ${job.timePercent===null?'unknown':job.timePercent+'%'}`}/></span></div>
  <p className="mc-job-foot">{job.eventCount} event{job.eventCount===1?'':'s'}{job.lastEventAt?` · last ${relativeTime(job.lastEventAt,now)}`:''} · tokens are reported when the run completes{job.diagnostic!=='ok'?` · ${job.diagnostic}`:''}<button type="button" className="text-button" onClick={onOpen}>Open in Agents<ArrowRight size={13}/></button></p>
 </article>;
}
function PersonalJobRow({job,now}:{job:PersonalJob;now:string}){
 return <li className={`mc-personal tone-${job.tone}`}><StatusLight tone={job.tone}/><span><strong>{job.label}</strong>{job.providerLabel?` · ${job.providerLabel}`:''}{job.projectName?<> · <ProjectChip name={job.projectName} color={null}/></>:''}<small>{job.claimedAt?`claimed ${relativeTime(job.claimedAt,now)}`:`requested ${relativeTime(job.createdAt,now)}`}</small></span></li>;
}
function RecentJobRow({job,now,onOpen}:{job:RecentJob;now:string;onOpen:()=>void}){
 return <li className="mc-recent"><StatusLight tone={job.tone}/><span className="mc-recent-copy"><span><strong>{job.operationLabel}</strong> · {job.taskTitle}</span><small><ProjectChip name={job.projectName} color={job.projectColor}/> {job.statusLabel} · {job.providerLabel} {job.observedModel??job.model}{job.modelVerified===true?' ✓':job.modelVerified===false?' (identity unverified)':''} · {relativeTime(job.finishedAt,now)}</small></span><span className="mc-recent-stats"><span title="Tokens in / out">{job.tokens?`${compactNumber(job.tokens.input)} in · ${compactNumber(job.tokens.output)} out`:'tokens not reported'}</span><span>{job.runtimeSeconds!==null?durationLabel(job.runtimeSeconds):'—'}</span><span>{job.artifacts} artifact{job.artifacts===1?'':'s'}{job.accepted?' · accepted':''}</span></span><button type="button" className="icon-button" aria-label={`Open job ${job.operationLabel} in Agents`} onClick={onOpen}><ChevronRight size={15}/></button></li>;
}
export function OperationsPanel({model,actions}:{model:DashboardModel;actions:DashboardActions}){
 const {active,recent,personal,execution}=model.operations,livePersonal=personal.filter(job=>job.active);
 return <section className="panel mc-ops" aria-label="Live operations">
  <div className="panel-heading"><div><p className="eyebrow">WHAT THE AGENTS ARE DOING</p><h2>Live operations <span className="count">{active.length+livePersonal.length}</span></h2></div><Chip tone={execution.tone}>{execution.label}</Chip></div>
  <p className="panel-intro">Bounded jobs run on your enrolled PC and report progress events here. Codex Cloud work arrives as imported reports, not live telemetry.</p>
  <div className="mc-ops-body">
   {active.length?<div className="mc-job-list">{active.map(job=><ActiveJobCard key={job.id} job={job} now={model.now} onOpen={actions.onAgents}/>)}</div>:null}
   {livePersonal.length?<ul className="mc-personal-list" aria-label="Personal PC analyses">{livePersonal.map(job=><PersonalJobRow key={job.id} job={job} now={model.now}/>)}</ul>:null}
   {!active.length&&!livePersonal.length&&<div className="mc-empty"><span className="empty-symbol"><Bot size={20} strokeWidth={1.5}/></span><h3>No agent is working right now</h3><p>Propose a bounded job under Agents, or analyze a repository under Repositories. Nothing starts without your explicit approval.</p><div className="data-actions"><button type="button" className="button secondary" onClick={actions.onAgents}>Open Agents<ArrowRight size={14}/></button><button type="button" className="button secondary" onClick={()=>actions.onRepositories()}>Analyze a repository<ArrowRight size={14}/></button></div></div>}
   {recent.length>0&&<section className="mc-recent-section" aria-label="Recent runs"><h3>Recent runs</h3><ul className="mc-recent-list">{recent.slice(0,6).map(job=><RecentJobRow key={job.id} job={job} now={model.now} onOpen={actions.onAgents}/>)}</ul></section>}
  </div>
  <div className="panel-footnote"><span className="tiny-dot"/>Token and time usage come from each run&apos;s recorded result. A result is contextual evidence; accepting it never completes a task.</div>
 </section>;
}

function AnalysisBlock({tile,now,actions}:{tile:ProjectTileModel;now:string;actions:DashboardActions}){
 const analysis=tile.analysis;
 if(!analysis)return null;
 return <details className="mc-analysis"><summary><Bot size={13}/>Technical analysis for your engineers<small>{analysis.providerLabel} · {relativeTime(analysis.recordedAt,now)} · <GitBranch size={11}/>{analysis.repositoryName} @ {analysis.head.slice(0,7)}{analysis.dirty?' (uncommitted changes)':''}</small></summary>
  <p className="mc-briefing-text">{analysis.excerpt}</p>
  {analysis.chats?<ul className="mc-chats" aria-label="Recent local chats">{analysis.chats.map(chat=><li key={chat.provider} className={chat.status==='included'?'included':''}><StatusLight tone={chat.status==='included'?'good':'idle'}/><strong>{chat.label}</strong>{chat.status==='included'?<span>{chat.messages} message{chat.messages===1?'':'s'} · last {relativeTime(chat.latestAt,now)}{chat.truncated?' · excerpt':''}</span>:<span>{chat.statusLabel}</span>}</li>)}</ul>:<p className="mc-briefing-note">{analysis.kind==='cloud'?'Imported from a Codex Cloud handoff; local chat history is not part of cloud reports.':'This report predates chat context; refresh the analysis to include recent chats.'}</p>}
  <p className="mc-briefing-note">{analysis.suggestedTasks} suggested task{analysis.suggestedTasks===1?'':'s'} waiting for review · {analysis.findings} cited finding{analysis.findings===1?'':'s'} · chat transcripts stay on your PC.<button type="button" className="text-button" onClick={()=>actions.onRepositories(tile.project.id)}>Open report<ArrowRight size={13}/></button></p>
 </details>;
}
const OUTCOME_ICON={finished:CheckCheck,unfinished:CircleDashed,unclear:HelpCircle} as const;
function BriefingControls({tile,actions}:{tile:ProjectTileModel;actions:DashboardActions}){
 const view=tile.briefing,id=tile.project.id,working=actions.briefingWorking[id]??false,notice=actions.briefingNotices[id]??null;
 const [provider,setProvider]=useState<'codex'|'claude'>(view.policy?.provider??view.report?.run.provider??(view.providers.find(row=>row.ready)?.id??'codex'));
 const [repository,setRepository]=useState<string>(view.repositoryKey??'');
 const repositoryKey=view.repositoryKey??(view.repositoryChoices.some(row=>row.key===repository)?repository:'');
 const ready=view.providers.find(row=>row.id===provider)?.ready??false;
 const canRequest=view.canRequest&&Boolean(repositoryKey)&&ready&&!working&&!actions.busy;
 const keepCurrent=view.policy?.enabled??false;
 return <div className="mc-brief-controls">
  {!view.repositoryKey&&view.repositoryChoices.length>0&&<label className="mc-brief-pick">Folder on your PC<select value={repository} onChange={event=>setRepository(event.target.value)} disabled={working}><option value="">Choose a folder</option>{view.repositoryChoices.map(row=><option key={row.key} value={row.key}>{row.name}</option>)}</select></label>}
  <label className="mc-brief-pick">Assistant<select value={provider} onChange={event=>setProvider(event.target.value as 'codex'|'claude')} disabled={working}>{view.providers.map(row=><option key={row.id} value={row.id}>{row.label}{row.ready?'':' (not signed in)'}</option>)}</select></label>
  <button type="button" className="button secondary" disabled={!canRequest} onClick={()=>actions.onBrief(id,repositoryKey,provider)}><RefreshCw size={13}/>{view.report?'Refresh briefing':'Brief this project'}</button>
  {repositoryKey&&<label className="mc-brief-toggle"><input type="checkbox" checked={keepCurrent} disabled={working||actions.busy||view.connector!=='online'&&!keepCurrent} onChange={event=>actions.onKeepCurrent(id,repositoryKey,provider,event.target.checked)}/><span>Keep current{keepCurrent&&view.policy?` · ${view.policy.provider==='codex'?'Codex':'Claude Code'}, at most every ${view.policy.minIntervalMinutes>=120?`${Math.round(view.policy.minIntervalMinutes/60)} h`:`${view.policy.minIntervalMinutes} min`}`:''}</span></label>}
  {view.requestHint&&!view.activeJob&&<p className="mc-brief-hint">{view.requestHint}</p>}
  {notice&&<p className={`mc-brief-notice tone-${notice.tone}`} role={notice.tone==='bad'?'alert':'status'}>{notice.message}{notice.retry&&<button type="button" className="text-button" disabled={working||actions.busy} onClick={()=>actions.onRetrySave(id)}>Retry save</button>}</p>}
 </div>;
}
export function BriefingCard({tile,now,actions}:{tile:ProjectTileModel;now:string;actions:DashboardActions}){
 const view=tile.briefing,report=view.report;
 return <section className={`mc-brief tone-${view.status.tone}`} aria-label={`Briefing for ${tile.project.name}`}>
  <header className="mc-brief-head"><Sparkles size={15}/><strong>Where we&apos;re at</strong><Chip tone={view.status.tone}>{view.status.label}</Chip>{report&&<small>as of {relativeTime(view.recordedAt,now)} · {view.providerLabel} · {view.originLabel}{view.source==='completed'?' · saving…':''}</small>}</header>
  {view.activeJob&&<p className="mc-brief-live" role="status"><StatusLight tone="live"/>{view.activeJob.status==='claimed'?`${view.activeJob.providerLabel} is writing the briefing on your PC`:'Waiting for your PC to pick up the briefing'}{view.activeJob.origin==='auto'?' (kept current)':''} · {relativeTime(view.activeJob.claimedAt??view.activeJob.createdAt,now)}</p>}
  {view.lastFailure&&<p className="mc-brief-flag tone-bad"><AlertTriangle size={13}/>The last briefing attempt did not finish: {view.lastFailure.reason} ({relativeTime(view.lastFailure.at,now)}).</p>}
  {report?<>
   <p className="mc-brief-headline">{report.headline}</p>
   <p className="mc-brief-reason">{report.status.reason}</p>
   {view.freshness.newWork&&<p className="mc-brief-flag tone-warn"><AlertTriangle size={13}/>{view.freshness.detail} {view.policy?.enabled?'A refresh is scheduled the next time your PC is on.':'Refresh to catch up.'}</p>}
   {view.work.length>0&&<div className="mc-brief-work"><strong>Last pieces of work</strong><ul>{view.work.map((row,index)=>{const Icon=OUTCOME_ICON[row.outcome];return <li key={index} className={`tone-${row.tone}`}><Icon size={14}/><span><b>{row.title}</b><em>{row.outcomeLabel} · {row.whereLabel}{row.when?` · ${dateLabel(row.when)}`:''}</em><small>{row.detail}</small></span></li>;})}</ul></div>}
   {report.unfinished.length>0&&<div className="mc-brief-unfinished"><strong>Still open from that work</strong><ul>{report.unfinished.map((row,index)=><li key={index}><b>{row.title}</b> · {row.remaining}</li>)}</ul></div>}
   <div className="mc-brief-columns"><div><strong><CheckCheck size={12}/>Done</strong>{report.done.length?<ul>{report.done.map((text,index)=><li key={index}>{text}</li>)}</ul>:<p>Nothing recorded as done yet.</p>}</div><div><strong><CircleDashed size={12}/>Not yet</strong>{report.notDone.length?<ul>{report.notDone.map((text,index)=><li key={index}>{text}</li>)}</ul>:<p>Nothing outstanding was identified.</p>}</div></div>
   {report.decisionsNeeded.length>0&&<div className="mc-brief-decisions"><strong><Flag size={12}/>Needs your decision</strong><ul>{report.decisionsNeeded.map((text,index)=><li key={index}>{text}</li>)}</ul></div>}
   {report.nextSteps.length>0&&<div className="mc-brief-next"><strong><ArrowRight size={12}/>Next steps</strong><ol>{report.nextSteps.map((text,index)=><li key={index}>{text}</li>)}</ol></div>}
   <details className="mc-brief-basis"><summary>How this briefing was put together</summary><p>Based on work up to {relativeTime(view.freshness.basedOnAt,now)}: {view.evidenceLine}. Written by {view.providerLabel} on your PC{report.run.observedModel?` (${report.run.observedModel})`:''}; chat text and code never leave your PC except inside that one request.</p>{view.work.some(row=>row.evidence.length>0)&&<p className="mc-brief-refs">References for your engineers: {view.work.flatMap(row=>row.evidence).join(', ')}</p>}<ul>{report.limitations.map((text,index)=><li key={index}>{text}</li>)}</ul></details>
  </>:!view.activeJob&&<div className="mc-brief-empty"><p>No briefing yet. Your PC can write one from the latest commits, GitHub branches and pull requests, your recent Codex and Claude Code chats, and your plan.</p></div>}
  <BriefingControls tile={tile} actions={actions}/>
 </section>;
}
export function ProjectTile({tile,now,actions,workspace}:{tile:ProjectTileModel;now:string;actions:DashboardActions;workspace:Workspace}){
 const {project,progress,agent}=tile;
 return <article className={`mc-project ${project.color}`} aria-label={`Project ${project.name}`}>
  <header className="mc-project-head"><ProjectIcon project={project}/><div className="mc-project-title"><h2>{project.name}</h2><p>{project.goal||'Define the outcome you want to work toward.'}</p></div><span className="mc-level" title="Progress level: achieved milestones plus one per five completed tasks">LVL {tile.level}</span></header>
  <div className={`mc-agent-pill tone-${agent.tone}`} role="status"><StatusLight tone={agent.tone}/>{agent.label}{agent.state==='idle'&&tile.lastRunAt?<small>· last run {relativeTime(tile.lastRunAt,now)}</small>:null}</div>
  <div className="mc-progress-grid">
   <div><span className="mc-progress-label"><Flag size={12}/>Milestones<b>{progress.milestonesDone}/{progress.milestonesTotal}</b></span><Meter value={progress.milestonePercent} tone="good" label={`Milestones achieved ${progress.milestonePercent}%`}/></div>
   <div><span className="mc-progress-label"><CheckCheck size={12}/>Tasks done<b>{progress.tasksDone}/{progress.tasksTotal}</b></span><Meter value={progress.taskPercent} tone="live" label={`Tasks completed ${progress.taskPercent}%`}/></div>
  </div>
  <div className="mc-chip-row">{progress.inProgress>0&&<Chip tone="live">{progress.inProgress} in progress</Chip>}{progress.inReview>0&&<Chip tone="warn">{progress.inReview} in review</Chip>}{progress.blocked>0&&<Chip tone="bad">{progress.blocked} blocked</Chip>}{progress.overdue>0&&<Chip tone="bad">{progress.overdue} overdue</Chip>}{progress.weeklyPinned>0&&<Chip tone="good"><Pin size={10}/>{progress.weeklyPinned} this week</Chip>}{progress.proposed>0&&<Chip>{progress.proposed} proposed</Chip>}{tile.milestone&&<Chip tone="idle" title={tile.milestone.targetDate?`Target ${dateLabel(tile.milestone.targetDate)}`:'No target date'}>{tile.milestone.status==='active'?'Now: ':'Next: '}{tile.milestone.title}</Chip>}</div>
  {(agent.jobs.length>0||agent.personal.length>0)&&<div className="mc-project-live">{agent.jobs.map(job=><ActiveJobCard key={job.id} job={job} now={now} compact onOpen={actions.onAgents}/>)}{agent.personal.length>0&&<ul className="mc-personal-list">{agent.personal.map(job=><PersonalJobRow key={job.id} job={job} now={now}/>)}</ul>}</div>}
  <BriefingCard tile={tile} now={now} actions={actions}/>
  <AnalysisBlock tile={tile} now={now} actions={actions}/>
  <div className="mc-project-columns">
   <div className="mc-activity"><strong><Activity size={13}/>Recent activity</strong>{tile.activity.length?<ul>{tile.activity.map(entry=><li key={entry.id}><time dateTime={entry.at}>{relativeTime(entry.at,now)}</time><span>{entry.text}</span></li>)}</ul>:<p>No saved activity for this project yet.</p>}</div>
   <div className="mc-next"><strong><Sparkles size={13}/>Next action</strong>{tile.nextAction?<button type="button" className="mc-next-task" onClick={()=>actions.onTask(tile.nextAction!.task)}><span>{tile.nextAction.task.title}<TaskContext task={tile.nextAction.task} workspace={workspace}/></span><small>{tile.nextAction.reason}</small></button>:<p>No ready step. Accept a proposal or add a task.</p>}</div>
  </div>
  <footer className="mc-project-foot"><span title="Summed from recorded run results">{tile.tokens.runs?`${compactNumber(tile.tokens.input)} in · ${compactNumber(tile.tokens.output)} out · ${tile.tokens.runs} run${tile.tokens.runs===1?'':'s'}${tile.tokens.reported<tile.tokens.runs?` (${tile.tokens.runs-tile.tokens.reported} without usage)`:''}`:'No agent run recorded'}</span><span className="mc-project-actions"><button type="button" className="button secondary" onClick={()=>actions.onRepositories(project.id)}>Analyze</button><button type="button" className="button primary" onClick={()=>actions.onProject(project)}>Open project<ArrowRight size={14}/></button></span></footer>
 </article>;
}

export function AttentionPanel({model,actions}:{model:DashboardModel;actions:DashboardActions}){
 const items=model.attention.slice(0,8);
 const open=(item:AttentionItem)=>{if(item.taskId)actions.onTaskId(item.taskId);else if(item.jobId)actions.onAgents();else if(item.kind==='inbox')actions.onInbox();else actions.onAttention();};
 return <section className="panel mc-attention" aria-label="Needs you"><div className="panel-heading"><div><p className="eyebrow">YOUR MOVE</p><h2>Needs you <span className="count">{model.hud.attention.total}</span></h2></div><Flag size={18} className="muted-icon"/></div>
  {items.length?<ul className="mc-attention-list">{items.map(item=><li key={item.key}><button type="button" onClick={()=>open(item)}><StatusLight tone={item.tone}/><span><strong>{item.title}</strong><small>{item.detail}{item.projectName?` · ${item.projectName}`:''}</small></span><ChevronRight size={14}/></button></li>)}</ul>:<div className="mc-empty small"><span className="empty-symbol"><CheckCheck size={18} strokeWidth={1.5}/></span><h3>All clear</h3><p>No reviews, approvals, overdue work or inbox captures are waiting.</p></div>}
  <div className="mc-attention-foot"><button type="button" className="text-button" onClick={actions.onAttention}>Open all attention items<ArrowRight size={13}/></button>{model.attention.length>items.length&&<span className="quiet-label">{model.attention.length-items.length} more</span>}</div>
 </section>;
}
export function WeekPanel({workspace,now,actions}:{workspace:Workspace;now:string;actions:DashboardActions}){
 const weekly=workspace.tasks.filter(task=>isCurrentWeek(task,now)&&!['done','archived'].includes(task.status)&&!archivedEntity(workspace,{kind:'task',id:task.id}));
 const completed=weeklyCompletionCount(workspace.tasks,now);
 return <section className="panel weekly-panel mc-week" aria-labelledby="weekly-heading"><div className="panel-heading"><div><p className="eyebrow">MAKE IT INTENTIONAL</p><h2 id="weekly-heading">This week <span className="count">{weekly.length}</span></h2></div><Pin size={18} className="muted-icon"/></div>
  {weekly.length?<div className="weekly-list">{weekly.slice(0,6).map(task=>{const project=workspace.projects.find(row=>row.id===task.projectId);return <button className="weekly-item" key={task.id} onClick={()=>actions.onTask(task)}><span className={`weekly-marker ${project?.color??''}`}/><span>{task.title}<TaskContext task={task} workspace={workspace}/></span><ChevronRight size={15}/></button>;})}</div>:<div className="mc-empty small"><h3>Leave a little room. Then choose.</h3><p>Pin a few tasks to give your week a clear focus.</p></div>}
  <div className="mc-attention-foot">{completed>0&&<span className="weekly-done"><CheckCheck size={15}/>{completed} completed this week</span>}<button type="button" className="text-button" onClick={actions.onWeekly}>Plan the week<ArrowRight size={13}/></button></div>
 </section>;
}
export function MissionLog({log,now,actions}:{log:LogEntry[];now:string;actions:DashboardActions}){
 return <section className="panel mc-log" aria-label="Mission log"><div className="panel-heading"><div><p className="eyebrow">WHAT HAPPENED</p><h2>Mission log</h2></div><Chip tone="idle"><Inbox size={11}/>last {log.length} saved changes</Chip></div>
  {log.length?<ol className="mc-log-list">{log.map(entry=><li key={entry.id}><time dateTime={entry.at} title={entry.at}>{relativeTime(entry.at,now)}</time><ProjectChip name={entry.projectName} color={entry.projectColor}/><span>{entry.text}</span></li>)}</ol>:<p className="panel-intro">Saved changes will appear here.</p>}
  <div className="panel-footnote"><span className="tiny-dot"/>Dated activity from your saved workspace. Agent events live in Live operations.<button type="button" className="text-button" onClick={actions.onProjects}>Open projects<ArrowRight size={13}/></button></div>
 </section>;
}
export function FeedWarning({model}:{model:DashboardModel}){
 const failed=(Object.entries(model.feeds) as [string,{status:string;message?:string}][]).filter(([,state])=>state.status==='failed');
 if(!failed.length)return null;
 return <p className="mc-feed-warning" role="status"><AlertTriangle size={14}/>Some live feeds could not be read ({failed.map(([key])=>key).join(', ')}). The last good values stay on screen with their check time.</p>;
}
