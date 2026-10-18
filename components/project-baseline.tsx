'use client';

import { useId } from 'react';
import { BookOpen, CheckCircle2, Plus } from 'lucide-react';
import { entityHref } from '@/lib/entity-links';
import type { Project, Workspace } from '@/lib/types';
import { baselineApplicationState, getProjectBaseline, previewProjectBaseline, type BaselineId, type EvidenceBasis } from '@/lib/project-baselines';

export interface ProjectBaselineProps {
  project: Project;
  workspace: Workspace;
  busy: boolean;
  removedIds?:readonly string[];
  onApply?: (project: Project, baselineId: BaselineId) => void;
}

const basisLabels: Record<EvidenceBasis, string> = {
  observed: 'Observed source',
  documented: 'Documented result',
  'owner-decision': 'Recorded owner decision',
};

export function ProjectBaseline({ project, workspace, busy, onApply, removedIds=[] }: ProjectBaselineProps) {
  const headingId = useId();
  const baseline = getProjectBaseline(project);
  if (!baseline) return null;
  const state = baselineApplicationState(workspace, project.id, removedIds);
  const proposals = previewProjectBaseline(workspace, project.id, removedIds);
  const applied = state.status === 'applied';
  const available = state.status === 'available';
  const additions = state.missingCount;
  return <section className="baseline-panel panel" aria-labelledby={headingId}>
    <div className="baseline-heading">
      <div><p className="eyebrow">DATED PROJECT BASELINE</p><h2 id={headingId}>Where the evidence stands</h2></div>
      <span className={`baseline-status ${state.status}`}>{applied ? <><CheckCircle2 size={14} />Saved to this workspace</> : '17 Oct 2026'}</span>
    </div>
    <p className="baseline-summary">{baseline.status}</p>
    <p className="baseline-meta">Sources checked <time dateTime={baseline.checkedAt}>17 Oct 2026, 16:20 UTC</time> · Dated snapshot · Equal project priority</p>
    <div className="baseline-grid">
      <section className="baseline-section"><h3>Evidence already recorded</h3><ul className="baseline-list">{baseline.accomplishments.map(item => <li key={item}>{item}</li>)}</ul></section>
      <section className="baseline-section"><h3>Blockers and unknowns</h3><ul className="baseline-list">{baseline.blockers.map(item => <li key={item}>{item}</li>)}</ul></section>
    </div>
    <details className="baseline-sources">
      <summary><BookOpen size={15} />Source details and freshness <span className="count">{baseline.sources.length}</span></summary>
      <p className="baseline-help">Observed means read on the check date. Documented results are prior reports, not tests rerun here. Recorded owner decisions supply context, not new approval. Local paths below are relative to the named repository.</p>
      <p className="baseline-meta">{baseline.provenance}</p>
      {baseline.sources.map(source => <article className="baseline-source" key={source.id}>
        <div><span className={`baseline-kind ${source.basis}`}>{basisLabels[source.basis]}</span><time dateTime={source.date}>{source.date}</time>{source.revision && <code title={source.revision}>{source.revision.slice(0, 7)}</code>}</div>
        <h4>{source.label}</h4>
        <p>{source.summary}</p>
        {source.url ? <a href={source.url} target="_blank" rel="noreferrer">{source.repository} / {source.path}</a> : <span className="baseline-meta">Local document · {source.repository} / {source.path}</span>}
      </article>)}
    </details>
    <details className="baseline-section baseline-task-preview" open>
      <summary>Five specific next-step proposals</summary>
      <p className="baseline-help">These suggestions add detail to the existing plan. Review and edit them before accepting work; they carry no deadline or weekly commitment.</p>
      <ol className="baseline-proposals">{proposals.map(proposal => <li key={proposal.key}>
        <strong>{proposal.title}</strong>
        <span className="baseline-milestone">{proposal.milestoneNote}{proposal.removed ? ' · Previously applied; task removed. Owner deletion tombstone prevents recreation.' : proposal.exists ? ' · Record already saved; your edits are preserved.' : ''}</span>
        {proposal.exists && <p><a href={entityHref({kind:'task',id:proposal.id})}>Open saved task{proposal.currentProjectId!==project.id ? ` in ${workspace.projects.find(row=>row.id===proposal.currentProjectId)?.name??'its current project'}` : ''}</a></p>}
        <details><summary>Acceptance and existing work</summary><p className="baseline-meta">{proposal.existingWork}</p><p>{proposal.acceptance}</p></details>
      </li>)}</ol>
    </details>
    <div className="baseline-actions">
      <button className="button primary" disabled={busy || !available || !onApply} onClick={() => onApply?.(project, baseline.id)}>
        {applied ? <CheckCircle2 size={15} /> : <Plus size={15} />}
        {applied ? 'Baseline saved' : available ? `Add ${additions} proposed task${additions === 1 ? '' : 's'}${state.markerId&&removedIds.includes(state.markerId)?'':' + dated context'}` : 'Baseline needs review'}
      </button>
      <p className="baseline-help" role={state.status === 'conflict' || state.status === 'incomplete' ? 'status' : undefined}>{state.message}</p>
    </div>
  </section>;
}

