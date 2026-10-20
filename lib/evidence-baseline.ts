import { z } from 'zod';
import type { PrepareContext, MutationPlan } from './workspace-transaction.ts';
import type { Workspace } from './types.ts';
import type { EvidenceSubject, EvidenceVersion, ClaimScope } from './evidence-contract.ts';
import type { ModuleRow, RegisteredOwnerTable } from './workspace-modules.ts';
import type { JsonValue } from './workspace-protocol.ts';
import { BASELINE_ID, getProjectBaseline, baselineRecordId, type ProjectBaselineData, type BaselineSource } from './project-baselines.ts';
import { evidenceDateSchema, evidenceHeadSchema, evidenceVersionSchema, evidenceLinkSchema } from './evidence-validation.ts';
import { canonical, contentHash } from './canonical-json.ts';
import { versionRowId } from './version-identity.ts';
import { parseAuditEvent } from './audit-events.ts';
import { CommandValidationError, ModuleConflictError } from './workspace-errors.ts';
export type BaselineEvidenceAdditions = Pick<MutationPlan, 'writes' | 'preconditions' | 'events'>;
const commandSchema = z.object({ type: z.literal('baseline.apply'), projectId: z.string().min(1).max(128), baselineId: z.literal(BASELINE_ID) }).strict();
function sourceIdentity(baseline: ProjectBaselineData, source: BaselineSource): string {
  return `baseline:${baseline.id}:${baseline.key}:${source.date}:${source.basis}:${source.id}`;
}
export async function baselineEvidenceSourceId(baseline: ProjectBaselineData, source: BaselineSource): Promise<string> {
  return `baseline-source:${await contentHash(sourceIdentity(baseline, source))}`;
}
function scope(baseline: ProjectBaselineData, source: BaselineSource): ClaimScope {
  if ((baseline.key === 'tamenni' && source.id === 'software') || (baseline.key === 'trade-graph' && source.id === 'ci')) return 'software-verification';
  if ((baseline.key === 'tamenni' && source.id === 'scale') || (baseline.key === 'trade-graph' && ['economics', 'scorecard'].includes(source.id))) return 'economics';
  if (baseline.key === 'tamenni' && source.id === 'hardware') return 'physical-acceptance';
  return 'implementation';
}
/** Only bundled, explicitly applied sources become contextual evidence. This adds
 * no planning decisions, completion, acceptance, runtime execution or commitments.
 * Context links are the typed source-to-subject mappings (not legacy-note mappings). */
export async function prepareBaselineEvidence(context: PrepareContext, planningAfter: Workspace): Promise<BaselineEvidenceAdditions> {
  const command = commandSchema.parse(context.command);
  evidenceDateSchema.parse(context.now);
  const project = context.before.workspace.projects.find(row => row.id === command.projectId);
  const baseline = project && getProjectBaseline(project);
  if (!project || !baseline || baseline.id !== command.baselineId) throw new CommandValidationError('Baseline evidence package is unavailable.');
  const baselineSubjectIds = new Set([baselineRecordId(project.id, 'context'), ...baseline.actions.map(action => baselineRecordId(project.id, action.key))]);
  const previouslyApplied = context.before.workspace.tasks.some(row => baselineSubjectIds.has(row.id)) || context.before.workspace.captures.some(row => baselineSubjectIds.has(row.id)) || (context.before.baselineRemovedIds ?? []).some(id => baselineSubjectIds.has(id));
  const plan: BaselineEvidenceAdditions = { writes: [], preconditions: [], events: [] };
  const seen = new Map<string, ModuleRow>();
  async function read(table: RegisteredOwnerTable, id: string) {
    const row = await context.query.get(table, id);
    if (row) {
      if (row.id !== id || row.content_hash !== await contentHash(canonical(JSON.parse(row.payload_json)))) throw new ModuleConflictError('Baseline evidence metadata identity or digest differs.');
      const key = `${table}:${id}`;
      if (!seen.has(key)) { seen.set(key, row); plan.preconditions!.push({ table, id, expectedRowRevision: row.row_revision, expectedHash: row.content_hash }); }
    }
    return row;
  }
  function insert(table: RegisteredOwnerTable, id: string, value: unknown) {
    plan.writes.push({ table, id, operation: 'insert', value: value as JsonValue, expectedRowRevision: null });
  }
  let newHeads = 0;
  for (const source of baseline.sources) {
    const id = await baselineEvidenceSourceId(baseline, source), identity = sourceIdentity(baseline, source);
    const value: EvidenceVersion = evidenceVersionSchema.parse({ id, version: 1,
      basis: source.basis === 'observed' ? 'observed-artifact' : source.basis === 'documented' ? 'documented-result' : 'owner-statement',
      scope: scope(baseline, source), title: source.label,
      statement: [`Dated bundled context; package ${baseline.key} / ${baseline.id}; source category ${source.basis}; source date ${source.date}; package checked ${baseline.checkedAt}.`,
        `${source.repository} / ${source.path}${source.url ? '' : ' (local document label; no public URL supplied)'}`,
        source.summary,
        'Context only: this command did not rerun software, observe devices, accept a release, establish positive margin, or grant operational permission. Date-only source dates are labels; no observation timestamp is inferred.'].join('\n\n'),
      observedAt: null, recordedAt: context.now, candidate: null, environment: null,
      sourceUrl: source.url ?? null, sourceRevision: source.revision ?? null, sourceRecordId: identity,
      attachmentIds: [], supersedesVersion: null,
    });
    const physical = await versionRowId(id, 1), headRow = await read('evidence_records', id), originalRow = await read('evidence_versions', physical);
    const start = plan.writes.length;
    if (headRow) {
      const head = evidenceHeadSchema.parse(JSON.parse(headRow.payload_json));
      if (head.id !== id || !originalRow) throw new ModuleConflictError('Baseline evidence source chain is unavailable.');
      const original = evidenceVersionSchema.parse(JSON.parse(originalRow.payload_json));
      if (canonical({ ...original, recordedAt: value.recordedAt }) !== canonical(value)) throw new ModuleConflictError('Baseline source identity is occupied by different evidence.');
      const currentRow = head.currentVersion === 1 ? originalRow : await read('evidence_versions', await versionRowId(id, head.currentVersion));
      if (!currentRow) throw new ModuleConflictError('Current baseline evidence version is unavailable.');
      const current = evidenceVersionSchema.parse(JSON.parse(currentRow.payload_json));
      if (current.id !== id || current.version !== head.currentVersion) throw new ModuleConflictError('Current baseline evidence identity differs.');
      // Keep archived sources and owner corrections. An explicit owner unlink is
      // also retained; only newly created subjects receive missing mappings.
      if (head.archivedAt !== null) continue;
    } else {
      if (originalRow) throw new ModuleConflictError('Baseline evidence version exists without its head.');
      insert('evidence_records', id, evidenceHeadSchema.parse({ id, currentVersion: 1, archivedAt: null }));
      insert('evidence_versions', physical, value); newHeads++;
    }
    const subjects: EvidenceSubject[] = [{ type: 'project', id: project.id }];
    for (const action of baseline.actions.filter(action => action.sourceIds.includes(source.id))) {
      const taskId = baselineRecordId(project.id, action.key);
      if (planningAfter.tasks.some(row => row.id === taskId)) subjects.push({ type: 'task', id: taskId });
    }
    const marker = baselineRecordId(project.id, 'context');
    if (planningAfter.captures.some(row => row.id === marker)) subjects.push({ type: 'capture', id: marker });
    for (const subject of subjects) {
      const linkId = `baseline-link:${await contentHash(canonical([id, subject]))}`;
      const expected = evidenceLinkSchema.parse({ id: linkId, evidenceId: id, evidenceVersion: 1, subject, requirementId: null, relation: 'context' });
      const linkRow = await read('evidence_links', linkId);
      if (linkRow) { if (canonical(evidenceLinkSchema.parse(JSON.parse(linkRow.payload_json))) !== canonical(expected)) throw new ModuleConflictError('Baseline evidence mapping identity differs.'); continue; }
      const oldRows = subject.type === 'task' ? context.before.workspace.tasks : subject.type === 'capture' ? context.before.workspace.captures : context.before.workspace.projects;
      if (headRow && oldRows.some(row => row.id === subject.id) && (subject.type !== 'project' || previouslyApplied)) continue;
      insert('evidence_links', linkId, expected);
    }
    const additions = plan.writes.slice(start);
    if (additions.length) plan.events.push(parseAuditEvent({ id: crypto.randomUUID(), kind: 'baseline.evidence.imported', entityType: 'evidence', entityId: id,
      changes: additions.map(write => ({ path: [write.table, write.id], before: { exists: false, value: null }, after: { exists: true, value: write.value! } })),
      origin: 'owner', actorId: context.userId, occurredAt: context.now, sourceRef: identity, undoOf: null }));
  }
  // Every head/link insertion is claimed centrally; bounded scans enforce domain
  // counts without truncating existing records or overwriting legacy content.
  for (const table of ['evidence_records', 'evidence_links'] as const) {
    let after: string | undefined, count = 0, active = 0;
    const links = new Map<string, number>();
    for (;;) {
      const rows = await context.query.list(table, { after, limit: 200 });
      for (const row of rows) {
        if ((after !== undefined && row.id <= after) || ++count > 10_000) throw new CommandValidationError('Baseline evidence scan exceeds its bounded contract.');
        after = row.id;
        if (table === 'evidence_records') { const head = evidenceHeadSchema.parse(JSON.parse(row.payload_json)); if (head.id !== row.id) throw new ModuleConflictError('Evidence head identity differs.'); if (head.archivedAt === null) active++; }
        else { const link = evidenceLinkSchema.parse(JSON.parse(row.payload_json)); const key = canonical(link.subject); links.set(key, (links.get(key) ?? 0) + 1); }
      }
      if (rows.length < 200) break;
    }
    if (table === 'evidence_records' && active + newHeads > 10_000) throw new CommandValidationError('Active evidence limit reached.');
    if (table === 'evidence_links') {
      for (const write of plan.writes.filter(write => write.table === table)) { const link = evidenceLinkSchema.parse(write.value); const key = canonical(link.subject); links.set(key, (links.get(key) ?? 0) + 1); }
      if (count + plan.writes.filter(write => write.table === table).length > 10_000 || [...links.values()].some(total => total > 200)) throw new CommandValidationError('Baseline evidence link limit reached.');
    }
  }
  if (project.archivedAt && plan.writes.length) throw new CommandValidationError('Restore this project before adding baseline evidence.');
  return plan;
}
