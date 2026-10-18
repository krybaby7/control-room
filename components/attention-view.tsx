'use client';

import { useId, useState, useEffect, useEffectEvent, useRef, useContext, type MouseEvent } from 'react';
import {z} from 'zod';
import {weeklyPlanSchema,weeklyReviewSchema,validateWeeklyReviewHistory,type WeeklyPlan} from '@/lib/weekly-planning';
import {parseRecurrenceRule,recurrenceOccurrenceSchema} from '@/lib/recurrence';
import {boundedRequest} from '@/lib/save-controller';
import {SessionExpiredError} from '@/lib/workspace-client';
import type { Workspace } from '@/lib/types';
import {entityHref,type EntityTarget} from '@/lib/entity-links';
import { buildAttention, attentionPage, type AttentionKind } from '@/lib/attention';
import { cairoDate, currentWeek } from '@/lib/calendar';
import {loadOwnerAttentionFindings,type OwnerAttentionFindings} from '@/lib/attention-findings';
import {SessionExpiredContext} from './session-state';
import { dateLabel, EmptyState } from './ui';

async function readOwnerJson(response:Response):Promise<unknown>{
 if(!response.ok)throw new Error('Owner attention could not be loaded.');
 const reader=response.body?.getReader();if(!reader)throw new Error('Owner attention response is unavailable.');
 const decoder=new TextDecoder('utf-8',{fatal:true});let bytes=0,text='';
 try{for(;;){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>8_000_000){void reader.cancel().catch(()=>{});throw new Error('Owner attention exceeds its read limit.');}text+=decoder.decode(chunk.value,{stream:true});}return JSON.parse(text+decoder.decode());}finally{reader.releaseLock();}
}
interface AttentionSource {revision:number;weeklyPlans:WeeklyPlan[]}
const sourceRow=z.object({id:z.string().min(1).max(128),rowRevision:z.number().int().positive().safe(),contentHash:z.string().regex(/^[a-f0-9]{64}$/),value:z.unknown()}).strict();
const sourceModule=z.object({records:z.array(sourceRow).max(10000)}).passthrough();
const planningSource=z.object({revision:z.number().int().positive().safe(),modules:z.object({weekly_plans:sourceModule,weekly_reviews:sourceModule,recurrence_rules:sourceModule,recurrence_occurrences:sourceModule}).passthrough()}).passthrough();
async function readSource(response:Response):Promise<AttentionSource>{
 if(!response.ok)throw new Error('Planning attention could not be loaded. Refresh before reviewing earlier commitments.');
 const reader=response.body?.getReader();if(!reader)throw new Error('Planning source is empty.');let bytes=0;const chunks:Uint8Array[]=[];try{for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>8_000_000){await reader.cancel();throw new Error('Planning attention exceeds the view limit.');}chunks.push(part.value);}}finally{reader.releaseLock();}
 const value=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){value.set(chunk,offset);offset+=chunk.length;}const source=planningSource.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(value)));
 const weeklyPlans=source.modules.weekly_plans.records.map(row=>{const plan=weeklyPlanSchema.parse(row.value);if(plan.weekStart!==row.id)throw new Error('Planning row identity differs.');return plan;});
 validateWeeklyReviewHistory(source.modules.weekly_reviews.records.map(row=>{const review=weeklyReviewSchema.parse(row.value);if(review.id!==row.id)throw new Error('Review row identity differs.');return review;}));
 for(const row of source.modules.recurrence_rules.records)if(parseRecurrenceRule(row.value).id!==row.id)throw new Error('Recurrence row identity differs.');
 for(const row of source.modules.recurrence_occurrences.records){const occurrence=recurrenceOccurrenceSchema.parse(row.value);if(`${occurrence.ruleId}:${occurrence.occurrenceDate}`!==row.id)throw new Error('Occurrence row identity differs.');}
 return {revision:source.revision,weeklyPlans};
}

const labels: Record<AttentionKind, string> = { blocked: 'Blocked', overdue: 'Overdue tasks', review: 'Ready for review', proposal: 'Proposals', 'carry-forward': 'Earlier commitments', 'capture-inbox': 'Capture inbox', 'milestone-overdue': 'Overdue milestones', 'missing-evidence': 'Missing evidence', 'stale-source': 'Stale sources', 'failed-job': 'Failed jobs' };
export interface AttentionViewProps { workspace: Workspace; revision:number; onOpen: (target: EntityTarget) => void; date?: string; initialKind?: AttentionKind; busy?:boolean; }
export function AttentionView({ workspace, revision, onOpen, date, initialKind, busy=false }: AttentionViewProps) {
  const prefix = useId();
  const contextExpired=useContext(SessionExpiredContext),[expired,setExpired]=useState(false),[ownerFindings,setOwnerFindings]=useState<OwnerAttentionFindings|null>(null);
  const [source,setSource]=useState<AttentionSource|null>(null);const [loading,setLoading]=useState(true);const [error,setError]=useState('');const generation=useRef(0);const currentRevision=useRef(revision),active=useRef<AbortController|null>(null);
  useEffect(()=>{currentRevision.current=revision;},[revision]);
  async function refresh(){
   if(busy||expired||contextExpired)return;active.current?.abort();const controller=new AbortController();active.current=controller;const epoch=++generation.current,expected=currentRevision.current;setSource(null);setOwnerFindings(null);setError('');setLoading(true);
   const timer=setTimeout(()=>controller.abort(),15000);
   const scopedFetch=(input:RequestInfo|URL,init?:RequestInit)=>fetch(input,{...init,signal:AbortSignal.any([controller.signal,...(init?.signal?[init.signal]:[])])});
   try{
    const [loaded,findings]=await Promise.all([
     boundedRequest('/api/workspace/planning',{credentials:'same-origin',cache:'no-store'},readSource,{deadlineMs:15000,fetch:scopedFetch}),
     loadOwnerAttentionFindings(workspace,expected,path=>boundedRequest(path,{credentials:'same-origin',cache:'no-store'},readOwnerJson,{deadlineMs:15000,fetch:scopedFetch}))
    ]);
    if(epoch!==generation.current||controller.signal.aborted)return;if(loaded.revision!==currentRevision.current||expected!==currentRevision.current)throw new Error('Attention is stale. Refresh the workspace and then refresh attention.');setSource(loaded);setOwnerFindings(findings);
   }catch(cause){if(epoch!==generation.current)return;if(cause instanceof SessionExpiredError)window.dispatchEvent(new Event('control-room-session-expired'));else setError('Owner attention could not be loaded completely within its limits. Refresh the workspace and try again; no partial evidence, source or job findings are shown.');}
   finally{clearTimeout(timer);if(epoch===generation.current)setLoading(false);}
  }
  const initialLoad=useEffectEvent(()=>{void refresh();});const invalidate=useEffectEvent(()=>{generation.current++;active.current?.abort();});
  useEffect(()=>{if(busy||contextExpired||expired)return;let mounted=true;void Promise.resolve().then(()=>{if(mounted)initialLoad();});return()=>{mounted=false;invalidate();};},[revision,busy,contextExpired,expired]);
  useEffect(()=>{const clear=()=>{generation.current++;active.current?.abort();setSource(null);setOwnerFindings(null);setError('');setExpired(true);};window.addEventListener('control-room-session-expired',clear);return()=>window.removeEventListener('control-room-session-expired',clear);},[]);
  const sourceReady=!loading&&source?.revision===revision;

  const [kind, setKind] = useState<AttentionKind | ''>(initialKind ?? '');
  const [projectId, setProjectId] = useState('');
  const [page, setPage] = useState(1);
  const asOf = cairoDate(date);
  const items = buildAttention(workspace, { date: asOf, week: currentWeek(asOf),...(sourceReady?{weeklyPlans:source.weeklyPlans,findings:ownerFindings?.revision===revision?ownerFindings.findings:[]}:{}) }).filter(item=>sourceReady||item.kind!=='carry-forward');
  const options = { ...(kind ? { kind } : {}), ...(projectId ? { projectId } : {}), page };
  let result = attentionPage(items, options);
  if (page > Math.max(1, result.pages)) result = attentionPage(items, { ...options, page: Math.max(1, result.pages) });
  const allCount = attentionPage(items, { ...(projectId ? { projectId } : {}) }).total;
  const open = (event: MouseEvent<HTMLAnchorElement>, entityType: string, id: string,itemKind:AttentionKind) => {
    if(itemKind==='carry-forward'&&kind)return;
    if (!['project', 'task', 'milestone', 'capture'].includes(entityType)) return;
    if(event.currentTarget.getAttribute('href')!==entityHref({kind:entityType as EntityTarget['kind'],id}))return;
    if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); onOpen({ kind: entityType as EntityTarget['kind'], id }); }
  };
  if(contextExpired||expired)return null;
  return <>
    <header className="page-heading"><div><p className="eyebrow">MAKE SPACE FOR A DECISION</p><h1>Needs your attention</h1><p>Planning findings as of {dateLabel(asOf, true)}, Cairo. Owner evidence, source, schedule and job reads are dated metadata, not current provider or attachment verification. Viewing a record leaves its state unchanged.</p></div><button type="button" className="button secondary" disabled={loading||busy} onClick={()=>void refresh()}>{loading?'Loading attention…':'Refresh attention'}</button></header>
    {!sourceReady&&<p className="capture-preview" role="status">{loading?'Loading canonical weekly commitments.':'Weekly attention is unavailable or stale; refresh before reviewing earlier commitments.'} Earlier-commitment findings are hidden until the planning source matches workspace revision {revision}. Other planning findings remain visible.</p>}{error&&<p className="form-error" role="alert">{error}</p>}
    {sourceReady&&ownerFindings&&<p className="field-hint">Owner reads: evidence {ownerFindings.readAt.evidence} · sources {ownerFindings.readAt.sources} · schedules {ownerFindings.readAt.schedules} · jobs {ownerFindings.readAt.jobs}. Unknown observation times remain unknown.</p>}
    <section className="panel" aria-label="Attention filters" style={{ padding: 20 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16 }}>
        <div className="field"><label htmlFor={`${prefix}-category`}>Attention category</label><select id={`${prefix}-category`} value={kind} onChange={event => { setKind(event.target.value as typeof kind); setPage(1); }}><option value="">All records ({allCount})</option>{(Object.keys(labels) as AttentionKind[]).map(value => <option key={value} value={value}>{labels[value]} ({result.counts[value]})</option>)}</select></div>
        <div className="field"><label htmlFor={`${prefix}-project`}>Project</label><select id={`${prefix}-project`} value={projectId} onChange={event => { setProjectId(event.target.value); setPage(1); }}><option value="">All projects</option>{workspace.projects.map(project => <option key={project.id} value={project.id}>{project.name}{project.archivedAt ? ' (archived)' : ''}</option>)}</select></div>
      </div>
      <p className="panel-intro" style={{ marginBottom: 0 }}>All records combines findings for the same record, keeping every reason and every source-week review link. Category counts include each matching finding. Owner metadata findings do not establish a live provider connection, verify attachment bytes, accept work or authorize execution.</p>
    </section>
    <section aria-labelledby={`${prefix}-results`} style={{ marginTop: 24 }}>
      <div className="section-heading"><h2 id={`${prefix}-results`}>{kind ? labels[kind] : 'All records'} <span className="count">{result.total}</span></h2><span className="quiet-label" role="status">{result.total ? `${(result.page - 1) * 50 + 1}–${Math.min(result.page * 50, result.total)} of ${result.total}` : '0 findings'}</span></div>
      <div className="capture-list">{result.items.length ? result.items.map(item => <article className="capture-card" key={item.key}><div className="capture-content" style={{ minWidth: 0 }}><div className="capture-tags"><span className="eyebrow">{item.entityType}</span>{item.projectId && <span>{workspace.projects.find(project => project.id === item.projectId)?.name ?? 'Project unavailable'}</span>}<span>{item.severity}</span></div><h3><a aria-label={kind&&item.sourceWeek?`Review commitment from ${item.sourceWeek}: ${item.title}`:undefined} className="capture-title" href={item.href} onClick={event => open(event, item.entityType, item.entityId,item.kind)}>{item.title}</a></h3><p className="quiet-label">{item.kinds.map(value => labels[value]).join(' · ')}</p><ul>{item.reasons.map((reason, index) => <li key={`${index}:${reason}`} style={{ overflowWrap: 'anywhere' }}>{reason}</li>)}</ul>{item.reviewLinks&&item.reviewLinks.length>0&&<nav aria-label={`Source-week reviews for ${item.title}`}><ul>{item.reviewLinks.map(link=><li key={link.href}><a className="text-button" href={link.href}>{link.label}</a></li>)}</ul></nav>}</div></article>) : <div className="panel"><EmptyState title="Nothing in this queue" text="No planning records match this category and project filter." /></div>}</div>
      <nav aria-label="Attention result pages" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 20 }}><button type="button" className="button secondary" disabled={result.page <= 1} onClick={() => setPage(result.page - 1)}>Previous page</button><span>Page {result.page} of {Math.max(1, result.pages)}</span><button type="button" className="button secondary" disabled={result.page >= result.pages} onClick={() => setPage(result.page + 1)}>Next page</button></nav>
    </section>
  </>;
}
