'use client';

import { useId, useState, type MouseEvent } from 'react';
import type { Workspace } from '@/lib/types';
import type { EntityTarget } from '@/lib/entity-links';
import { searchPlanning, type PlanningSearchOptions } from '@/lib/planning-search';
import { dateLabel, EmptyState } from './ui';

export interface SearchViewProps {
  workspace: Workspace;
  onOpen: (target: EntityTarget) => void;
  initialQuery?: string;
}
const entityLabels: Record<EntityTarget['kind'], string> = { project: 'Project', milestone: 'Milestone', task: 'Task', capture: 'Capture' };
const statuses = ['proposed', 'todo', 'doing', 'review', 'done', 'planned', 'active', 'achieved', 'inbox', 'filed', 'archived'];
export function SearchView({ workspace, onOpen, initialQuery = '' }: SearchViewProps) {
  const prefix = useId();
  const [query, setQuery] = useState(initialQuery);
  const [entity, setEntity] = useState<EntityTarget['kind'] | ''>('');
  const [project, setProject] = useState('');
  const [status, setStatus] = useState('');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [page, setPage] = useState(1);
  const options: PlanningSearchOptions = { query, includeArchived, page, ...(entity ? { entityTypes: [entity] } : {}), ...(project ? { projectIds: [project] } : {}), ...(status ? { statuses: [status] } : {}) };
  let result: ReturnType<typeof searchPlanning> | null = null;
  let error = '';
  try {
    result = searchPlanning(workspace, options);
    if (page > Math.max(1, result.pages)) result = searchPlanning(workspace, { ...options, page: Math.max(1, result.pages) });
  } catch (caught) { error = caught instanceof Error ? caught.message : 'Search could not be prepared.'; }
  const change = (update: () => void) => { update(); setPage(1); };
  const open = (event: MouseEvent<HTMLAnchorElement>, target: EntityTarget) => {
    if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); onOpen(target); }
  };
  return <>
    <header className="page-heading"><div><p className="eyebrow">FIND THE THREAD</p><h1>Search your workspace</h1><p>Find projects, milestones, tasks, and captures by their saved content.</p></div></header>
    <section className="panel" aria-label="Workspace search filters" style={{ padding: 20 }}>
      <div className="field"><label htmlFor={`${prefix}-query`}>Search text</label><input id={`${prefix}-query`} type="search" value={query} maxLength={200} onChange={event => change(() => setQuery(event.target.value))} aria-describedby={`${prefix}-query-hint${error ? ` ${prefix}-error` : ''}`} aria-invalid={Boolean(error)} placeholder="Search titles, notes, evidence, or source links" /><small id={`${prefix}-query-hint`}>Up to 200 characters and 20 words. Every word must match the same record.</small></div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 16, marginTop: 16 }}>
        <div className="field"><label htmlFor={`${prefix}-entity`}>Record type</label><select id={`${prefix}-entity`} value={entity} onChange={event => change(() => setEntity(event.target.value as typeof entity))}><option value="">All record types</option>{Object.entries(entityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
        <div className="field"><label htmlFor={`${prefix}-project`}>Project</label><select id={`${prefix}-project`} value={project} onChange={event => change(() => setProject(event.target.value))}><option value="">All projects</option>{workspace.projects.map(row => <option key={row.id} value={row.id}>{row.name}{row.archivedAt ? ' (archived)' : ''}</option>)}</select></div>
        <div className="field"><label htmlFor={`${prefix}-status`}>Saved status</label><select id={`${prefix}-status`} value={status} onChange={event => change(() => setStatus(event.target.value))}><option value="">All statuses</option>{statuses.map(value => <option key={value} value={value}>{value}</option>)}</select></div>
      </div>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 16, minHeight: 44 }}><input type="checkbox" checked={includeArchived} onChange={event => change(() => setIncludeArchived(event.target.checked))} />Include archived records and work in archived projects or milestones</label>
      {error && <p className="form-error" role="alert" id={`${prefix}-error`}>{error}</p>}
    </section>
    {result && <section aria-labelledby={`${prefix}-results`} style={{ marginTop: 24 }}>
      <div className="section-heading"><h2 id={`${prefix}-results`}>Search results <span className="count">{result.total}</span></h2><span role="status" className="quiet-label">{result.total ? `${(result.page - 1) * 50 + 1}–${Math.min(result.page * 50, result.total)} of ${result.total}` : '0 matches'}</span></div>
      <div className="capture-list">{result.items.length ? result.items.map(item => <article className="capture-card" key={`${item.type}:${item.id}`}><div className="capture-content" style={{ minWidth: 0 }}><div className="capture-tags"><span className="eyebrow">{entityLabels[item.type]}</span>{item.project && <span>{item.project}</span>}{item.archived && <span>Archived</span>}{item.status && <span>{item.status}</span>}</div><h3><a className="capture-title" href={item.href} onClick={event => open(event, { kind: item.type, id: item.id })}>{item.title}</a></h3><p className="capture-body" style={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{item.snippet}</p><p className="quiet-label">{item.timestampUnknown ? 'Saved timestamp unknown' : `Updated or created ${dateLabel(item.timestamp, true)}`}</p></div></article>) : <div className="panel"><EmptyState title="No matching records" text="Try fewer words, another filter, or include archived work." /></div>}</div>
      <nav aria-label="Search result pages" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 20 }}><button type="button" className="button secondary" disabled={result.page <= 1} onClick={() => setPage(result!.page - 1)}>Previous page</button><span>Page {result.page} of {Math.max(1, result.pages)}</span><button type="button" className="button secondary" disabled={result.page >= result.pages} onClick={() => setPage(result!.page + 1)}>Next page</button></nav>
    </section>}
  </>;
}
