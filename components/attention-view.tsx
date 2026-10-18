'use client';

import { useId, useState, type MouseEvent } from 'react';
import type { Workspace } from '@/lib/types';
import type { EntityTarget } from '@/lib/entity-links';
import { buildAttention, attentionPage, type AttentionKind } from '@/lib/attention';
import { cairoDate, currentWeek } from '@/lib/calendar';
import { dateLabel, EmptyState } from './ui';

const labels: Record<AttentionKind, string> = { blocked: 'Blocked', overdue: 'Overdue tasks', review: 'Ready for review', proposal: 'Proposals', 'carry-forward': 'Earlier commitments', 'capture-inbox': 'Capture inbox', 'milestone-overdue': 'Overdue milestones', 'missing-evidence': 'Missing evidence', 'stale-source': 'Stale sources', 'failed-job': 'Failed jobs' };
export interface AttentionViewProps { workspace: Workspace; onOpen: (target: EntityTarget) => void; date?: string; initialKind?: AttentionKind; }
export function AttentionView({ workspace, onOpen, date, initialKind }: AttentionViewProps) {
  const prefix = useId();
  const [kind, setKind] = useState<AttentionKind | ''>(initialKind ?? '');
  const [projectId, setProjectId] = useState('');
  const [page, setPage] = useState(1);
  const asOf = cairoDate(date);
  const items = buildAttention(workspace, { date: asOf, week: currentWeek(asOf) });
  const options = { ...(kind ? { kind } : {}), ...(projectId ? { projectId } : {}), page };
  let result = attentionPage(items, options);
  if (page > Math.max(1, result.pages)) result = attentionPage(items, { ...options, page: Math.max(1, result.pages) });
  const allCount = attentionPage(items, { ...(projectId ? { projectId } : {}) }).total;
  const open = (event: MouseEvent<HTMLAnchorElement>, entityType: string, id: string) => {
    if (!['task', 'milestone', 'capture'].includes(entityType)) return;
    if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); onOpen({ kind: entityType as EntityTarget['kind'], id }); }
  };
  return <>
    <header className="page-heading"><div><p className="eyebrow">MAKE SPACE FOR A DECISION</p><h1>Needs your attention</h1><p>Every planning finding as of {dateLabel(asOf, true)}, Cairo. Viewing a record leaves its state unchanged.</p></div></header>
    <section className="panel" aria-label="Attention filters" style={{ padding: 20 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16 }}>
        <div className="field"><label htmlFor={`${prefix}-category`}>Attention category</label><select id={`${prefix}-category`} value={kind} onChange={event => { setKind(event.target.value as typeof kind); setPage(1); }}><option value="">All records ({allCount})</option>{(Object.keys(labels) as AttentionKind[]).map(value => <option key={value} value={value}>{labels[value]} ({result.counts[value]})</option>)}</select></div>
        <div className="field"><label htmlFor={`${prefix}-project`}>Project</label><select id={`${prefix}-project`} value={projectId} onChange={event => { setProjectId(event.target.value); setPage(1); }}><option value="">All projects</option>{workspace.projects.map(project => <option key={project.id} value={project.id}>{project.name}{project.archivedAt ? ' (archived)' : ''}</option>)}</select></div>
      </div>
      <p className="panel-intro" style={{ marginBottom: 0 }}>All records combines findings for the same record and keeps every reason. Category counts include each matching finding. Source, evidence, and job findings appear when their providers are connected.</p>
    </section>
    <section aria-labelledby={`${prefix}-results`} style={{ marginTop: 24 }}>
      <div className="section-heading"><h2 id={`${prefix}-results`}>{kind ? labels[kind] : 'All records'} <span className="count">{result.total}</span></h2><span className="quiet-label" role="status">{result.total ? `${(result.page - 1) * 50 + 1}–${Math.min(result.page * 50, result.total)} of ${result.total}` : '0 findings'}</span></div>
      <div className="capture-list">{result.items.length ? result.items.map(item => <article className="capture-card" key={`${item.entityType}:${item.entityId}`}><div className="capture-content" style={{ minWidth: 0 }}><div className="capture-tags"><span className="eyebrow">{item.entityType}</span>{item.projectId && <span>{workspace.projects.find(project => project.id === item.projectId)?.name ?? 'Project unavailable'}</span>}<span>{item.severity}</span></div><h3><a className="capture-title" href={item.href} onClick={event => open(event, item.entityType, item.entityId)}>{item.title}</a></h3><p className="quiet-label">{item.kinds.map(value => labels[value]).join(' · ')}</p><ul>{item.reasons.map((reason, index) => <li key={`${index}:${reason}`} style={{ overflowWrap: 'anywhere' }}>{reason}</li>)}</ul></div></article>) : <div className="panel"><EmptyState title="Nothing in this queue" text="No planning records match this category and project filter." /></div>}</div>
      <nav aria-label="Attention result pages" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 20 }}><button type="button" className="button secondary" disabled={result.page <= 1} onClick={() => setPage(result.page - 1)}>Previous page</button><span>Page {result.page} of {Math.max(1, result.pages)}</span><button type="button" className="button secondary" disabled={result.page >= result.pages} onClick={() => setPage(result.page + 1)}>Next page</button></nav>
    </section>
  </>;
}
