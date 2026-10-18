'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, RefreshCw } from 'lucide-react';
import { boundedRequest } from '@/lib/save-controller';
import { SessionExpiredError } from '@/lib/workspace-client';
import type { BackupManifest } from '@/lib/workspace-backups';
import type { WorkspaceBundle } from '@/lib/workspace-export';
import { dateLabel } from './ui';

type PublicBackup = Omit<BackupManifest, 'ownerScope'> & { pinned: boolean };
async function privateRequest<T>(url: string, decode: (response: Response) => Promise<T>): Promise<T> {
  try {
    return await boundedRequest(url, { credentials: 'same-origin', cache: 'no-store' }, async response => {
      if (!response.ok) throw new Error('This download is unavailable. Your workspace has not changed.');
      return decode(response);
    });
  } catch (error) {
    if (error instanceof SessionExpiredError) window.dispatchEvent(new Event('control-room-session-expired'));
    throw error;
  }
}
async function fetchBundle(url: string) {
  return privateRequest(url, async response => {
    const text = await response.text();
    const bundle = JSON.parse(text) as WorkspaceBundle;
    if (bundle.format !== 'control-room' || bundle.bundleVersion !== 1 || !Number.isSafeInteger(bundle.source?.workspaceRevision) || !bundle.modules || !Array.isArray(bundle.attachments) || !['complete', 'metadata-only'].includes(bundle.completeness)) throw new Error('The export response was incomplete. Try again.');
    return { text, bundle, bytes: new TextEncoder().encode(text).byteLength };
  });
}
function download(text: string, filename: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url; link.download = filename; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function completeness(bundle: WorkspaceBundle) {
  return bundle.completeness === 'complete' ? 'All declared bundle content is included.' : 'Metadata only; attachment files are not included.';
}
export function CompleteBundleExport({ disabled = false }: { disabled?: boolean }) {
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState('');
  const generation = useRef(0);
  useEffect(() => { const epoch = ++generation.current; return () => { generation.current = epoch + 1; }; }, []);
  const exportBundle = async () => {
    const epoch = generation.current;
    setWorking(true); setMessage('');
    try {
      const result = await fetchBundle('/api/workspace/export');
      if (generation.current !== epoch) return;
      download(result.text, `control-room-bundle-${new Date().toISOString().slice(0, 10)}-r${result.bundle.source.workspaceRevision}.json`);
      setMessage(`Downloaded ${result.bytes.toLocaleString()} bytes from revision ${result.bundle.source.workspaceRevision}. ${completeness(result.bundle)}`);
    } catch (error) { if (generation.current === epoch) setMessage(error instanceof Error ? error.message : 'Export could not be downloaded.'); }
    finally { if (generation.current === epoch) setWorking(false); }
  };
  return <div><button className="button primary" disabled={disabled || working} onClick={() => void exportBundle()}><ArrowDownToLine size={15} />{working ? 'Preparing bundle…' : 'Export complete bundle'}</button>{message && <p className="field-hint" role="status">{message}</p>}</div>;
}

export function BackupHistory({ busy, onBackup }: { busy: boolean; onBackup?: () => Promise<void> }) {
  const [backups, setBackups] = useState<PublicBackup[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [working, setWorking] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const generation = useRef(0);
  const load = useCallback(async (epoch: number) => {
    const result = await privateRequest('/api/workspace/backups', async response => {
      const value = await response.json() as { backups: PublicBackup[] };
      if (!Array.isArray(value.backups) || value.backups.length > 10) throw new Error('Recovery history could not be read.');
      return value.backups;
    });
    if (generation.current === epoch) { setBackups(result); setLoaded(true); }
  }, []);
  useEffect(() => {
    const epoch = ++generation.current;
    void load(epoch).catch(() => { if (generation.current === epoch) setError('Recovery history could not be loaded. Refresh to try again.'); });
    return () => { generation.current = epoch + 1; };
  }, [load]);
  const refresh = async () => {
    const epoch = generation.current;
    setWorking('refresh'); setError('');
    try { await load(epoch); }
    catch { if (generation.current === epoch) setError('Recovery history could not be loaded. Refresh to try again.'); }
    finally { if (generation.current === epoch) setWorking(''); }
  };
  const create = async () => {
    if (!onBackup) return;
    const epoch = generation.current;
    setWorking('create'); setError(''); setMessage('');
    try {
      await onBackup();
      if (generation.current !== epoch) return;
      setMessage('Recovery snapshot created.');
      await load(epoch);
    } catch (cause) { if (generation.current === epoch) setError(cause instanceof Error ? cause.message : 'Recovery snapshot could not be confirmed.'); }
    finally { if (generation.current === epoch) setWorking(''); }
  };
  const downloadBackup = async (backup: PublicBackup) => {
    const epoch = generation.current;
    setWorking(backup.id); setError(''); setMessage('');
    try {
      const result = await fetchBundle(`/api/workspace/backups/${encodeURIComponent(backup.id)}`);
      if (generation.current !== epoch) return;
      download(result.text, `control-room-recovery-${backup.id}-r${result.bundle.source.workspaceRevision}.json`);
      setMessage(`Verified recovery bundle downloaded: ${result.bytes.toLocaleString()} bytes. ${completeness(result.bundle)}`);
    } catch (cause) { if (generation.current === epoch) setError(cause instanceof Error ? cause.message : 'The recovery bundle could not be verified.'); }
    finally { if (generation.current === epoch) setWorking(''); }
  };
  const disabled = busy || !!working;
  return <section className="panel data-panel" aria-labelledby="backup-history-heading"><div className="section-heading"><div><h2 id="backup-history-heading">Recovery snapshots</h2><p>Download verified bundles of saved planning and available module records. Complete bundle restoration is not available here.</p></div></div>
    <div className="data-actions">{onBackup && <button className="button primary" disabled={disabled} onClick={() => void create()}>{working === 'create' ? 'Creating snapshot…' : 'Create recovery snapshot'}</button>}<button className="button secondary" disabled={disabled} onClick={() => void refresh()}><RefreshCw size={15} />Refresh recovery history</button></div>
    {loaded && <p className="data-metadata">{backups.length}/10 snapshots · {backups.reduce((total, item) => total + item.bytes, 0).toLocaleString()} bytes in listed snapshots</p>}
    {loaded && backups.length === 0 && <p>No recovery snapshots have been saved.</p>}
    {backups.map(backup => <article className="capture-preview" key={backup.id}><h3>{dateLabel(backup.createdAt, true)}</h3><p>Source revision {backup.sourceRevision} · {backup.reason} · {backup.pinned ? 'Pinned' : 'Not pinned'} · {backup.status}</p><p>{backup.bytes.toLocaleString()} bytes · Modules: {backup.completeModules.join(', ') || 'None recorded'}</p><p>{backup.missingAttachments.length ? `${backup.missingAttachments.length} attachment files are missing.` : 'No missing attachment files recorded.'}</p><button className="button secondary" disabled={disabled || backup.status !== 'ready'} onClick={() => void downloadBackup(backup)}><ArrowDownToLine size={15} />{working === backup.id ? 'Verifying download…' : 'Download verified bundle'}</button></article>)}
    {error && <p className="form-error" role="alert">{error}</p>}{message && <p className="restore-message" role="status">{message}</p>}
  </section>;
}
