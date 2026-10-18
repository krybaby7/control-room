'use client';

import { useRef, useState } from 'react';
import {SourceConnections} from './source-connections';
import { AlertCircle, ArrowDownToLine, Clock3, Database, ExternalLink, GitBranch, Laptop, RefreshCw, ShieldCheck, Upload } from 'lucide-react';
import type { Command, Workspace, WorkspaceEnvelope } from '@/lib/types';
import type { Submission } from '@/lib/workspace-client';
import { parseWorkspaceExport, WORKSPACE_LIMITS } from '@/lib/workspace-validation';
import { measurePlanning } from '@/lib/workspace-codec';
import { dateLabel, ProjectIcon } from './ui';
import { BackupHistory, CompleteBundleExport } from './backup-history';
import { ImportReview } from './import-review';
import { ArchivedRecordCleanup } from './delete-record-dialog';
import { DeviceDraftSettings } from './device-drafts';
import { WorkspaceUsagePanel } from './workspace-usage';

type RestoreBase = { revision: number; submission?: Submission | null };
type RestorePreview = { workspace: Workspace; filename: string; date: string | null; sourceVersion: number; base: RestoreBase };

export function SourcesView({ envelope, busy, onRefresh, onRestore, onPreviousBackup, onBackup, onImport, onDelete, onBackupRemove, onPendingChange, onDirtyChange }: { envelope: WorkspaceEnvelope; busy: boolean; onPendingChange:(pending:boolean)=>void; onDirtyChange:(dirty:boolean)=>void; onRefresh: () => void; onRestore: (workspace: Workspace, base: RestoreBase) => Promise<void>; onPreviousBackup: () => Promise<WorkspaceEnvelope>; onBackup?: () => Promise<void>; onImport?: (command: Command) => Promise<void>; onDelete?: (command: Command) => Promise<void>; onBackupRemove?: (command: Command) => Promise<void> }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState('');
  const disabled = busy || working;
  function exportWorkspace(snapshot = envelope, previous = false) {
    const data = JSON.stringify({ exportedAt: new Date().toISOString(), ...snapshot }, null, 2);
    const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `control-room-${previous ? 'before-restore-' : ''}${new Date().toISOString().slice(0, 10)}-r${snapshot.revision}.json`; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function chooseFile(file?: File) {
    if (!file) return;
    setError(''); setMessage(''); setPreview(null); setWorking(true);
    try {
      // Allow formatting overhead from our own pretty-printed export; the shared
      // validator still enforces the compact document's actual storage bound.
      if (file.size > WORKSPACE_LIMITS.bytes * 4) throw new Error('Choose a JSON export smaller than 4 MB.');
      const value = JSON.parse(await file.text());
      const workspace = parseWorkspaceExport(value);
      const date = value?.exportedAt ?? value?.updatedAt;
      setPreview({ workspace, filename: file.name, date: typeof date === 'string' && Number.isFinite(Date.parse(date)) ? date : null, sourceVersion: (value?.workspace ?? value)?.schemaVersion, base: { revision: envelope.revision } });
    } catch (cause) { setError(`${cause instanceof Error ? cause.message : 'This file could not be read.'} No workspace changes were made.`); }
    finally { setWorking(false); if (fileRef.current) fileRef.current.value = ''; }
  }
  async function restore() {
    if (!preview || disabled) return;
    setWorking(true); setError(''); setMessage('');
    try { await onRestore(preview.workspace, preview.base); setPreview(null); setMessage('Workspace restored. The previous saved workspace is retained below as a recovery export.'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Restore could not be confirmed. Your preview is retained; retrying the unchanged restore is safe.'); }
    finally { setWorking(false); }
  }
  async function downloadPrevious() {
    setWorking(true); setError('');
    try { exportWorkspace(await onPreviousBackup(), true); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The recovery export could not be loaded.'); }
    finally { setWorking(false); }
  }
  const {contentBytes,serializedBytes} = measurePlanning(envelope.workspace);
  const archived = envelope.workspace.tasks.filter(task => task.status === 'archived').length + envelope.workspace.captures.filter(capture => capture.status === 'archived').length;
  return <><header className="page-heading"><div><p className="eyebrow">KNOW WHAT YOUR PLAN IS BASED ON</p><h1>Context you can trace.</h1><p>Reference snapshots, project sources, and your saved workspace.</p></div></header>
    <section className="snapshot-banner"><span className="snapshot-icon"><Clock3 size={23} /></span><div><h2>A starting point, dated honestly.</h2><p>Initial project context comes from a manually inspected snapshot on <strong>17 October 2026</strong>. It is read-only reference material. Goals are owner-defined and task suggestions need your review.</p><span className="snapshot-tag">Manual snapshot · 17 Oct 2026</span></div></section>
    <section aria-labelledby="repositories-heading"><div className="section-heading"><h2 id="repositories-heading">Project references</h2><span className="quiet-label">Open the source for current details</span></div><div className="source-project-grid">{envelope.workspace.projects.map(project => <article className="panel source-project" key={project.id}><div className="source-project-heading"><ProjectIcon project={project} small /><h3>{project.name}</h3></div>{project.repositories.length ? project.repositories.map(repo => <a key={repo.url} className="repository-link" href={repo.url} target="_blank" rel="noreferrer"><GitBranch size={17} /><span>{repo.name}</span><ExternalLink size={14} /></a>) : <p className="muted-copy">No repository reference recorded.</p>}</article>)}</div></section>
    {onImport&&<SourceConnections envelope={envelope} busy={disabled} onCommand={onImport} onPendingChange={onPendingChange} onDirtyChange={onDirtyChange}/>}
    <section className="connections-section" aria-labelledby="device-connections-heading"><div className="section-heading"><h2 id="device-connections-heading">Device connection</h2></div><div className="panel connection-list"><div className="connection-row"><span className="connection-icon"><Laptop size={22}/></span><div><h3>PC collector</h3><p>Local runtime and agent activity require a separately installed and paired bridge.</p></div><span className="disconnected-badge">Not connected</span></div></div></section>
    <section className="panel data-panel"><div className="data-panel-copy"><Database size={23} /><div><h2>Your workspace, in your hands.</h2><p>Planning JSON contains projects, milestones, tasks, captures and recent activity. The complete bundle also includes available module records; each download reports whether attachment files are included.</p><span className="data-metadata">Saved revision {envelope.revision} · Updated {dateLabel(envelope.updatedAt, true)}</span></div></div><div className="data-actions"><button className="button secondary" onClick={onRefresh} disabled={busy}><RefreshCw size={15} className={busy ? 'spinning' : ''} />Refresh workspace</button><button className="button primary" onClick={() => exportWorkspace()}><ArrowDownToLine size={15} />Planning JSON</button><CompleteBundleExport disabled={disabled} /><a className="button secondary" href="/api/workspace/export/archive" aria-disabled={disabled} onClick={event=>{if(disabled)event.preventDefault();}}>Full file archive</a></div><p className="data-footnote"><ShieldCheck size={14} />JSON bundles contain metadata references only. Full file archives stream verified private bytes and require a complete valid ZIP; keep the downloaded original for recovery.</p>
      <p className="workspace-usage">Stored usage: {envelope.workspace.tasks.length}/{WORKSPACE_LIMITS.tasks} tasks - {envelope.workspace.captures.length}/{WORKSPACE_LIMITS.captures} captures - {envelope.workspace.milestones.length}/{WORKSPACE_LIMITS.milestones} milestones - {(contentBytes / 1000).toFixed(1)}/{WORKSPACE_LIMITS.bytes / 1000} KB content · {(serializedBytes / 1000).toFixed(1)}/{WORKSPACE_LIMITS.serializedBytes / 1000} KB serialized. Normalized module usage is reported separately when those modules are enabled. {archived} archived records are included. Archiving keeps records and history, so it does not free storage.</p>
      <div className="restore-section"><h3>Restore Planning JSON</h3><p>Choose a planning export to validate and preview it. For complete bundles, use Review an import below. Restoring replaces this workspace’s projects, milestones, tasks, captures, and activity. A recovery snapshot of the previous workspace is retained automatically.</p><input ref={fileRef} type="file" accept=".json,application/json" aria-label="Choose Planning JSON export" disabled={disabled} onChange={event => void chooseFile(event.target.files?.[0])} />
        {preview && <div className="restore-preview"><h4>Review before restoring</h4><p className="import-filename">{preview.filename}</p><p>Source schema v{preview.sourceVersion} · Import schema v{preview.workspace.schemaVersion} · {preview.date ? dateLabel(preview.date, true) : 'Export date not recorded'}</p><dl className="preview-counts"><div><dt>Projects</dt><dd>{preview.workspace.projects.length}</dd></div><div><dt>Milestones</dt><dd>{preview.workspace.milestones.length}</dd></div><div><dt>Tasks</dt><dd>{preview.workspace.tasks.length}</dd></div><div><dt>Captures</dt><dd>{preview.workspace.captures.length}</dd></div></dl><p>The restore will check saved revision {preview.base.revision}. If another session changed it, the preview stays here for your review before you retry.</p><div className="data-actions"><button className="button secondary" disabled={disabled} onClick={() => { setPreview(null); setError(''); }}>Cancel import</button><button className="button primary" disabled={disabled} onClick={() => void restore()}><Upload size={15} />{working ? 'Restoring…' : 'Restore this workspace'}</button></div></div>}
        {envelope.previousBackupAvailable && <button className="button secondary recovery-download" onClick={() => void downloadPrevious()} disabled={disabled}><ArrowDownToLine size={15} />Download workspace from before last restore</button>}
        {error && <p className="form-error" role="alert"><AlertCircle size={17} /><span>{error}</span></p>}{message && <p className="restore-message" role="status">{message}</p>}
      </div>
    </section>
    <WorkspaceUsagePanel busy={disabled} />
    <DeviceDraftSettings />
    <ImportReview revision={envelope.revision} busy={disabled} onImport={onImport} />
    <BackupHistory busy={disabled} onBackup={onBackup} targetRevision={envelope.revision} onBackupRemove={onBackupRemove} />
    <ArchivedRecordCleanup workspace={envelope.workspace} revision={envelope.revision} busy={disabled} onDelete={onDelete} />
  </>;
}
