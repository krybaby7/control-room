'use client';

import { useEffect, useRef, useState } from 'react';
import type { WorkspaceUsage } from '@/lib/workspace-usage';
import type { BackupPolicy } from '@/lib/backup-jobs';
import { boundedRequest } from '@/lib/save-controller';
import { SessionExpiredError } from '@/lib/workspace-client';
import { dateLabel } from './ui';

interface BackupPolicyStatus { policy: BackupPolicy; status: 'unavailable'; requirements: string[]; persisted: false }
async function read<T>(url: string): Promise<T> {
  try {
    return await boundedRequest(url, { credentials: 'same-origin', cache: 'no-store' }, async response => {
      if (!response.ok) throw new Error('This storage report is unavailable. Your saved records have not changed.');
      return await response.json() as T;
    });
  } catch (error) {
    if (error instanceof SessionExpiredError) window.dispatchEvent(new Event('control-room-session-expired'));
    throw error;
  }
}
const bytes = (value: number) => `${value.toLocaleString()} bytes`;
const count = (value: number) => value.toLocaleString();
const days = (value: number) => value % 86_400_000 === 0 ? `${value / 86_400_000} days` : `${value / 3_600_000} hours`;
const name = (value: string) => value.replace(/_/g, ' ').replace(/^./, first => first.toUpperCase());

export function WorkspaceUsagePanel({ busy = false }: { busy?: boolean }) {
  const [usage, setUsage] = useState<WorkspaceUsage | null>(null);
  const [policy, setPolicy] = useState<BackupPolicyStatus | null>(null);
  const [working, setWorking] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const generation = useRef(0);
  useEffect(() => { const epoch = ++generation.current; return () => { generation.current = epoch + 1; }; }, []);
  const load = async () => {
    if (working || busy) return;
    const epoch = generation.current;
    setWorking(true); setErrors([]);
    const results = await Promise.allSettled([
      read<WorkspaceUsage>('/api/workspace/usage'),
      read<BackupPolicyStatus>('/api/workspace/backup-policy'),
    ]);
    if (generation.current !== epoch) return;
    const failures: string[] = [];
    if (results[0].status === 'fulfilled') setUsage(results[0].value);
    else failures.push('Storage usage could not be loaded. Refresh to try again.');
    if (results[1].status === 'fulfilled') setPolicy(results[1].value);
    else failures.push('Backup policy status could not be loaded. No schedule has been enabled.');
    setErrors(failures); setWorking(false);
  };
  const warnings: string[] = [];
  if (usage) {
    if (usage.drafts.activeCount >= usage.drafts.limits.activeCount * 0.8) warnings.push(`Server drafts use ${count(usage.drafts.activeCount)} of ${count(usage.drafts.limits.activeCount)} active slots.`);
    if (usage.imports.activeCount >= usage.imports.limits.activeCount * 0.8) warnings.push(`Staged imports use ${count(usage.imports.activeCount)} of ${count(usage.imports.limits.activeCount)} active slots.`);
    if (usage.imports.bytes >= usage.imports.limits.rawBytes * 0.8) warnings.push('Staged import content is close to its byte limit. Review and explicitly discard files you no longer need.');
    if (usage.backups.count >= usage.backups.limits.count * 0.8 || usage.backups.bytes >= usage.backups.limits.bytes * 0.8) warnings.push('Recovery snapshots are close to their count or byte limit. Existing snapshots are retained; use the removal review only after retaining a newer verified recovery point.');
  }
  return <section className="panel data-panel" aria-labelledby="workspace-usage-heading"><h2 id="workspace-usage-heading">Storage usage and backup policy</h2><p>Load a read-only report of server records and logical stored bytes. Viewing or refreshing this report never deletes, compacts or retires records. Browser device copies are reported separately in device settings.</p><button type="button" className="button secondary" disabled={busy || working} onClick={() => void load()}>{working ? 'Loading storage report…' : usage || policy ? 'Refresh usage and backup policy' : 'Load usage and backup policy'}</button>
    {usage && <><p className="data-metadata">Measured {dateLabel(usage.generatedAt, true)}. Counts may change while other work is saved.</p><p className="field-hint">{usage.byteAccounting}. These figures are not physical database allocation or a hosting storage bill.</p>
      <div style={{ overflowX: 'auto' }}><table><thead><tr><th scope="col">Records</th><th scope="col">Count</th><th scope="col">Logical bytes</th><th scope="col">Limits and state</th></tr></thead><tbody>
        <tr><th scope="row">Planning documents</th><td>{count(usage.planning.count)}</td><td>{bytes(usage.planning.bytes)}</td><td>Planning content and serialized limits are shown above.</td></tr>
        <tr><th scope="row">Mutation receipts</th><td>{count(usage.receipts.count)} / {count(usage.receipts.limits.hard)}</td><td>{bytes(usage.receipts.bytes)}</td><td>{count(usage.receipts.legacyCount)} legacy · {count(usage.receipts.epochCount)} epoch-based · {count(usage.receipts.recentCount)} recent · {count(usage.receipts.olderCount)} older</td></tr>
        <tr><th scope="row">Submission epochs</th><td>{count(usage.epochs.count)}</td><td>{bytes(usage.epochs.bytes)}</td><td>{count(usage.epochs.activeCount)} active · {count(usage.epochs.retiredCount)} retired</td></tr>
        <tr><th scope="row">Server drafts</th><td>{count(usage.drafts.count)}</td><td>{bytes(usage.drafts.bytes)}</td><td>{count(usage.drafts.activeCount)}/{count(usage.drafts.limits.activeCount)} active · {count(usage.drafts.expiredCount)} expired · {bytes(usage.drafts.limits.perDraftBytes)} per draft · Retention {days(usage.drafts.limits.retentionMs)}</td></tr>
        <tr><th scope="row">Staged imports</th><td>{count(usage.imports.count)}</td><td>{bytes(usage.imports.storedBytes)} stored encoding and metadata</td><td>{count(usage.imports.activeCount)}/{count(usage.imports.limits.activeCount)} active · {count(usage.imports.expiredCount)} expired · {bytes(usage.imports.bytes)}/{bytes(usage.imports.limits.rawBytes)} raw content · {bytes(usage.imports.limits.perStageBytes)} per file · Retention {days(usage.imports.limits.retentionMs)}</td></tr>
        <tr><th scope="row">Recovery snapshots</th><td>{count(usage.backups.count)}/{count(usage.backups.limits.count)}</td><td>{bytes(usage.backups.bytes)}/{bytes(usage.backups.limits.bytes)}</td><td>{count(usage.backups.readyCount)} ready · {count(usage.backups.pinnedCount)} pinned · {bytes(usage.backups.limits.perBundleBytes)} per database-backed bundle</td></tr>
        {usage.modules.map(module => <tr key={module.module}><th scope="row">{name(module.module)}</th><td>{count(module.count)}</td><td>{bytes(module.bytes)}</td><td>Separate from planning content</td></tr>)}
        <tr><th scope="row">Audit history</th><td>{count(usage.audit.count)}</td><td>{bytes(usage.audit.bytes)}</td><td>Retained history, separate from recent activity</td></tr>
      </tbody></table></div>
      <p>Drafts: {bytes(usage.drafts.activeBytes)} active and {bytes(usage.drafts.expiredBytes)} expired. Staged raw imports: {bytes(usage.imports.activeBytes)} active and {bytes(usage.imports.expiredBytes)} expired.</p>
      <h3>Retry safety and retention</h3>{usage.receipts.count >= usage.receipts.limits.soft && <p role="status">Receipt storage is approaching its hard limit. Existing records remain retained; export and arrange guarded maintenance or additional storage.</p>}<p>The {usage.receiptPolicy.recentRetryHorizonDays}-day receipt window is for reporting only, beginning {dateLabel(usage.receipts.recentSince, true)}. Older receipts remain authoritative. Legacy receipts are retained indefinitely; retired epoch markers are permanent. Age does not allow a new execution or make an uncertain save safe to replace.</p><p>No automatic receipt pruning or epoch retirement is enabled. Retired receipt detail can only be compacted internally after retirement and checks for unexpired server-draft references; retired device retries remain rejected.</p>
      {warnings.length > 0 && <div role="status"><h3>Capacity to review</h3><ul>{warnings.map(warning => <li key={warning}>{warning}</li>)}</ul></div>}
    </>}
    <div className="restore-section"><h3>Scheduled backups</h3>{policy ? <><p><strong>Unavailable. No active schedule.</strong></p><p>Disabled policy plan: daily at {policy.policy.dailyLocalTime} {policy.policy.timezone}, retaining {policy.policy.retentionDaily} daily and {policy.policy.retentionWeekly} weekly recovery points. Weekly selection: {policy.policy.weeklyDay}.</p><p>This policy is not persisted or enabled. No next run or successful scheduled backup is reported.</p><h4>Required before activation</h4><ul>{policy.requirements.map(requirement => <li key={requirement}>{requirement}</li>)}</ul><p>Saving a policy or passing a code test does not establish that a closed-browser scheduled backup has run.</p></> : <p>Load the backup policy status to see its disabled plan and activation requirements.</p>}</div>
    {errors.map(error => <p className="form-error" role="alert" key={error}>{error}</p>)}
  </section>;
}
