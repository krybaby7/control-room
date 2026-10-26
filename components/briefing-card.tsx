'use client';
import {useMemo,useState} from 'react';
import {AlertTriangle,ArrowRight,Ban,Check,CheckCheck,CircleDashed,CircleDot,CornerUpRight,Flag,Minus,Pause,RefreshCw,Sparkles,X} from 'lucide-react';
import type {BriefingAreaRow,BriefingIntentionRow,BriefingLedger,ProjectTile as ProjectTileModel,SignalTone} from '@/lib/dashboard/model';
import {AREA_STATE} from '@/lib/dashboard/model';
import {relativeTime} from '@/lib/dashboard/format';
import {dateLabel} from './ui';
import {Chip,StatusLight,type DashboardActions} from './mission-control-panels';

/* The owner's briefing card: the aim, where we left off, a map of the project's areas, the intention
 * trail, where the plan bent, and what needs the owner. Everything is drawn from the saved report;
 * reading or filtering it changes nothing. */

const STATE_ICON={reached:Check,negative:Minus,changed:CornerUpRight,paused:Pause,'not-reached':X,'in-progress':CircleDot,open:CircleDot} as const;
const AREA_ICON={proven:Check,built:CircleDot,partial:CircleDashed,open:CircleDot,paused:Pause,blocked:Ban,none:Minus} as const;
const TRAIL_PREVIEW=7;
type TrailFilter='all'|'bends'|'open';
const OPEN_STATES=new Set(['not-reached','paused','in-progress','open']);

/** Layered layout: an area's column is the longest path of links that reaches it, so the map reads left to right. */
function layoutMap(areas:BriefingAreaRow[],links:{from:string;to:string}[]){
 const depth=new Map(areas.map(area=>[area.id,0]));
 for(let i=0;i<areas.length;i++)for(const link of links){const next=(depth.get(link.from)??0)+1;if((depth.get(link.to)??0)<next)depth.set(link.to,next);}
 const columns=new Map<number,BriefingAreaRow[]>();
 for(const area of areas){const column=depth.get(area.id)??0;if(!columns.has(column))columns.set(column,[]);columns.get(column)!.push(area);}
 const keys=[...columns.keys()].sort((a,b)=>a-b);
 const W=176,H=64,GX=46,GY=18,PAD=14,TAG=16;
 const rows=Math.max(1,...keys.map(key=>columns.get(key)!.length));
 const width=PAD*2+keys.length*W+Math.max(0,keys.length-1)*GX,height=PAD*2+TAG+rows*H+(rows-1)*GY;
 const position=new Map<string,{x:number;y:number}>();
 keys.forEach((key,columnIndex)=>{const list=columns.get(key)!,total=list.length*H+(list.length-1)*GY,top=PAD+TAG+(rows*H+(rows-1)*GY-total)/2;list.forEach((area,rowIndex)=>position.set(area.id,{x:PAD+columnIndex*(W+GX),y:top+rowIndex*(H+GY)}));});
 return {W,H,width,height,position};
}
function AreaGlyph({state,tone,x,y}:{state:BriefingAreaRow['state'];tone:SignalTone;x:number;y:number}){
 const Icon=AREA_ICON[state];
 return <g transform={`translate(${x} ${y})`} className={`mc-map-glyph tone-${tone}`}><circle cx="9" cy="9" r="8"/><Icon x="3" y="3" width="12" height="12" strokeWidth={2.2}/></g>;
}
export function ProjectMap({ledger,selected,onSelect}:{ledger:BriefingLedger;selected:string|null;onSelect:(areaId:string|null)=>void}){
 const layout=useMemo(()=>layoutMap(ledger.areas,ledger.links),[ledger.areas,ledger.links]);
 if(!ledger.areas.length)return null;
 const {W,H,width,height,position}=layout;
 const pick=(id:string)=>onSelect(selected===id?null:id);
 return <div className="mc-map">
  <div className="mc-map-legend" aria-label="Key">{(Object.keys(AREA_STATE) as (keyof typeof AREA_STATE)[]).map(state=>{const Icon=AREA_ICON[state];return <span key={state} className={`tone-${AREA_STATE[state].tone}`}><Icon size={13}/><em>{AREA_STATE[state].label}</em></span>;})}</div>
  <div className="mc-map-scroll" tabIndex={0} aria-label="Map of the project's areas; scrolls sideways on narrow screens">
   <svg viewBox={`0 0 ${width} ${height}`} style={{minWidth:Math.min(width,900)}} role="img" aria-label="Map of the project's areas, how far each is proven, and what feeds what. Tap an area to see only its intentions.">
    <defs><marker id="mc-map-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path className="mc-map-arrowhead" d="M0 0L10 5L0 10z"/></marker></defs>
    {ledger.links.map(link=>{const a=position.get(link.from),b=position.get(link.to);if(!a||!b)return null;const x1=a.x+W,y1=a.y+H/2,x2=b.x,y2=b.y+H/2,mx=(x1+x2)/2;return <path key={`${link.from}>${link.to}`} className="mc-map-link" d={`M${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2-2} ${y2}`} markerEnd="url(#mc-map-arrow)"/>;})}
    {ledger.areas.map(area=>{const p=position.get(area.id)!,fraction=area.total?area.done/area.total:0,bar=W-24,isSelected=selected===area.id;
     return <g key={area.id} className={`mc-map-node tone-${area.tone}${isSelected?' selected':''}${area.isAim?' aim':''}`} role="button" tabIndex={0} aria-pressed={isSelected} onClick={()=>pick(area.id)} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();pick(area.id);}}}>
      <title>{`${area.name}: ${area.stateLabel}. ${area.note}. ${area.done} of ${area.total} parts done. Tap to see this area's intentions.`}</title>
      {area.isAim&&<text className="mc-map-aim" x={p.x} y={p.y-5}>CURRENT AIM</text>}
      <rect className="mc-map-box" x={p.x} y={p.y} width={W} height={H} rx="9" strokeDasharray={area.state==='none'?'5 4':undefined}/>
      <AreaGlyph state={area.state} tone={area.tone} x={p.x+W-26} y={p.y+8}/>
      <text className="mc-map-name" x={p.x+12} y={p.y+22}>{area.name}</text>
      <text className="mc-map-note" x={p.x+12} y={p.y+38}>{area.note}</text>
      <rect className="mc-map-track" x={p.x+12} y={p.y+48} width={bar} height="5" rx="2.5"/>
      {fraction>0&&<rect className="mc-map-fill" x={p.x+12} y={p.y+48} width={Math.max(6,bar*fraction)} height="5" rx="2.5"/>}
     </g>;})}
   </svg>
  </div>
  <p className="mc-map-hint">Swipe the map sideways to see all of it.</p>
 </div>;
}
function IntentionItem({row,newSince}:{row:BriefingIntentionRow;newSince:string|null}){
 const Icon=row.bend?CornerUpRight:STATE_ICON[row.state];
 return <li>
  <span className="mc-trail-when">{row.date?dateLabel(row.date):'undated'}</span>
  <span className="mc-trail-rail"><span className={`mc-trail-dot ${row.bend?'bend':`tone-${row.tone}`}`} title={row.bend?'The plan changed here':row.stateLabel}><Icon size={11}/></span></span>
  <div className="mc-trail-what">
   <div className="mc-trail-title"><b>{row.title}</b>{row.isNew&&newSince&&<span className="mc-trail-new">new since {dateLabel(newSince.slice(0,10))}</span>}</div>
   <p className="mc-trail-outcome"><em className={`tone-${row.tone}`}>{row.stateLabel}.</em> {row.outcome}</p>
   <p className="mc-trail-source">Said in {row.sourceLabel}{row.areaName?` · area: ${row.areaName}`:''}</p>
   {row.bend&&<div className="mc-trail-bend"><b>The plan changed here</b><span>From: {row.bend.from}</span><span>To: <strong>{row.bend.to}</strong></span><span>Why: {row.bend.why}</span></div>}
  </div>
 </li>;
}
export function IntentionTrail({ledger,area,onClearArea}:{ledger:BriefingLedger;area:string|null;onClearArea:()=>void}){
 const [filter,setFilter]=useState<TrailFilter>('all');
 const [expanded,setExpanded]=useState(false);
 const kept=ledger.intentions.filter(row=>(!area||row.areaId===area)&&(filter==='all'||(filter==='bends'&&row.bend!==null)||(filter==='open'&&OPEN_STATES.has(row.state))));
 const shown=expanded?kept:kept.slice(0,TRAIL_PREVIEW);
 const areaName=area?ledger.areas.find(row=>row.id===area)?.name??area:null;
 const choose=(next:TrailFilter)=>{setFilter(next);setExpanded(false);};
 return <section className="mc-trail-section" aria-label="Your intentions">
  <div className="mc-brief-sechead"><strong>Your intentions, newest first{areaName&&<span className="mc-trail-area">{areaName}<button type="button" className="text-button" onClick={onClearArea}>show all areas</button></span>}</strong>
   <div className="mc-seg" role="group" aria-label="Filter the trail">
    <button type="button" aria-pressed={filter==='all'} onClick={()=>choose('all')}>All</button>
    <button type="button" aria-pressed={filter==='bends'} onClick={()=>choose('bends')}>Plan changes</button>
    <button type="button" aria-pressed={filter==='open'} onClick={()=>choose('open')}>Still open</button>
   </div></div>
  {shown.length?<ol className="mc-trail">{shown.map((row,index)=><IntentionItem key={`${row.date??'undated'}:${index}:${row.title}`} row={row} newSince={ledger.newSince}/>)}</ol>:<p className="mc-brief-empty-line">Nothing recorded {area?'for this area':'here'} yet.</p>}
  {kept.length>shown.length&&<div className="mc-trail-more"><button type="button" className="text-button" onClick={()=>setExpanded(true)}>Show {kept.length-shown.length} earlier intention{kept.length-shown.length===1?'':'s'}</button></div>}
 </section>;
}
function PlanChanges({ledger}:{ledger:BriefingLedger}){
 const bends=[...ledger.intentions].reverse().filter(row=>row.bend);
 if(!bends.length)return null;
 return <section className="mc-brief-section" aria-label="How the plan changed">
  <div className="mc-brief-sechead"><strong>How the plan changed along the way</strong><p>Each bend: what it was, what it became, and why.</p></div>
  <div className="mc-bends">{bends.map((row,index)=><div key={index} className="mc-bend"><span className="mc-bend-date">{row.date?dateLabel(row.date):'undated'}</span><div className="mc-bend-fromto"><span><i>From</i><span>{row.bend!.from}</span></span><span><i>To</i><span className="to">{row.bend!.to}</span></span></div><p className="mc-bend-why">{row.bend!.why}</p></div>)}</div>
 </section>;
}
function BriefingControls({tile,actions}:{tile:ProjectTileModel;actions:DashboardActions}){
 const view=tile.briefing,id=tile.project.id,working=actions.briefingWorking[id]??false,notice=actions.briefingNotices[id]??null;
 const [provider,setProvider]=useState<'codex'|'claude'>(view.policy?.provider??view.report?.run.provider??(view.providers.find(row=>row.ready)?.id??'codex'));
 const [repository,setRepository]=useState<string>(view.repositoryKey??'');
 const repositoryKey=view.repositoryKey??(view.repositoryChoices.some(row=>row.key===repository)?repository:'');
 const ready=view.providers.find(row=>row.id===provider)?.ready??false;
 const canRequest=view.canRequest&&Boolean(repositoryKey)&&ready&&!working&&!actions.busy;
 const keepCurrent=view.policy?.enabled??false;
 const requestHint=!view.repositoryKey&&repositoryKey&&view.connector==='online'&&ready?null:view.requestHint;
 return <div className="mc-brief-controls">
  {!view.repositoryKey&&view.repositoryChoices.length>0&&<label className="mc-brief-pick">Folder on your PC<select value={repository} onChange={event=>setRepository(event.target.value)} disabled={working}><option value="">Choose a folder</option>{view.repositoryChoices.map(row=><option key={row.key} value={row.key}>{row.name}</option>)}</select></label>}
  <label className="mc-brief-pick">Assistant<select value={provider} onChange={event=>setProvider(event.target.value as 'codex'|'claude')} disabled={working}>{view.providers.map(row=><option key={row.id} value={row.id}>{row.label}{row.ready?'':' (not signed in)'}</option>)}</select></label>
  <button type="button" className="button secondary" disabled={!canRequest} onClick={()=>actions.onBrief(id,repositoryKey,provider)}><RefreshCw size={13}/>{view.report?'Refresh briefing':'Brief this project'}</button>
  {repositoryKey&&<label className="mc-brief-toggle"><input type="checkbox" checked={keepCurrent} disabled={working||actions.busy||view.connector!=='online'&&!keepCurrent} onChange={event=>actions.onKeepCurrent(id,repositoryKey,provider,event.target.checked)}/><span>Keep current{keepCurrent&&view.policy?` · ${view.policy.provider==='codex'?'Codex':'Claude Code'}, at most every ${view.policy.minIntervalMinutes>=120?`${Math.round(view.policy.minIntervalMinutes/60)} h`:`${view.policy.minIntervalMinutes} min`}`:''}</span></label>}
  {requestHint&&!view.activeJob&&<p className="mc-brief-hint">{requestHint}</p>}
  {notice&&<p className={`mc-brief-notice tone-${notice.tone}`} role={notice.tone==='bad'?'alert':'status'}>{notice.message}{notice.retry&&<button type="button" className="text-button" disabled={working||actions.busy} onClick={()=>actions.onRetrySave(id)}>Retry save</button>}</p>}
 </div>;
}
export function BriefingCard({tile,now,actions}:{tile:ProjectTileModel;now:string;actions:DashboardActions}){
 const view=tile.briefing,report=view.report,ledger=view.ledger;
 const [area,setArea]=useState<string|null>(null);
 const selected=area&&ledger.areas.some(row=>row.id===area)?area:null;
 return <section className={`mc-brief tone-${view.status.tone}`} aria-label={`Briefing for ${tile.project.name}`}>
  <header className="mc-brief-head"><Sparkles size={15}/><strong>Where we&apos;re at</strong><Chip tone={view.status.tone}>{view.status.label}</Chip>{report&&<small>as of {relativeTime(view.recordedAt,now)} · {view.providerLabel} · {view.originLabel}{view.source==='completed'?' · saving…':''}</small>}</header>
  {view.activeJob&&<p className="mc-brief-live" role="status"><StatusLight tone="live"/>{view.activeJob.status==='claimed'?`${view.activeJob.providerLabel} is writing the briefing on your PC`:'Waiting for your PC to pick up the briefing'}{view.activeJob.origin==='auto'?' (kept current)':''} · {relativeTime(view.activeJob.claimedAt??view.activeJob.createdAt,now)}</p>}
  {view.lastFailure&&<p className="mc-brief-flag tone-bad"><AlertTriangle size={13}/>The last briefing attempt did not finish: {view.lastFailure.reason} ({relativeTime(view.lastFailure.at,now)}).</p>}
  {report?<>
   <p className="mc-brief-reason">{report.status.reason}</p>
   <div className="mc-brief-aim"><span>The aim right now</span><p className="mc-brief-headline">{report.aim}</p></div>
   {report.fitOrDrift&&<p className="mc-brief-leftoff mc-brief-fit">{report.fitOrDrift}</p>}
   {report.leftOff.map((text,index)=><p key={index} className="mc-brief-leftoff">{text}</p>)}
   {view.freshness.newWork&&<p className="mc-brief-flag tone-warn"><AlertTriangle size={13}/>{view.freshness.detail} {view.policy?.enabled?'A refresh is scheduled the next time your PC is on.':'Refresh to catch up.'}</p>}
   {ledger.areas.length>0&&<section className="mc-brief-section" aria-label="Project map"><div className="mc-brief-sechead"><strong>Where the project stands</strong><p>Each area, how far it is proven, and what feeds what. Tap an area to see only its intentions below.</p></div><ProjectMap ledger={ledger} selected={selected} onSelect={setArea}/></section>}
   {ledger.intentions.length>0&&<IntentionTrail ledger={ledger} area={selected} onClearArea={()=>setArea(null)}/>}
   <PlanChanges ledger={ledger}/>
   <div className="mc-brief-columns mc-brief-ledger-columns">
    <div className="mc-brief-decisions"><strong><Flag size={12}/>Needs you</strong>{report.needsYou.length?<ul>{report.needsYou.map((text,index)=><li key={index}>{text}</li>)}</ul>:<p>Nothing waits on you right now.</p>}</div>
    <div><strong><CircleDashed size={12}/>Still open</strong>{report.open.length?<ul>{report.open.map((text,index)=><li key={index}>{text}</li>)}</ul>:<p>Nothing unresolved was identified.</p>}{report.nextSteps.length>0&&<div className="mc-brief-next"><strong><ArrowRight size={12}/>Next steps</strong><ol>{report.nextSteps.map((text,index)=><li key={index}>{text}</li>)}</ol></div>}</div>
   </div>
   {report.tried.length>0&&<details className="mc-brief-fold"><summary>What was tried and did not work</summary><ul>{report.tried.map((text,index)=><li key={index}>{text}</li>)}</ul></details>}
   <details className="mc-brief-fold"><summary>Done and not yet done</summary><div className="mc-brief-columns"><div><strong><CheckCheck size={12}/>Done</strong>{report.done.length?<ul>{report.done.map((text,index)=><li key={index}>{text}</li>)}</ul>:<p>Nothing recorded as done yet.</p>}</div><div><strong><CircleDashed size={12}/>Not yet</strong>{report.notDone.length?<ul>{report.notDone.map((text,index)=><li key={index}>{text}</li>)}</ul>:<p>Nothing outstanding was identified.</p>}</div></div></details>
   <details className="mc-brief-basis"><summary>How this briefing was put together</summary><p>Based on work up to {relativeTime(view.freshness.basedOnAt,now)}: {view.evidenceLine}. Written by {view.providerLabel} on your PC{report.run.observedModel?` (${report.run.observedModel})`:''}; chat text and code never leave your PC except inside that one request.</p>{ledger.intentions.some(row=>row.evidence.length>0)&&<p className="mc-brief-refs">References for your engineers: {ledger.intentions.flatMap(row=>row.evidence).join(', ')}</p>}<ul>{report.limitations.map((text,index)=><li key={index}>{text}</li>)}</ul></details>
  </>:!view.activeJob&&<div className="mc-brief-empty"><p>No briefing yet. Your PC can measure your intentions against your project framing using your own messages in Codex and Claude Code, the latest commits, and GitHub branches and pull requests. Your task plan is included only when you enable it in the project editor.</p></div>}
  <BriefingControls tile={tile} actions={actions}/>
 </section>;
}
