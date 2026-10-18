# Phase 3 — Evidence, decisions and immutable history implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each planning claim traceable evidence, secure file attachments, explicit owner acceptance, a searchable decision register and an immutable history with safe undo.

**Architecture:** Keep the phase 2 planning document at schema v4 and preserve legacy inline evidence for compatibility. Store evidence, requirements, decisions, acceptance records, attachment metadata and field-level events in normalized owner-scoped D1 tables. Store attachment bytes in a private R2 bucket and expose them only through authenticated application routes; D1/R2 consistency uses staged uploads and retryable cleanup jobs, not a fictional cross-service transaction.

**Tech Stack:** Existing Sites/Vinext/React/TypeScript, Drizzle/D1, Zod, foundation transaction/export/job services, private Cloudflare R2 binding, Node 24 real-SQLite tests and local browser harness.

---

## Execution boundary and prerequisites

Execute after [01-foundation-recovery.md](01-foundation-recovery.md) and [02-planning-workflows.md](02-planning-workflows.md) acceptance gates pass. This file is a plan only; do not create buckets, write production evidence or alter task completion while preparing it. The later cloud execution must use local D1 and an isolated test R2 binding before the master release gate. [04-source-synchronization.md](04-source-synchronization.md) subsequently supplies source observations; [05-reviews-automation.md](05-reviews-automation.md) consumes these evidence and decision contracts.

The audited application has task/milestone `evidence` text, one optional source URL, decision-kind captures, a hard-coded dated baseline and up to 100 generic activity messages. Milestone achievement requires nonempty text; ordinary task completion does not require evidence. There is no structured evidence registry, file upload, field-level history screen or ordinary-edit undo. Preserve these facts during migration; a nonempty old text field does not prove that a test was run or a release accepted.

Read `lib/types.ts`, `lib/planning.ts`, `lib/project-baselines.ts`, `lib/workspace-validation.ts`, `lib/workspace-store.ts`, `components/task-editor.tsx`, `components/planning-editors.tsx`, `components/project-baseline.tsx`, `components/capture-editors.tsx`, and the foundation/phase 2 contracts before implementation.

Foundation integration contracts:

- `executeWorkspaceCommand(userId, {protocolVersion:1, expectedRevision, mutationId, command}, {db, now, handlers})` is the normal owner planning/evidence/decision/configuration mutation entrypoint. Owner comes from server authentication. These commands advance the shared revision and get idempotent receipts even when they change only side tables. Operational source observations, polling cursors, heartbeats, leases, upload transport progress and job progress use separate owner-scoped CAS streams and cannot alter planning or authorize effects.
- A handler `prepare({userId,before,command,now,query})` returns `{planningAfter,writes,events,backup?,jobs}`. Typed guarded writes include owner and row-revision predicates; the compiler turns all D1 writes, planning compare-and-swap, receipt and events into one batch.
- The foundation owns `audit_events` base schema. This phase implements detailed event generation/query/undo and the audit export adapter; do not create a competing log.
- `registerExportModule({key,schemaVersion,exportRows,parseAndMigrate,validateReferences,prepareReplace})` supports portable module schemas. Bundle version 1 is independent from planning v4. Owner-command records use one shared revision; operational stream exports are pinned to `source.moduleWatermarks` with bounded pagination. Retry a snapshot read if its owner revision changes; never infer all-module consistency from that revision alone when operational streams can advance separately.
- External R2 effects are staged or durable jobs. Never put an R2 request inside a claimed “atomic D1 transaction”.

## Decisions and limits

1. Evidence types distinguish an observed artifact, a documented historical result, an owner statement and a connector-supplied observation. These are provenance categories, not truth scores. Unknown date/candidate/environment remains explicitly unknown.
2. Statements about implementation, software verification, physical acceptance, operational behavior, release acceptance and economics are separate claim scopes. Automated software checks never certify physical reliability or profitability.
3. New evidence records have immutable versions. Corrections append a new version; previous versions and their links remain available to historic acceptance and audit records. Archive hides ordinary display without erasing provenance.
4. Owner acceptance is an explicit command with evidence-version references, candidate identity and a statement of scope. Source ingestion cannot call it. Completeness checks identify missing/stale/mismatched evidence; they do not accept work.
5. Attachments default to **20 MiB maximum per file, 200 MiB total ready/staged bytes per owner and 500 files**. These are product quotas, not a claim about Cloudflare service limits. Show exact usage, reject before accepting oversized content, and count pending uploads against quota.
6. Allow PDF, PNG, JPEG, WebP, UTF-8 text, CSV and JSON. Reject executable content, SVG/HTML and mismatched signatures. Serve downloads with `Content-Disposition: attachment` and `nosniff`; only validated raster images may have an authenticated inline preview. No public bucket URL, arbitrary remote URL download or browser-exposed storage credential.
7. History is append-only. Restore records what changed and preserves existing audit history; importing historical events appends/deduplicates them rather than replacing the target audit timeline. An old 100-event list can be imported only as historical summaries with no invented field diffs.
8. Undo is a new guarded command, never deletion/rewrite of history. It succeeds only if affected current fields still match the event's after-values and all current domain/reference invariants remain valid. Unrelated edits may remain intact.
9. A successful file upload or passing parser is not independent verification of its assertions. Acceptance text must state what the owner actually reviewed.

The private Workers R2 binding and its object APIs are documented by Cloudflare: [Workers R2 API reference](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/), [binding setup](https://developers.cloudflare.com/r2/api/workers/workers-api-usage/). Verify the actual Sites deployment path can supply this binding before marking attachments deliverable; the documentation does not establish that a binding already exists for this site.

## File map

| Files | Responsibility |
|---|---|
| Create `lib/evidence-contract.ts`, `lib/evidence-validation.ts`, `lib/evidence-store.ts`, `lib/evidence-migration.ts` | Record/version contracts, provenance validation, owner queries and honest legacy migration |
| Create `lib/evidence-requirements.ts`, `lib/acceptance.ts` | Structured criteria, completeness and explicit owner assessments |
| Create `lib/decisions.ts` | Draft/decided/superseded decision register and capture linkage |
| Create `lib/attachments.ts`, `lib/attachment-policy.ts`, `lib/attachment-jobs.ts` | Private blob storage, staged lifecycle, quotas and cleanup |
| Modify `cloudflare-env.d.ts` and the verified Sites binding configuration | Expose the actually provisioned private `BUCKET` binding through the server-only blob adapter |
| Create `app/api/attachments/[id]/content/route.ts` | Authenticated bounded upload/download; ownership checked before storage access |
| Create `app/api/evidence/route.ts`, `app/api/history/route.ts` | Owner-scoped paginated reads only; writes remain commands on the foundation route |
| Create `lib/audit-events.ts`, `lib/history.ts`, `lib/history-undo.ts`, `lib/evidence-module.ts` | Canonical field diffs, query/pagination, conflict-safe inverses and bundle adapters |
| Modify foundation `lib/workspace-transaction.ts`, `lib/workspace-export.ts`, `lib/import-quarantine.ts`, job registration | Event integration, special append-only audit import and attachment manifest handling |
| Modify `db/schema.ts`; append generated migration under `drizzle/` | Evidence versions/links/requirements, acceptance, decisions and attachment tables |
| Create `components/evidence-panel.tsx`, `components/evidence-editor.tsx`, `components/attachment-uploader.tsx`, `components/decision-register.tsx`, `components/acceptance-dialog.tsx`, `components/history-view.tsx`, `components/history-diff.tsx` | User workflows with evidence/version/source scope visible |
| Modify `components/task-editor.tsx`, `components/planning-editors.tsx`, `components/milestone-workspace.tsx`, `components/project-baseline.tsx`, `components/control-center.tsx`, `lib/attention.ts` | Integrate evidence, assessments, history and missing/stale criteria |
| Create `tests/evidence.test.ts`, `tests/evidence-migration.test.ts`, `tests/acceptance.test.ts`, `tests/decisions.test.ts`, `tests/attachments.test.ts`, `tests/history.test.ts`, `tests/history-undo.test.ts`, `tests/evidence-export.test.ts` | Domain, ownership, transaction, lifecycle and recovery regressions |
| Create `tests/e2e/evidence-history.spec.ts`; `docs/verification/evidence-history.md` | Browser proof and honest delivery record |

Export module keys, each initially schema version 1: `evidence`, `evidence_links`, `evidence_requirements`, `acceptance_records`, `decisions`, `attachments`, `audit_events`. Foundation registry must use these exact keys. Attachment manifests are distinct from metadata rows and from actual backed-up bytes.

## Task 1 — Structured evidence and versioned provenance

**Files:** `lib/evidence-contract.ts`, `lib/evidence-validation.ts`, `lib/evidence-store.ts`, `db/schema.ts`, append-only migration, `tests/evidence.test.ts`.

- [ ] Add the following complete public domain contract. `ownerId` is deliberately absent from request-facing values; the server injects owner scope for storage.

```ts
export type EvidenceBasis = 'observed-artifact' | 'documented-result'
  | 'owner-statement' | 'connector-observation';
export type ClaimScope = 'implementation' | 'software-verification'
  | 'physical-acceptance' | 'operation' | 'release-acceptance' | 'economics';
export type EvidenceSubject = {
  type: 'project' | 'milestone' | 'task' | 'capture';
  id: string;
};
export interface EvidenceVersion {
  id: string;
  version: number;
  basis: EvidenceBasis;
  scope: ClaimScope;
  title: string;
  statement: string;
  observedAt: string | null;
  recordedAt: string;
  candidate: string | null;
  environment: string | null;
  sourceUrl: string | null;
  sourceRevision: string | null;
  sourceRecordId: string | null;
  attachmentIds: string[];
  supersedesVersion: number | null;
}
export interface EvidenceLink {
  id: string;
  evidenceId: string;
  evidenceVersion: number;
  subject: EvidenceSubject;
  requirementId: string | null;
  relation: 'supports' | 'contradicts' | 'context';
}
export type EvidenceCommand =
  | { type: 'evidence.create'; value: Omit<EvidenceVersion, 'id' | 'version' | 'recordedAt' | 'supersedesVersion'> }
  | { type: 'evidence.revise'; id: string; expectedVersion: number; value: Omit<EvidenceVersion, 'id' | 'version' | 'recordedAt' | 'supersedesVersion'> }
  | { type: 'evidence.archive'; id: string }
  | { type: 'evidence.restore'; id: string }
  | { type: 'evidence.link'; value: Omit<EvidenceLink, 'id'> }
  | { type: 'evidence.unlink'; id: string };
```

- [ ] Add D1 tables `evidence_records(user_id,id,current_version,archived_at,row_revision)`, `evidence_versions(user_id,evidence_id,version,payload_json,recorded_at)` and `evidence_links(user_id,id,evidence_id,evidence_version,subject_type,subject_id,requirement_id,relation,row_revision)`. Composite primary/foreign keys always include owner. Index owner/subject and owner/recorded time. Evidence versions are immutable; only record head/archive and links are editable. Maximum 10,000 active records per owner, 10,000 characters per statement, 200-character title, 2,048-character URL, 50 attachment references and 200 links per subject. Large source snapshots remain phase 4 observation objects rather than inflating these statement limits.
- [ ] Validate real dates, one-owner live or tombstoned subjects, ready attachment references, valid HTTP(S) credential-free URLs and known basis/scope enums. Remote source text is data, never executable instructions. Do not require dates/candidates that are genuinely unknown; encode null and explain missing context in the UI.
- [ ] Append a version using expected version and shared workspace revision. Two concurrent revisions cannot both become current; all old linked versions remain accessible. A user may link a historic version intentionally, with a warning that it is not current. An archived record still resolves in historical acceptance but is excluded from ordinary suggestions.
- [ ] Add tests first for duplicate versions, no partial links on failed create, foreign-owner evidence/attachment/subject, invalid URL/signature metadata, historic links after revise/archive, and stable IDs through task/project move. Run `node --experimental-strip-types --test tests/evidence.test.ts`. Commit `feat: add versioned evidence and provenance`.

## Task 2 — Honest migration and evidence browsing

**Files:** `lib/evidence-migration.ts`, `lib/evidence-store.ts`, `components/evidence-panel.tsx`, `components/evidence-editor.tsx`, existing editors/baseline UI, `tests/evidence-migration.test.ts`.

- [ ] Implement idempotent legacy migration via deterministic evidence IDs `legacy:<type>:<sha256-of-original-id>` only for nonempty existing evidence; the hexadecimal digest keeps IDs under 128 characters even for a maximum-length old ID. Basis is `owner-statement`; title identifies imported legacy notes; `observedAt`, candidate and environment remain null; `recordedAt` is migration time. Preserve the complete original text and document that migration time is not observation time. Keep original inline evidence unchanged for old exports/readers.
- [ ] For task/milestone legacy evidence edits after migration, create a new evidence version through the same transaction and update the inline compatibility text; evidence created in the structured registry does not overwrite unrelated legacy notes. Use a dedicated mapping row/unique external key, not title matching, to prevent duplicate migrations after restore.
- [ ] Preserve existing achieved milestones and completed tasks as historical owner-recorded status. Create no backdated acceptance records. The UI displays “Recorded before structured acceptance” until the owner reviews it; a later edit of its criteria/evidence can mark acceptance freshness “needs review” without silently changing status.
- [ ] Import bundled baseline sources as dated contextual evidence only when the owner applies/migrates that baseline. Map observed/documented/owner-decision categories explicitly; a local relative document path is a label without a fabricated web URL. Historical software result scope stays software-verification; the baseline summary of economic unknowns is context, not evidence of positive margin. Baseline proposal tasks remain proposed and unpinned.
- [ ] Add searchable evidence browsing by subject/project/scope/basis/date/archive, stable detail URLs, full provenance and version history, supports/contradicts/context relation labels, linked attachment list and explicit unknowns. Do not render evidence HTML; display safe text and validated links.
- [ ] Extend phase 2 `EntityTarget` and its parser with `evidence` and `decision` kinds, resolving evidence through `id` plus an optional positive `version` query parameter. Historical acceptance and brief citations always include the exact version; the versionless detail route explicitly displays the current head. History links use an immutable event ID. All routes retain the same neutral foreign/missing-owner behavior.
- [ ] Add tests for migration replay, empty notes, missing source date, legacy v2 import, moved task IDs, revised legacy notes, baseline application replay and preservation of historical achieved states without invented acceptance. Run `node --experimental-strip-types --test tests/evidence-migration.test.ts tests/project-baselines.test.ts tests/evidence.test.ts`. Browser-check a legacy note, a correction and two historical versions. Commit `feat: migrate and browse evidence without invented verification`.

## Task 3 — Private attachments with a staged lifecycle

**Files:** `lib/attachment-policy.ts`, `lib/attachments.ts`, `lib/attachment-jobs.ts`, `app/api/attachments/[id]/content/route.ts`, `components/attachment-uploader.tsx`, `db/schema.ts`, `tests/attachments.test.ts`.

- [ ] Foundation/cloud preparation must demonstrate the existing declared optional `BUCKET` binding backed by a private R2 bucket in the actual deployed runtime, with an isolated preview bucket. `lib/attachments.ts` uses a server-only adapter over that binding; back up objects under a separate prefix from evidence. Validate authenticated upload/read/delete locally and in the deployment's isolated test account. If the Sites publication path cannot bind private R2, mark the attachment release gate blocked on supported private blob provisioning; continue D1 evidence/history work, but do not claim attachments complete or fall back to public URLs/local disk. No extra credential goes into browser code.
- [ ] Add `attachments(user_id,id,status,filename,mime_type,expected_bytes,actual_bytes,sha256,storage_key,created_at,expires_at,ready_at,row_revision)`, status `reserved|ready|quarantined|deleted`. Add owner usage ledger/reservations guarded in the same D1 batch to prevent parallel uploads exceeding quotas. Storage keys use a server-generated opaque owner namespace plus attachment UUID; filenames never become keys. Add a unique owner/upload mutation ID association.
- [ ] Implement this module-level policy and pure signature checker. Extend text validation for bounded UTF-8 content; do not trust browser MIME or extension alone.

```ts
export const ATTACHMENT_POLICY = {
  fileBytes: 20 * 1024 * 1024,
  ownerBytes: 200 * 1024 * 1024,
  ownerFiles: 500,
  reservationMinutes: 30,
  allowedMime: [
    'application/pdf', 'image/png', 'image/jpeg', 'image/webp',
    'text/plain', 'text/csv', 'application/json',
  ],
} as const;
export function hasExpectedSignature(bytes: Uint8Array, mime: string): boolean {
  const starts = (...prefix: number[]) => prefix.every((byte, index) => bytes[index] === byte);
  if (mime === 'application/pdf') return starts(0x25, 0x50, 0x44, 0x46, 0x2d);
  if (mime === 'image/png') return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  if (mime === 'image/jpeg') return starts(0xff, 0xd8, 0xff);
  if (mime === 'image/webp') {
    return starts(0x52, 0x49, 0x46, 0x46)
      && [0x57, 0x45, 0x42, 0x50].every((byte, index) => bytes[index + 8] === byte);
  }
  if (!['text/plain', 'text/csv', 'application/json'].includes(mime)) return false;
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return !bytes.includes(0); }
  catch { return false; }
}
```

- [ ] Flow: `attachment.reserve` validates filename/MIME/declared size and reserves quota through the normal revision/receipt transaction. A same-origin authenticated PUT streams at most the reserved size to its immutable private key, computes SHA-256 and checks signature/actual size. On success, `attachment.finalize` validates the staged blob hash/length and updates D1 metadata to ready; only ready rows can be linked to evidence. A replay returns the same attachment; a different body for the same reservation is rejected. A timed-out PUT cannot create duplicate attachments. Hash/signature mismatch quarantines metadata and schedules blob deletion; no evidence points to it.
- [ ] R2 upload and D1 finalization are separate: if finalization fails, retain the reserved upload for retry and display its state; do not declare it ready. An expired unattached reservation releases quota only through a guarded cleanup command and schedules deletion. A cleanup retry verifies current status before deletion so it cannot remove a finalized file. Never delete a blob still referenced by a live evidence version, acceptance record or retained backup; retain references or reject deletion with an impact list.
- [ ] GET content verifies authentication and owner metadata first, then checks ready status. Return neutral 404 for missing/foreign IDs; expired session 401; private/no-store cache headers; sanitized ASCII fallback and RFC-compatible encoded filename in Content-Disposition; exact MIME; X-Content-Type-Options nosniff. Raster preview stays inside this authenticated route. Never redirect to a public bucket.
- [ ] Tests: oversize declared/streamed data, concurrent quota reservations, forged MIME, malicious filename, cross-owner IDs, failed blob write, successful blob/failed D1 finalization, retry after lost response, cleanup/finalize race and referenced-delete rejection. Use injected `BlobStore` methods `put/get/head/delete` with deterministic fake failures for unit tests; run a separate local R2 integration journey. Run `node --experimental-strip-types --test tests/attachments.test.ts tests/evidence.test.ts`. Commit `feat: add private evidence attachments with recovery`.

## Task 4 — Searchable decision register

**Files:** `lib/decisions.ts`, `components/decision-register.tsx`, capture/milestone/project views, global search provider, `db/schema.ts`, `tests/decisions.test.ts`.

- [ ] Add `decision_records(user_id,id,current_version,archived_at,row_revision)` and immutable `decision_versions` rows with owner/id/version, title, question, options JSON, selected option or null, rationale, status `draft|decided|superseded`, decidedAt nullable, reviewOn nullable, linked subjects/evidence-version refs, sourceCaptureId nullable and supersedesDecisionId nullable. Archive state lives on the record head; all versions remain. All relationships stay inside the owner scope. The single `decisions` export adapter includes both head and version rows; never overwrite a decided historical version.
- [ ] Decision-kind capture migration creates a linked draft using the original full body and source; no capture is marked decided just because `kind` equals decision. Existing baseline context is saved context and does not authorize new deployment/trading/spend actions. A decided entry requires an explicit owner command, nonempty choice/rationale and actual server recorded time. Distinguish a historical claimed decision date from the new record date.
- [ ] UI supports search/filter by project/status/date/review due, link/unlink to tasks/milestones, compare options, record a decision, supersede with reason, archive and restore. Decision details retain the original capture link. Supersession requires a valid existing record and is acyclic; a superseded entry remains visible through old links and acceptance references.
- [ ] Add a “decisions needing review” attention provider for reviewOn dates and changed linked requirements. Global search includes decision question/options/rationale. Decided means owner chose an option; it does not imply the action has been executed.
- [ ] Tests cover migration replay, option/selection mismatch, future unrecorded decisions, cross-owner links, supersession cycle, accepted exception provenance, old links after supersession and failed transaction preserving both decision versions. Run `node --experimental-strip-types --test tests/decisions.test.ts tests/evidence.test.ts`; run the combined acceptance/decision cases again after Task 5. Commit `feat: add decision register with provenance`.

## Task 5 — Criteria completeness and explicit owner acceptance

**Files:** `lib/evidence-requirements.ts`, `lib/acceptance.ts`, `components/acceptance-dialog.tsx`, milestone/task/evidence views, attention provider, `db/schema.ts`, `tests/acceptance.test.ts`.

- [ ] Add `evidence_requirements(user_id,id,subject_type,subject_id,label,scope,required,max_age_days,candidate,require_attachment,row_revision,archived_at)` and immutable `acceptance_records(user_id,id,subject_type,subject_id,decision,statement,candidate,criteria_hash,evidence_refs_json,recorded_at,supersedes_id)`. `decision` is `accepted|rejected|needs-review`; only server-authenticated owner-origin commands can create it. Evidence references identify exact `(id,version)` pairs and relationship context.
- [ ] New milestone acceptance criteria are individually editable requirements; preserve the existing free-text acceptance field as the overview. Do not automatically split a paragraph and assert its resulting requirements are owner-confirmed. The owner can convert legacy criteria into explicit rows after reviewing the proposed split, or keep one named criterion containing the complete text. Task requirements are optional by default; owner may require evidence before Done. New milestones require at least one required criterion and a matching owner acceptance record before Achieved; historical achieved milestones retain their legacy label.
- [ ] Implement a pure completeness check using fixed `asOf`, not Date.now. Missing context or contradicted evidence is reported as a review finding. The core algorithm below is complete for a single requirement; aggregate its findings for the acceptance preview.

```ts
import type { ClaimScope, EvidenceVersion } from './evidence-contract.ts';
export interface EvidenceRequirement {
  id: string; label: string; scope: ClaimScope; required: boolean;
  maxAgeDays: number | null; candidate: string | null; requireAttachment: boolean;
}
export function requirementFindings(
  requirement: EvidenceRequirement, evidence: EvidenceVersion[], asOf: string,
): string[] {
  const now = Date.parse(asOf);
  if (!Number.isFinite(now)) throw new Error('A valid assessment time is required.');
  const matching = evidence.filter(item => item.scope === requirement.scope
    && (!requirement.candidate || item.candidate === requirement.candidate)
    && (!requirement.requireAttachment || item.attachmentIds.length > 0));
  if (!matching.length) return requirement.required ? [`${requirement.label}: missing matching evidence`] : [];
  if (requirement.maxAgeDays === null) return [];
  const earliest = now - requirement.maxAgeDays * 86_400_000;
  const fresh = matching.some(item => item.observedAt !== null
    && Date.parse(item.observedAt) >= earliest && Date.parse(item.observedAt) <= now);
  return fresh ? [] : [`${requirement.label}: evidence date is unknown or outside its freshness window`];
}
```

- [ ] The aggregate additionally verifies ready attachments, current evidence head or an explicitly selected historical version, supports/contradicts relation, exact subject and requirement membership. Conflicting evidence must be displayed; owner acceptance may explicitly acknowledge unresolved non-required findings, but required criteria cannot be bypassed silently. A named exception is stored as an owner decision with reason, scope and expiry and linked to the acceptance record; no automatic exception creation.
- [ ] `acceptance.record` includes subject, decision, statement, candidate, criteria hash, evidence refs and optional superseded acceptance ID. Server recomputes the hash and completeness at the saved revision. The dialog shows “This records your assessment of [scope]” and all unknowns. Selecting accepted then saving task/milestone state is one shared transaction. A connector-supplied command or stale hash returns a rejected command/conflict without any partial status change.
- [ ] Later criteria changes, evidence correction/archive or attachment unavailability produce “acceptance needs review” in attention and the milestone display. Preserve the immutable earlier decision and its exact evidence; do not silently rewrite status or claim continued validity. Scope-specific wording keeps a software-verification acceptance from implying physical/release/economic acceptance.
- [ ] Add complete tests for the pure helper:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { requirementFindings } from '../lib/evidence-requirements.ts';
import type { EvidenceVersion } from '../lib/evidence-contract.ts';
test('software results cannot satisfy a physical acceptance criterion', () => {
  const software: EvidenceVersion = {
    id: 'e1', version: 1, basis: 'documented-result', scope: 'software-verification',
    title: 'Unit checks', statement: 'The named software candidate passed its recorded tests.',
    observedAt: '2026-10-18T10:00:00Z', recordedAt: '2026-10-18T11:00:00Z',
    candidate: 'candidate-a', environment: 'local-ci', sourceUrl: null,
    sourceRevision: null, sourceRecordId: null, attachmentIds: [], supersedesVersion: null,
  };
  const findings = requirementFindings({ id: 'r1', label: 'Device acceptance',
    scope: 'physical-acceptance', required: true, maxAgeDays: 7,
    candidate: 'candidate-a', requireAttachment: false }, [software], '2026-10-18T12:00:00Z');
  assert.deepEqual(findings, ['Device acceptance: missing matching evidence']);
});
```

- [ ] Additional acceptance tests cover unknown/future/expired dates, candidate mismatch, connector rejection, concurrent criterion edit, explicit exception record, retained historic acceptance after correction, empty required criteria and software evidence that cannot satisfy economics. Run `node --experimental-strip-types --test tests/acceptance.test.ts tests/evidence.test.ts`. Commit `feat: record scoped human acceptance and completeness`.

## Task 6 — Immutable field-level events and browsable history

**Files:** `lib/audit-events.ts`, `lib/history.ts`, foundation transaction compiler, `app/api/history/route.ts`, `components/history-view.tsx`, `components/history-diff.tsx`, `tests/history.test.ts`.

- [ ] Use the foundation `audit_events` table fields: `user_id,event_id,workspace_revision,ordinal,stream_id,stream_sequence,kind,entity_type,entity_id,origin,actor_id,occurred_at,source_ref,undo_of,payload_json`. Unique `(user_id,event_id)`; owner-command events additionally use `(user_id,workspace_revision,ordinal)` and operational events `(user_id,stream_id,stream_sequence)`, with exactly one ordering domain populated. Append-only application access. Generate events server-side from before/after values and validated command intent. Never trust client-provided actor, revision, event time or diff.
- [ ] Use these exact canonical event types from foundation `lib/workspace-protocol.ts` and implement the pure diff helper. Re-export the types from `lib/audit-events.ts` for consumers; do not maintain duplicate runtime schemas. Arrays are atomic values to avoid unstable positional patches. Object keys are sorted; absent and null remain distinct.

```ts
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface ChangeValue { exists: boolean; value: JsonValue; }
export interface FieldChange { path: string[]; before: ChangeValue; after: ChangeValue; }
export interface AuditEventDraft {
  id: string;
  kind: string;
  entityType: string;
  entityId: string | null;
  changes: FieldChange[];
  origin: 'owner' | 'connector' | 'migration' | 'system';
  actorId: string;
  occurredAt: string;
  sourceRef: string | null;
  undoOf: string | null;
}
const missing: ChangeValue = { exists: false, value: null };
function valueAt(record: Record<string, JsonValue>, key: string): ChangeValue {
  return Object.hasOwn(record, key) ? { exists: true, value: record[key] } : missing;
}
export function topLevelChanges(
  before: Record<string, JsonValue>, after: Record<string, JsonValue>,
): FieldChange[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().flatMap(key => {
    const previous = valueAt(before, key);
    const next = valueAt(after, key);
    return JSON.stringify(previous) === JSON.stringify(next) ? [] : [{ path: [key], before: previous, after: next }];
  });
}
```

- [ ] Canonicalize nested object key order before calling this helper, using the foundation canonical JSON routine; otherwise an order-only change could create a false event. Generate one event per affected entity/module row plus one command summary carrying the mutation receipt reference. Store large bulk commands as multiple bounded rows ordered by ordinal, not an unbounded single JSON message. Legacy inline activity remains a compatibility summary, no longer the canonical history.
- [ ] Every mutation path must emit meaningful events: ordinary edits, create/archive/restore/delete, move/bulk, baseline application including a previously applied no-op result, full workspace restore, weekly commitment/review, recurrence materialization, evidence version/link/decision/acceptance, attachment ready/delete and future source/job changes. Unchanged retry replay emits no new event. A no-change command may record an explicit command outcome without fake field changes; document that distinction in the timeline.
- [ ] Baseline events list exact added task/context IDs, source package date and preserved records; restore events include source bundle hash, before/after revisions, counts and per-entity field events. Add imported old `activity` rows as `legacy-summary` with original timestamp/text and no diffs; do not imply complete history before migration. The original 100-event cap cannot be repaired retrospectively without independent backup evidence.
- [ ] GET history supports entity/project/type/origin/date filters and a signed owner-scoped cursor containing the initial owner workspace revision, operational stream watermarks and last `(occurredAt,eventId)` seek key. Use 50 rows/page, descending deterministic time/ID ordering, and select only events at or below the cursor's frozen revision/watermarks. New events appear after an explicit refresh, avoiding duplicate/missing pages while streams advance. Group rows by receipt/command or operational stream; show who/what/time/source, values before/after, changed-field highlight, source snapshot link and whether undo is available. Render imported actor labels as historical source claims, never verified current identities. Preserve diff access for deleted entity tombstones.
- [ ] Tests use real SQLite: batch failure creates neither event nor mutation; replay creates no duplicate events; two owners cannot read each other's cursors; field absence differs from null; array changes restore whole list; baseline/restore appear; import summaries retain historical dates; pagination has no duplicate/missing rows during concurrent newer inserts. Run `node --experimental-strip-types --test tests/history.test.ts tests/reliability-storage.test.ts`. Commit `feat: add immutable field-level history`.

## Task 7 — Guarded ordinary-edit undo

**Files:** `lib/history-undo.ts`, foundation handler registry, `components/history-view.tsx`, `components/history-diff.tsx`, `tests/history-undo.test.ts`.

- [ ] Add `history.undo.preview` as a read-only request that returns affected entities/fields, inverse values, current shared revision, exact source event IDs, blockers and immutable preview token. `history.undo` submits token plus original command mutation ID through the normal envelope. It reverses the whole command group atomically; a partial subset is a new explicit edit, not labelled undo.
- [ ] Implement matching via this pure helper; production undo also applies the inverse to a clone and runs all current planning/module/reference validation before generating guarded writes.

```ts
import type { ChangeValue, FieldChange, JsonValue } from './audit-events.ts';
function currentValue(entity: Record<string, JsonValue>, change: FieldChange): ChangeValue {
  if (change.path.length !== 1) throw new Error('Unsupported undo field path.');
  const key = change.path[0];
  if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Invalid undo field.');
  return Object.hasOwn(entity, key) ? { exists: true, value: entity[key] } : { exists: false, value: null };
}
export function assertUndoMatches(entity: Record<string, JsonValue>, changes: FieldChange[]): void {
  for (const change of changes) {
    if (JSON.stringify(currentValue(entity, change)) !== JSON.stringify(change.after)) {
      throw new Error(`Cannot undo: ${change.path.join('.')} changed after this action.`);
    }
  }
}
export function applyInverse(entity: Record<string, JsonValue>, changes: FieldChange[]): Record<string, JsonValue> {
  assertUndoMatches(entity, changes);
  const next = structuredClone(entity);
  for (const change of changes) {
    if (change.before.exists) next[change.path[0]] = structuredClone(change.before.value);
    else delete next[change.path[0]];
  }
  return next;
}
```

- [ ] Canonicalize values before comparison. Maintain an allowlist of mutable user fields per entity; exclude owner IDs, stable IDs, event/receipt internals, source identities and security metadata. Recompute server-managed updated/completed timestamps according to the intended restored lifecycle; if restoring a previous completed state, preserve its audited original completion timestamp rather than recording a new completion. Old/current field predicates and the shared revision protect the final commit after preview.
- [ ] Undo a create only if the created entity has not changed and no current reference would break; otherwise show specific references and require explicit edits. Undo deletion restores its recorded tombstone only if ID is unused and references validate. Undo archive/move/bulk uses full graph checks; reopening a prerequisite remains blocked by a completed dependent. Evidence/decision correction undo changes the current head/link via a new audited action; immutable historical versions stay intact.
- [ ] Undo of a workspace restore or a purge exceeding ordinary entity restoration uses the foundation recovery snapshot preview instead of a blind inverse. External agent/trading/spend side effects are never “undone” by editing local status; show an irreversible/external-action reason. Connector source observations may be archived or their proposed plan changes reversed locally, but the observed upstream fact is not falsified.
- [ ] Add complete inverse regression tests:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyInverse } from '../lib/history-undo.ts';
import type { FieldChange } from '../lib/audit-events.ts';
const titleChange: FieldChange = { path: ['title'],
  before: { exists: true, value: 'Original' }, after: { exists: true, value: 'Edited' } };
test('undo preserves a later edit to an unrelated field', () => {
  assert.deepEqual(applyInverse({ title: 'Edited', priority: 'high' }, [titleChange]),
    { title: 'Original', priority: 'high' });
});
test('undo refuses to overwrite a later edit to the same field', () => {
  const current = { title: 'Third title', priority: 'high' };
  assert.throws(() => applyInverse(current, [titleChange]), /changed after/i);
  assert.equal(current.title, 'Third title');
});
```

- [ ] Add real SQLite tests for double undo/replay, two-session preview conflict, missing deleted snapshot, archived completed prerequisite, cross-module evidence link and bulk all-or-none undo. Audit rows must include `undoOf` and both inverse field values; original events stay unchanged. Run `node --experimental-strip-types --test tests/history-undo.test.ts tests/history.test.ts tests/planning-workflows.test.ts`. Commit `feat: add conflict-safe history undo`.

## Task 8 — Complete portable backup, restore and cleanup integration

**Files:** `lib/evidence-module.ts`, foundation export/import/backup/job registry, `components/sources-view.tsx`, `tests/evidence-export.test.ts`.

- [ ] Register all seven module adapters. Export all referenced historic evidence versions, acceptance records, decision versions and attachment metadata at one owner revision plus captured operational stream watermarks. Include archive/tombstone references required by immutable history. Keep the v2 JSON importer working; it supplies empty normalized modules then runs honest legacy migration.
- [ ] Give `audit_events` an append-only restore adapter: preserve target events; namespace each imported event with its original source event identity and a stable source-stream/import namespace. Preserve original event ID, actor claim, revision/sequence and source bundle hash in import provenance. Re-import of identical namespace/event/payload deduplicates; conflicting payload for that identity rejects preview. Do not force original source ordinals into the target unique revision/ordinal sequence. Native target events remain unchanged, and the actual restore event is newly appended at the target commit revision. No restore may erase the audit of the restore itself.
- [ ] Keep that namespace stable across successive bundles from the same source stream; never use the whole-bundle content hash as the namespace. Persist and re-export imported original namespace/event IDs so importing an export of an import cannot multiply the same historical event. Source bundle hash is provenance of a particular import, not event identity.
- [ ] Attachments use the foundation manifest contract `{id,filename,contentType,bytes,sha256,archivePath,availability}` with availability `included|missing|excluded` and null archivePath when bytes are absent. Metadata-only JSON export is clearly labeled “references only, file bytes not included”. Foundation full backup bundles must include each referenced blob at `attachments/<id>` and verify the bytes/hash. Never count a manifest as backed-up evidence. Keep filename/path normalization independent from user input to prevent archive path traversal.
- [ ] Full restore first validates archive, manifests, quotas, IDs, modules and references; stage blobs under new immutable keys and verify hashes before final restore approval. The final shared D1 transaction switches metadata/module/planning references and records backup/events. If it fails, existing workspace and attachments remain usable; staged unused objects enter cleanup. Deleting a record does not immediately remove its blobs while any retained backup/acceptance/evidence version references them.
- [ ] Cleanup integrates foundation retention previews and actual blob reference counts. Show record/metadata/blob bytes separately; do not report task archive as capacity recovered. A purge of evidence with historic acceptance links requires keeping a minimal tombstone and the referenced version/bytes or rejecting the operation with the retaining references. Scheduled backup/retention policies belong to foundation; this module must obey them rather than adding a second schedule.
- [ ] Tests: legacy import, new module unknown-version rejection, full binary round-trip, missing/corrupt blob, duplicate archive path, foreign owner row rewrite, late restore conflict after blob staging, imported audit ID conflict, failed restore retaining originals, and cleanup that cannot remove a retained backup file. Run `node --experimental-strip-types --test tests/evidence-export.test.ts tests/attachments.test.ts tests/history.test.ts`. Commit `feat: preserve evidence and history across backup restore`.

## Task 9 — Integrated browser and release acceptance

**Files:** `tests/e2e/evidence-history.spec.ts`, `README.md`, `docs/verification/evidence-history.md`.

- [ ] Browser journey on isolated data: open legacy milestone → inspect migrated evidence → upload valid text/PDF/raster evidence → link an exact version → add scope/candidate requirements → observe missing physical evidence despite software results → record an explicit owner assessment → correct evidence → see acceptance review finding → record/supersede a decision → inspect field diffs → undo an ordinary title edit while retaining a later priority edit → reject undo after another title edit → export full backup → restore into isolated owner state and download identical attachment bytes.
- [ ] Inject upload/body timeout, R2 failure, D1 finalize conflict, session expiry during upload, history pagination while another session saves, stale acceptance criteria and rejected cleanup. Unsaved evidence/decision text uses foundation draft protection; sign-out never exposes protected metadata/files. Browser-back navigation and screen-reader labels must identify evidence version, scope and historical assessment accurately.
- [ ] Check 320/390/768/1280 px layouts, keyboard-only file selection and dialogs, long filenames/source URLs, Arabic and English evidence search, safe text rendering and multi-page history. Local tests do not substitute for a real supported private blob binding and fresh deployed authentication evidence at the master release gate.
- [ ] Run `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` and `npm run test:e2e -- tests/e2e/evidence-history.spec.ts`. Record actual commands/counts/results in `docs/verification/evidence-history.md`; include current binding/deployment proof separately from local emulator proof.
- [ ] Update README and the master capability matrix: structured evidence, attachment state, explicit assessments, searchable decisions, complete history and ordinary-edit undo are available only after their actual acceptance gates pass. Document recovery/retention bounds and non-reversible external actions. Commit `feat: finish evidence and history workflows`.

## Completion checklist and cloud handoff

- [ ] Every claim can retain dated provenance, immutable evidence versions, scoped requirements and optional file support without manufacturing verification.
- [ ] Evidence, decisions and attachments are searchable/reachable from projects, milestones, tasks, capture links and global search; archived historic references still resolve.
- [ ] Required completeness and exact candidate/scope checks run server-side; only an explicit owner command records acceptance.
- [ ] Actual private attachment upload/download, quotas, retry/finalize/cleanup and binary backup are verified on supported infrastructure.
- [ ] History records baseline, restore and all new/old mutation paths; no 100-event truncation of the canonical normalized audit.
- [ ] Safe ordinary-edit undo preserves unrelated changes, refuses conflicts, respects graph/reference checks and appends its own audit record.
- [ ] Full backup/restore includes all registered modules and bytes, preserves the target's audit history and never reports missing files as recovered.

Resolved assumptions: one owner per workspace, immutable historical evidence and decisions, no team-review roles, same-owner attachments, null for unknown provenance, separate software/physical/operational/economic scopes, conservative product upload quotas and private R2 storage. Private blob provisioning is a concrete environment acceptance gate; no unsupported runtime binding or paid storage configuration is presumed already available. No claim in this phase certifies release readiness, physical behavior or financial returns beyond the owner's explicitly recorded scope and evidence.
