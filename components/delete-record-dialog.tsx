'use client';

import { useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import type { Command, Workspace } from '@/lib/types';
import type { DeletableEntity, EntityDeletionPreview } from '@/lib/workspace-deletion';
import { boundedRequest } from '@/lib/save-controller';
import { SessionExpiredError } from '@/lib/workspace-client';
import { SessionExpiredContext } from './session-state';

async function fetchPreview(entityType: DeletableEntity, id: string): Promise<EntityDeletionPreview> {
  try {
    return await boundedRequest(`/api/workspace/deletion-preview?entityType=${entityType}&id=${encodeURIComponent(id)}`, { credentials: 'same-origin', cache: 'no-store' }, async response => {
      if (!response.ok) throw new Error('The removal preview is unavailable. Your record has not changed.');
      const result = await response.json() as EntityDeletionPreview;
      if (result.entityType !== entityType || result.id !== id || !result.record || !Array.isArray(result.blockers) || !Array.isArray(result.references) || !Number.isSafeInteger(result.targetRevision) || typeof result.previewHash !== 'string') throw new Error('The removal preview was incomplete. Refresh it before continuing.');
      return result;
    });
  } catch (error) {
    if (error instanceof SessionExpiredError) window.dispatchEvent(new Event('control-room-session-expired'));
    throw error;
  }
}
export function DeleteRecordDialog({ entityType, id, revision, busy, onDelete, onClose, onRemoved }: {
  entityType: DeletableEntity; id: string; revision: number; busy: boolean;
  onDelete?: (command: Command) => Promise<void>; onClose: () => void; onRemoved: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const generation = useRef(0);
  const titleId = useId();
  const expired = useContext(SessionExpiredContext);
  const [preview, setPreview] = useState<EntityDeletionPreview | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [working, setWorking] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(async (epoch: number) => {
    try {
      const result = await fetchPreview(entityType, id);
      if (generation.current === epoch) setPreview(result);
    } catch (cause) { if (generation.current === epoch) setError(cause instanceof Error ? cause.message : 'The removal preview could not be loaded.'); }
  }, [entityType, id]);
  useEffect(() => {
    const epoch = ++generation.current;
    void load(epoch);
    return () => { generation.current = epoch + 1; };
  }, [load]);
  useEffect(() => {
    const element = dialog.current;
    if (!expired) element?.showModal();
    return () => element?.close();
  }, [expired]);
  const disabled = busy || !!working;
  const stale = !!preview && preview.targetRevision !== revision;
  const canApply = !!onDelete && !!preview && preview.canDelete && preview.blockers.length === 0 && !stale && accepted && !disabled;
  const refresh = async () => {
    setAccepted(false); setPreview(null); setError(''); setWorking('preview');
    const epoch = generation.current;
    try { await load(epoch); }
    finally { if (generation.current === epoch) setWorking(''); }
  };
  const remove = async () => {
    if (!canApply || !preview || !onDelete) return;
    const epoch = generation.current;
    setWorking('delete'); setError('');
    try {
      await onDelete({ type: 'entity.delete', entityType, id, previewHash: preview.previewHash, targetRevision: preview.targetRevision });
      if (generation.current === epoch) onRemoved();
    } catch (cause) { if (generation.current === epoch) setError(cause instanceof Error ? cause.message : 'Removal could not be confirmed. Keep this review open.'); }
    finally { if (generation.current === epoch) setWorking(''); }
  };
  if (expired) return null;
  return <dialog ref={dialog} className="editor-dialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); if (!disabled) onClose(); }}><form onSubmit={event => { event.preventDefault(); void remove(); }}>
    <header className="dialog-header"><div><p className="eyebrow">REVIEW PERMANENT REMOVAL</p><h2 id={titleId}>Remove this archived {entityType}?</h2><p>Viewing this preview does not change your workspace.</p></div><button type="button" className="button secondary" onClick={onClose} disabled={disabled}>Close</button></header>
    <fieldset className="dialog-fields" disabled={disabled}>
      {!preview && !error && <p role="status">Loading removal impact…</p>}
      {preview && <><h3>{preview.record.title}</h3><p>Saved revision {preview.targetRevision} · Record {preview.id}</p><details open><summary>Full record to remove</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(preview.record, null, 2)}</pre></details>
        <h3>Exact planning impact</h3><p>Tasks: {preview.beforeCounts.tasks} → {preview.afterCounts.tasks}. Captures: {preview.beforeCounts.captures} → {preview.afterCounts.captures}.</p><p>Planning content removed: {preview.contentBytesRemoved.toLocaleString()} bytes. The recovery snapshot and retained audit history also use storage; this does not remove their records.</p>
        <h3>References ({preview.references.length})</h3>{preview.references.length ? <ul>{preview.references.map(reference => <li key={`${reference.collection}:${reference.id}:${reference.field}`}>{reference.collection}: {reference.id} ({reference.field})</li>)}</ul> : <p>No blocking planning references were found.</p>}
        {preview.blockers.length > 0 && <div role="alert"><h3>Removal is blocked</h3><ul>{preview.blockers.map((blocker, index) => <li key={index}>{blocker}</li>)}</ul></div>}
        {!preview.canDelete && preview.blockers.length === 0 && <p role="alert">This record cannot be removed in the current workspace.</p>}
        <div className="restore-preview"><h3>A recovery snapshot is required</h3><p>This permanently removes the selected archived record from planning. A verified recovery snapshot must be saved in the same operation. If snapshot storage is full or unavailable, the record is retained and this review stays open.</p></div>
        {stale && <p role="alert">Your workspace changed after this preview. Refresh and review the impact again.</p>}
        <label className="check-card"><input type="checkbox" checked={accepted} disabled={disabled || stale || !preview.canDelete || preview.blockers.length > 0} onChange={event => setAccepted(event.target.checked)} /><span>I reviewed the full record, references and recovery snapshot requirement. Permanently remove this archived {entityType}.</span></label>
      </>}
      {!onDelete && <p className="field-hint">Permanent removal is unavailable in this session.</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </fieldset><footer className="dialog-footer"><div className="dialog-actions"><button type="button" className="button secondary" disabled={disabled} onClick={onClose}>Keep record</button><button type="button" className="button secondary" disabled={disabled} onClick={() => void refresh()}>Refresh removal preview</button><button type="submit" className="button primary" disabled={!canApply}>{working === 'delete' ? 'Removing…' : 'Permanently remove reviewed record'}</button></div></footer>
  </form></dialog>;
}

export function ArchivedRecordCleanup({ workspace, revision, busy, onDelete }: { workspace: Workspace; revision: number; busy: boolean; onDelete?: (command: Command) => Promise<void> }) {
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<{ entityType: DeletableEntity; id: string } | null>(null);
  const [message, setMessage] = useState('');
  const tasks = workspace.tasks.filter(record => record.status === 'archived');
  const captures = workspace.captures.filter(record => record.status === 'archived');
  const records = [...tasks.map(record => ({ entityType: 'task' as const, record })), ...captures.map(record => ({ entityType: 'capture' as const, record }))];
  const lastPage = Math.max(0, Math.ceil(records.length / 100) - 1);
  const index = Math.min(page, lastPage);
  const visible = records.slice(index * 100, (index + 1) * 100);
  return <section className="panel data-panel" aria-labelledby="archived-cleanup-heading"><h2 id="archived-cleanup-heading">Review archived records for removal</h2><p>Archiving keeps records and does not free storage. Review one archived task or capture at a time before permanent removal. Project and milestone removal is unavailable.</p><p>{tasks.length} archived tasks · {captures.length} archived captures. Showing {records.length ? index * 100 + 1 : 0}–{Math.min((index + 1) * 100, records.length)} of {records.length} records.</p>
    {visible.map(({ entityType, record }) => <article className="capture-preview" key={`${entityType}:${record.id}`}><h3>{record.title}</h3><p>{entityType} · {record.id}</p><button type="button" className="button secondary" disabled={busy || !!selected} onClick={() => { setSelected({ entityType, id: record.id }); setMessage(''); }}>Review removal</button></article>)}
    {records.length === 0 && <p>No archived tasks or captures are available for removal. Archive a record in its editor first.</p>}
    {records.length > 100 && <div className="data-actions"><button type="button" className="button secondary" disabled={busy || index === 0} onClick={() => setPage(index - 1)}>Previous 100</button><span>Page {index + 1} of {lastPage + 1}</span><button type="button" className="button secondary" disabled={busy || index === lastPage} onClick={() => setPage(index + 1)}>Next 100</button></div>}
    {selected && <DeleteRecordDialog key={`${selected.entityType}:${selected.id}`} {...selected} revision={revision} busy={busy} onDelete={onDelete} onClose={() => setSelected(null)} onRemoved={() => { setSelected(null); setMessage('The reviewed record was removed. Its recovery snapshot is retained in recovery history.'); }} />}
    {message && <p className="restore-message" role="status">{message}</p>}
  </section>;
}
