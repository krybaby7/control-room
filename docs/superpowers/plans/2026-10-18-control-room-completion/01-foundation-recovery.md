# Phase 1: Foundation and Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every owner change recoverable and reconcilable, provide a shared transaction/export foundation for later phases, and remove the audited capacity, backup, draft and diagnostics gaps.

**Architecture:** Retain Sites, Vinext, React and D1. Keep the planning document bounded while moving drafts, backup manifests, audit events and subsequent feature records into owner-scoped side tables. A single shared revision and durable mutation receipt cover planning and owner-command module changes; telemetry, cursors, drafts and job progress use their own scoped revisions. External effects run only from committed authorized job intents.

**Tech Stack:** Existing TypeScript/React/Vinext application, Cloudflare D1/Drizzle, Node 24 test runner and SQLite fixtures; proposed private R2 backup storage, IndexedDB only after an explicit trusted-device opt-in, and the verified scheduler adapter supplied by the integration phases.

---

## Status, prerequisites and evidence boundary

This is a plan, not a record of implementation. No implementation checkbox is complete. Execute after the root plan's discovery/capability phase. Routine implementation, fixtures and isolated local verification do not need new approval gates. Production mutations, live connectors and owner authentication follow the root plan's authorized scope.

Baseline inspected on 18 October 2026: commit `b50aa5c`, 71 passing tests, passing typecheck/lint/build, clean source tree before these planning files. The existing document at `docs/superpowers/verification/2026-10-17-reliability-baseline.md` describes local evidence and still lists publication and hosted checks as pending. Reconcile that document with independently observed deployment state; do not turn its unchecked boxes into claims that the site is currently unpublished.

Current implementation boundaries:

- `app/api/workspace/route.ts` exposes GET and POST; POST currently receives `{revision, mutationId, command}`.
- `lib/workspace-store.ts` owns one JSON document per user, durable receipts and one pre-restore snapshot. `SqlDatabase.batch` is the transaction boundary.
- `components/control-center.tsx` retains submission IDs and drafts in memory, with no request timeout or cancellation.
- `lib/workspace-validation.ts` accepts planning schemas 1 and 2 and enforces 1 MB/2,000 tasks/1,000 captures/100 milestones. Existing near-limit legacy migration can expand beyond the write/restore limit.
- `.openai/hosting.json` has `d1: "DB"` and `r2: null`. `cloudflare-env.d.ts` declares optional `BUCKET`; this is not proof that a real bucket exists.
- `build/sites-worker.ts` has a fetch entry point only. A scheduled handler or external authenticated job runner must be verified with Sites before it can be claimed operational.

Paths below are repository-relative. Names marked proposed are new contracts, not APIs already available in the checkout. Append migrations; never edit applied `drizzle/0000_old_peter_parker.sql` or `drizzle/0001_clear_greymalkin.sql`.

## Shared contracts for phases 2–7

Create `lib/workspace-protocol.ts` for these proposed public contracts. Preserve the existing `WorkspaceEnvelope` fields and add optional capability metadata through an explicit response schema. The authenticated user is supplied by the server, never a request-body owner field.

```ts
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type WorkspaceCommand = { type: string; [key: string]: JsonValue };
export interface CommandEnvelope {
  protocolVersion: 1;
  expectedRevision: number;
  mutationId: string;
  command: WorkspaceCommand;
}
export interface MutationReceipt {
  mutationId: string;
  commandHash: string;
  appliedRevision: number;
}
export type CommandResult =
  | { status: 'committed' | 'replayed'; envelope: WorkspaceEnvelope; receipt: MutationReceipt }
  | { status: 'conflict'; currentRevision: number };
export type MutationOutcome =
  | { status: 'committed'; receipt: MutationReceipt; currentRevision: number }
  | { status: 'not-found'; currentRevision: number }
  | { status: 'retired'; retryAllowed: false };
export interface ChangeValue { exists: boolean; value: JsonValue }
export interface AuditEventDraft {
  id: string;
  kind: string;
  entityType: string;
  entityId: string | null;
  changes: Array<{ path: string[]; before: ChangeValue; after: ChangeValue }>;
  origin: 'owner' | 'connector' | 'migration' | 'system';
  actorId: string;
  occurredAt: string;
  sourceRef: string | null;
  undoOf: string | null;
}
```

`WorkspaceEnvelope` and `Workspace` above refer to the existing exports in `lib/types.ts`, upgraded by Task 1. `ChangeValue.value` is `null` when `exists` is false; this distinguishes removal from an explicitly stored JSON null. Every command type gets a strict schema in the server registry; the index signature is transport typing, not permission to accept arbitrary fields.

Proposed transaction entry point in `lib/workspace-transaction.ts`:

```ts
export interface GuardedWrite {
  table: RegisteredOwnerTable;
  operation: 'insert' | 'update' | 'delete';
  key: Record<string, string | number>;
  values: Record<string, string | number | null>;
  expectedRowRevision: number | null;
}
export interface JobIntent {
  id: string;
  kind: string;
  dedupeKey: string;
  payload: JsonValue;
  notBefore: string;
}
export interface MutationPlan {
  planningAfter: Workspace;
  writes: GuardedWrite[];
  preconditions?: Array<{
    table: RegisteredOwnerTable;
    key: Record<string, string | number>;
    expectedRowRevision: number;
    expectedHash?: string;
  }>;
  events: AuditEventDraft[];
  backup?: { reason: 'restore' | 'delete' | 'repair' };
  jobs: JobIntent[];
}
export interface PrepareContext {
  userId: string;
  before: WorkspaceEnvelope;
  command: WorkspaceCommand;
  now: string;
  query: OwnerScopedReader;
}
export interface CommandHandler { prepare(context: PrepareContext): Promise<MutationPlan> }
export type CommandHandlerRegistry = ReadonlyMap<string, CommandHandler>;
export interface WorkspaceTransactionDeps {
  db: SqlDatabase;
  now: () => string;
  handlers: CommandHandlerRegistry;
}
export function executeWorkspaceCommand(
  userId: string,
  envelope: CommandEnvelope,
  deps: WorkspaceTransactionDeps,
): Promise<CommandResult>;
```

Define `RegisteredOwnerTable` and `OwnerScopedReader` in `lib/workspace-modules.ts`: the former is a closed server registry of table identifiers, keys and writable columns; the latter offers registered-table `get` and paginated `list` operations that inject `user_id`. It accepts no SQL or owner override from a request. Register phase-2 tables `weekly_plans`, `weekly_reviews`, `recurrence_rules`, `recurrence_occurrences`; phase 3 registers evidence/link/decision/attachment tables. Row values must be codec-validated before reaching `GuardedWrite`.

Owner planning, weekly-plan, evidence, decision, configuration, and create/approve/cancel/accept commands increment the shared workspace revision even if `planningAfter` is value-equivalent. The transaction compiler, not feature handlers, adds owner predicates, receipt guards, row-version checks, audit metadata and job insertion. An acceptance command includes read preconditions for the exact immutable source record/hash it accepts.

High-frequency heartbeat, telemetry, source cursor, job lease and progress writes use separate owner-scoped operational CAS versions/stream sequences. They do not advance the workspace editor revision, alter planning, confer approval or authorize effects. Operational audit events carry their own stream ID/sequence; owner-command events carry workspace revision/ordinal. Export consistency must honor both domains rather than treating an unchanged workspace revision as proof that operational data is unchanged.

Prepared blob uploads and short-lived transport staging are not authoritative user records. Phase 7's external-execution jobs use an `agent_jobs` extension row linked uniquely by `intent_id`; admission commits through the shared command transaction, while runner claims update that row and `workspace_job_intents` together under operational CAS. It is not a second independently populated queue. Internal backup intents use the same durable infrastructure without requiring an external model/device execution approval.

Proposed export contract in `lib/workspace-export.ts`:

```ts
export interface AttachmentManifestEntry {
  id: string;
  filename: string;
  contentType: string;
  bytes: number;
  sha256: string;
  archivePath: string | null;
  availability: 'included' | 'missing' | 'excluded';
}
export interface WorkspaceBundle {
  format: 'control-room';
  bundleVersion: 1;
  exportedAt: string;
  source: {
    workspaceRevision: number;
    planningSchemaVersion: number;
    moduleWatermarks?: Record<string, string>;
  };
  planning: unknown;
  modules: Record<string, { schemaVersion: number; records: unknown[] }>;
  attachments: AttachmentManifestEntry[];
}
export interface ExportModule {
  key: string;
  schemaVersion: number;
  exportRows(context: ExportContext): Promise<unknown[]>;
  parseAndMigrate(input: { schemaVersion: number; records: unknown[] }): unknown[];
  validateReferences(context: ImportContext, rows: unknown[]): void;
  prepareReplace(context: ImportContext, rows: unknown[]): GuardedWrite[];
}
export function registerExportModule(module: ExportModule): void;
```

`ExportContext` contains server-derived `userId`, `sourceRevision`, captured `moduleWatermarks` and `OwnerScopedReader`. An operational module exports its retained immutable rows up to the captured sequence; mutable operational rows need a snapshot or their own before/after version check. `ImportContext` additionally contains the complete parsed bundle, planning result, owner table registry and validated replacement scope. Define both in `lib/workspace-export.ts`. Preview never writes authoritative rows. Bundle, planning and each module have separate versions. The planning migration chain is v1 → v2 → v3 here, then v3 → v4 in phase 2. Unknown modules fail closed or remain in quarantine; they are never silently discarded. Receipts, credentials, connector tokens, auth identities and executable job payloads are not importable modules. The `audit_events` adapter is append/merge-only despite the generic `prepareReplace` method name: it preserves the target ledger and imports historical events with import provenance, namespaced IDs and their original source metadata. Imported actor fields are reported as source claims, never treated as trusted current-session identities.

## Task 0: Establish the browser harness used by later phases

**Files:** create `playwright.config.ts`, `scripts/test-worker.mjs`, `scripts/test-fixtures.mjs`, `tests/e2e/helpers.ts`, `tests/e2e/recovery.spec.ts`; modify `package.json`, `package-lock.json`, `.gitignore`.

- [ ] Add a pinned Playwright test dependency and define `"test:e2e": "playwright test --config playwright.config.ts"`. This is the one browser directory/runner used by phases 1–8; phase 8 extends it instead of requiring later phases to call a nonexistent script.
- [ ] Implement `scripts/test-worker.mjs --target local-fixture --serve` to start the existing application with migrations and synthetic owners in a temporary D1/R2 directory, and clean up its own process/state on termination. Default to loopback port 4173 with an explicit `TEST_PORT` override; fail on an occupied port rather than attaching to an unrelated server. The mode without `--serve` starts the same fixture, runs worker route smoke assertions and exits. Refuse non-loopback target URLs and real database identifiers.
- [ ] Configure Playwright's web server with that exact serve command and matching port/base URL. Use `tests/e2e/helpers.ts` for local mock sign-in, deterministic fixture reset and controlled response loss. Production builds exclude every fixture fault-injection path. Add an initial recovery scenario that observes a real fixture POST commit, drops the response, retries unchanged and verifies one saved record.
- [ ] Run `npm run test:e2e -- tests/e2e/recovery.spec.ts` after the harness exists. Record browser availability separately; continue Node-only work if Chromium cannot be installed in the executor. Phase 8 supplies the broader portable release runner and migration/performance suites.

## Task 1: Versioned codec and capacity-safe migration

**Files:** modify `lib/types.ts`, `lib/workspace-validation.ts`, `lib/workspace-store.ts`, `lib/api-guards.ts`, `tests/reliability-storage.test.ts`, `tests/reliability-validation.test.ts`; create `lib/workspace-codec.ts`, `lib/workspace-migrations.ts`, `tests/workspace-codec.test.ts`.

- [ ] Extract explicit `migratePlanningV1ToV2` and `migratePlanningV2ToV3` functions, keeping the original saved timestamp as the legacy week anchor. Preserve IDs, timestamps, archived status, source links, unknown future-version rejection and seed-once behavior.
- [ ] Add a canonical storage codec that omits permitted default/null metadata at rest and hydrates it on read. Define `measurePlanning(workspace)` returning `{contentBytes, serializedBytes}`. The initial budget is 1,000,000 UTF-8 user-content bytes plus a separately bounded metadata allowance, with a 1,250,000-byte serialized ceiling. Specify the excluded generated fields in code (`schemaVersion`, `weeklyWeek`, `archivedFromStatus`); never exclude owner-entered title, notes, evidence, IDs or links. Surface both figures and separate side-table usage in Sources.
- [ ] Make import, mutation, export and capacity checks use that one codec. Adjust streamed request bounds only for the named import route; ordinary commands keep their small payload limit. Large bundles use bounded staging rather than raising every POST limit.
- [ ] Replace the current near-limit regression expectation with this lossless contract, using the existing 1,800-task legacy fixture construction:

```ts
test('near-limit legacy content can migrate, export, restore and shrink', async () => {
  const source = nearLimitLegacyFixture(); // Extract the fixture already in reliability-storage.test.ts.
  const migrated = migratePlanningV2ToV3(migratePlanningV1ToV2(source, savedAt));
  const encoded = encodePlanning(migrated);
  assert.ok(measurePlanning(migrated).serializedBytes <= 1_250_000);
  assert.deepEqual(decodePlanning(encoded, savedAt), migrated);
  assert.deepEqual(parsePlanningImport(JSON.parse(encoded), savedAt), migrated);
  const smaller = structuredClone(migrated);
  smaller.tasks[0].notes = '';
  assert.ok(measurePlanning(smaller).contentBytes < measurePlanning(migrated).contentBytes);
  assert.equal(source.tasks.length, smaller.tasks.length);
});
```

The proposed codec exports are `encodePlanning(Workspace): string`, `decodePlanning(string, savedAt): Workspace`, `parsePlanningImport(unknown, savedAt?): Workspace`, and `measurePlanning(Workspace)`. Define `savedAt` as the fixture timestamp and extract `nearLimitLegacyFixture()` in the same test file; this example is a required assertion set, not a pre-existing test helper.

- [ ] Add byte-boundary fixtures for multi-byte Arabic text, default-field omission, weekly metadata at maximum count, repeated import/export and truly oversized user content. Reject oversize with no receipt, draft deletion or partial write.
- [ ] Run `node --experimental-strip-types --test tests/workspace-codec.test.ts tests/reliability-storage.test.ts tests/reliability-validation.test.ts`. Confirm the new regression first fails against the previous codec, then passes without weakening invalid-import tests. Commit this bounded slice after review.

## Task 2: One transaction across document and modules

**Files:** create `lib/workspace-protocol.ts`, `lib/workspace-transaction.ts`, `lib/workspace-modules.ts`, `lib/workspace-handlers.ts`, `tests/workspace-transaction.test.ts`; modify `lib/workspace-store.ts`, `lib/api-guards.ts`, `app/api/workspace/route.ts`, `db/schema.ts`, `tests/helpers/sqlite.ts`; append the next Drizzle migration and its generated metadata.

- [ ] Add schemas for `workspace_command_guards`, `audit_events` and `workspace_job_intents`. Use `(user_id, event_id)` ownership for events, partial uniqueness on `(user_id, workspace_revision, ordinal)` for owner-command events, separate `(user_id, stream_id, stream_sequence)` uniqueness for operational events, and `(user_id, kind, dedupe_key)` uniqueness for jobs. `audit_events` stores the draft fields above plus nullable revision/ordinal, nullable stream coordinates and `payload_json`, with exactly one ordering domain required; later history UI must not depend on the current 100-item activity projection.
- [ ] Implement the protocol and handler registry. Adapt existing `applyCommand` commands through a handler; do not duplicate lifecycle validation or retain a second production write path. Keep the old HTTP shape as a temporary adapter for a rolling deployment, mapping `revision` to `expectedRevision`; both routes reach the same executor.
- [ ] Compile one D1 batch in this order: claim receipt conditional on expected workspace revision; assert all side-row and accepted-source preconditions; insert a pre-change bundle snapshot/verified manifest covering planning and normalized modules when requested; apply guarded side-row writes; append audit events and job intents; compare-and-swap planning content and revision; finalize receipt metadata; remove transient guard rows. Every statement is conditional on the same owner/receipt/hash/revision claim. Operational CAS writers use their own narrow adapters and cannot invoke this path to synthesize owner authority.
- [ ] Use a SQL `CHECK(valid = 1)` assertion table for preconditions that otherwise could silently update zero rows. Do not infer success from a receipt insert while ignoring a failed side-row update. A failed assertion must abort the entire batch. After a batch exception, inspect the owner receipt and current revision to distinguish replay/conflict from storage failure; never return a raw database error.
- [ ] Hash canonical `{protocolVersion, command}` only. Exclude `expectedRevision` so an unchanged explicit retry after refresh retains identity. Different command content with the same ID returns a typed reuse error. Returning a replay includes the current authoritative envelope, not an old document snapshot.
- [ ] Add tests with a sample registered side table: successful document+row+event+job commit; stale workspace revision; stale side-row version; changed accepted-source hash; injected failure at each write stage; two concurrent owners; two writers at the same revision; same ID/same content replay; same ID/different content rejection; owner module-only command revision increment; telemetry/lease update leaving the editor revision unchanged. For every rejection, assert unchanged document, rows, events, job intents and receipt count.
- [ ] Run `node --experimental-strip-types --test tests/workspace-transaction.test.ts tests/reliability-storage.test.ts tests/storage.test.ts tests/api-guards.test.ts`, then typecheck. Commit only after rollback assertions pass. Later phases register handlers/modules against this contract instead of issuing independent writes.

## Task 3: Timeout, reconciliation and useful diagnostics

**Files:** create `lib/mutation-client.ts`, `app/api/workspace/mutations/[mutationId]/route.ts`, `lib/workspace-diagnostics.ts`, `tests/mutation-client.test.ts`; modify `components/control-center.tsx`, `components/form-dialog.tsx`, `lib/workspace-client.ts`, `app/api/workspace/route.ts`, `tests/workspace-client.test.ts`.

- [ ] Add a 15-second client request deadline via `AbortController`, injectable for tests. Aborting means the result is unknown, not that the server cancelled. Preserve the exact command/hash/ID and transition the UI from `saving` to `checking`/`uncertain`; unlock editing without silently changing the pending command.
- [ ] Implement authenticated, private, no-store GET `/api/workspace/mutations/[mutationId]` using the `MutationOutcome` contract. The route scopes lookup to the session owner. `not-found` only means no committed receipt at the time of lookup; the original request can still commit later.
- [ ] Implement `sendCommand`, `lookupMutationOutcome` and `reconcileSubmission` in `lib/mutation-client.ts`. Reconcile at most three reads with injected backoff, then expose an explicit unchanged retry. Reuse the original mutation ID on retry. A changed draft creates a new command and ID, with the unresolved original shown before replacement. A retired receipt epoch never becomes a new execution.
- [ ] Preserve request IDs and structured error codes through `readWorkspaceResponse`. Show actionable wording plus a copyable request ID; log only event code, route, phase, duration and request ID. Do not log commands, document text, usernames, tokens or raw errors. Distinguish `revision_conflict`, `mutation_id_reused`, `session_expired`, `capacity_exceeded`, `schema_invalid`, `storage_unavailable` and `outcome_unknown`.
- [ ] Test: timeout before commit; timeout after commit; lookup returns not-found while original request later commits; lookup itself fails; delayed older response after a later revision; malformed success; 401 during lookup; close/reopen editor; changed command while original uncertain. Assert exactly one commit for an unchanged retry and no success toast before receipt confirmation.
- [ ] Run `node --experimental-strip-types --test tests/mutation-client.test.ts tests/workspace-client.test.ts`. Add the browser equivalents in phase 8's `tests/e2e/recovery.spec.ts`; local unit success alone does not verify the interaction. Commit the coherent client/API slice.

## Task 4: Recoverable drafts and explicit offline outbox

**Files:** create `lib/drafts.ts`, `lib/device-outbox.ts`, `components/recovery-center.tsx`, `components/device-storage-settings.tsx`, `app/api/drafts/route.ts`, `app/api/drafts/[draftId]/route.ts`, `tests/drafts.test.ts`, `tests/device-outbox.test.ts`; modify `components/control-center.tsx`, `components/form-dialog.tsx`, `components/capture-editors.tsx`, `components/task-editor.tsx`, `components/planning-editors.tsx`, `db/schema.ts`; append migration.

- [ ] Add owner-scoped server drafts with `{draftId, editorKind, targetId, baseRevision, changedFields, commandCandidate, updatedAt, expiresAt, draftRevision}`. Draft writes use their own draft revision; they do not claim an application mutation or increase the planning revision. Use a one-second debounce, explicit saved-draft status and a 30-day default retention shown in settings. A draft is not a task and never enters recommendations.
- [ ] Expose authenticated same-origin JSON draft CRUD with strict schemas and 64 KiB per draft/100 drafts per owner. Session reauthentication recovers only that same owner's server drafts. Saving a command acknowledges/deletes its draft only after the committed receipt is confirmed; failures retain it.
- [ ] Default to in-memory offline drafts. Offer an explicit trusted-device option for IndexedDB draft/outbox persistence, with the explanation that anyone who can access the browser profile or execute app-origin code may read it. Do not describe a JavaScript-stored encryption key as protection against that access. Native device encryption can be recommended in product help but is not an application guarantee.
- [ ] Define outbox states `draft`, `queued`, `sending`, `uncertain`, `conflict`, `committed`, `failed`. Each queued item stores owner-scoped device namespace, original base revision, exact command, stable mutation ID and creation time. Queueing and sending are explicit user actions; connectivity restoration does not silently submit stale work. Display pending count and allow inspect/export/discard before replay.
- [ ] On explicit logout or forget-device, remove that owner's IndexedDB records, blob caches, memory state and cross-tab state before navigation; broadcast invalidation to other tabs. On 401, hide private content and stop writes. Reauthentication must prove the same server owner before unsealing any opted-in namespace; a different owner cannot view or replay it. Never expose authenticated owner IDs in sharable exports.
- [ ] Add tests for debounce, concurrent draft saves, logout while request is pending, different owner on same browser, two tabs, quota denial, unsupported IndexedDB, offline tab closure with opt-in on/off, interrupted replay and server-draft expiry. Verify pending drafts/outbox cannot masquerade as saved planning state.
- [ ] Run `node --experimental-strip-types --test tests/drafts.test.ts tests/device-outbox.test.ts`, then typecheck. Record browser-storage privacy behavior in `docs/operations/privacy.md`; commit the slice.

## Task 5: Versioned bundles, quarantine and safe repair

**Files:** create `lib/workspace-export.ts`, `lib/import-quarantine.ts`, `components/import-review.tsx`, `app/api/workspace/imports/route.ts`, `app/api/workspace/imports/[importId]/route.ts`, `tests/workspace-export.test.ts`, `tests/import-quarantine.test.ts`; modify `components/sources-view.tsx`, `lib/workspace-validation.ts`, `db/schema.ts`; append migration.

- [ ] Implement the module registry and `WorkspaceBundle` contract above. Build a consistent owner-command snapshot by reading the shared revision before and after all registered module reads and retrying when changed. Capture independent operational stream watermarks and export only rows valid at those points, or retry mutable operational snapshots when their own versions change. Use bounded pagination; never mix owner-command revisions or imply all operational streams share one global revision. Record watermarks, source hashes, export completeness and included/missing/excluded attachment bytes explicitly.
- [ ] Register core planning and audit-event exports. Phase 2 and 3 add their named adapters; later integrations export user-visible provenance/configuration without exporting credentials. Schema upgrades are explicit per module; old JSON exports remain importable through the migration chain.
- [ ] Add bounded import staging with immutable content hash, expiry and owner. Parse inside limits, produce diagnostics by path/code, and retain invalid content in quarantine for recovery/download. Quarantine is separate from active planning and never runs commands or links automatically. Do not store raw invalid content in diagnostics logs.
- [ ] Preview includes before/after record counts, new/deleted/changed identities, module versions, dangling references, attachment completeness, target revision and backup availability. Derive the final restore command from the server-held parsed preview/hash, not a client-edited summary. Revalidate on commit.
- [ ] Supply explicit repair operations: choose a supported migration, map an orphan project/milestone reference, remove a broken dependency, resolve duplicate IDs with propagated references, or exclude a selected invalid record into an attached repair report. Each repair is a new preview with a visible diff. Never invent completion dates, silently drop modules, remove evidence or mark acceptance.
- [ ] Restore the planning document and every registered module atomically through `executeWorkspaceCommand`, with the append/merge-only exception for the audit ledger described above. The pre-restore recovery bundle covers normalized modules and actual attachment bytes or pins verified immutable objects needed for recovery; a document-only snapshot cannot justify replacing evidence/attachments. Preserve current receipts and operational history; importing old receipt/job/auth tables is forbidden. Record a restore event referring to the recovery snapshot and import hash. Large row imports use bounded bulk statements/staging under verified D1 limits, not independently committed chunks.
- [ ] In that same restore transaction, advance the workspace execution epoch, invalidate active execution approvals, cancel pending intents targeting replaced records, persist cancellation requests for active attempts and pause schedules. Runner claims/retries check the epoch and current approval before dispatch. A running external effect cannot be rolled back by restoring planning data: retain its audit/result record and reconcile actual process exit/outcome, without automatic redispatch or a false cancellation success. Imported schedules start disabled and imported approvals are never authority. Reconcile targets and current authorization before resuming schedules; an unchanged internal backup policy may resume after verified restore completion against the new current state, without requiring an external-execution approval. Test a claimed job racing restore and a delayed old approval arriving after restore.
- [ ] Test old v1/v2 exports, v3/v4 chains after phase 2, unknown bundle/module versions, invalid UTF-8/JSON, zip traversal when attachment archives arrive, excessive decompression, orphan cross-module references, repair cancellation, stale preview, failure after some prepared writes and repeating the same restore ID. Assert no active change before the final action and one revision increment for a successful restore.
- [ ] Run `node --experimental-strip-types --test tests/workspace-export.test.ts tests/import-quarantine.test.ts tests/reliability-validation.test.ts`. Commit with real fixtures and a documented bundle schema in `docs/data/workspace-bundle.md`.

## Task 6: Archive, permanent removal and multiple recovery snapshots

**Files:** create `lib/workspace-backups.ts`, `lib/backup-storage.ts`, `components/backup-history.tsx`, `components/delete-record-dialog.tsx`, `app/api/workspace/backups/route.ts`, `app/api/workspace/backups/[backupId]/route.ts`, `tests/backups.test.ts`, `tests/deletion-recovery.test.ts`; modify `components/sources-view.tsx`, `lib/workspace-handlers.ts`, `db/schema.ts`, `.openai/hosting.json`, `cloudflare-env.d.ts`; append migration.

- [ ] Define `BackupManifest` with `{id, ownerScope, sourceRevision, reason, createdAt, formatVersion, bytes, sha256, storageKind, storageKey, status, expiresAt, completeModules, missingAttachments}`. Status is `preparing`, `ready`, `failed` or `expired`; only verified complete bytes become `ready`. Import the existing `workspace_recovery` row as a historical backup without deleting the original during rollout.
- [ ] Implement D1 fallback snapshots for structured bundles including every registered normalized module, retaining up to 10 recovery snapshots within a 20 MB owner budget and verified platform row/statement limits. Large bundles may use immutable staged chunks plus a checksummed manifest; the manifest and protected revision commit atomically. Once attachments exist, fallback recovery also pins available immutable blob objects or rejects destructive changes when their bytes cannot be recovered. If a new destructive operation cannot first retain a complete recovery snapshot, reject it and explain storage recovery options. Do not silently delete a pinned/manual snapshot to make room.
- [ ] Implement `BackupStorage` methods `put`, `get`, `head` and `delete` for proposed private R2 `BUCKET`, gated on actual configured binding. Verify object length/hash before marking ready. D1+R2 is not one transaction: prepare and verify the immutable object first, then commit its manifest with the protected source revision; if a concurrent edit changes that revision, repeat snapshot preparation. Garbage-collect orphan objects only after the recovery grace period.
- [ ] Add multiple manual exports/snapshots and recovery history with counts, date/revision, reason and completeness. Default R2 scheduled retention is 14 daily and 8 weekly complete snapshots; manual/pinned snapshots are retained until explicitly removed or a configured quota blocks new creation. Never describe a manifest-only export as an attachment backup.
- [ ] Add `entity.delete` commands only for archived records, with preview of dependent tasks, captures, evidence and links. Reject deletion while active references remain; offer explicit reassign/unlink/archive operations first. Store the full prior bundle or reversible deletion payload before removal. Phase 2 supplies project/milestone archive support and phase 3 supplies evidence/attachment cleanup adapters. Restoring a deleted record checks current IDs/references and does not overwrite newer work silently.
- [ ] Test delete failure without backup, protected reference rejection, stale deletion preview, receipt replay, restored identity collision, manual snapshot pinning, R2 write succeeded/manifest commit failed, hash mismatch, missing object, missing binding and the latest-single-snapshot migration. Confirm archive retains capacity while permanent removal reduces it only after successful backup.
- [ ] Run `node --experimental-strip-types --test tests/backups.test.ts tests/deletion-recovery.test.ts tests/workspace-transaction.test.ts`. Leave R2-dependent acceptance marked unavailable until a real isolated bucket test passes; commit adapters and fallback independently of provisioning.

## Task 7: Scheduled backup job contract and bounded receipt retention

**Files:** create `lib/backup-jobs.ts`, `lib/idempotency-retention.ts`, `app/api/workspace/backup-policy/route.ts`, `tests/backup-jobs.test.ts`, `tests/idempotency-retention.test.ts`; modify `lib/workspace-handlers.ts`, `lib/workspace-transaction.ts`, `db/schema.ts`, `components/backup-history.tsx`; append migration. Scheduler entry points belong to the integration/job phase, not a guessed Sites cron configuration.

- [ ] Persist owner backup policy `{enabled, timezone:'Africa/Cairo', dailyLocalTime:'03:00', weeklyDay:'Monday', retentionDaily:14, retentionWeekly:8, lastSuccessAt, lastFailureCode, nextDueAt}`. Scheduling uses actual timezone conversion across DST, not a constant UTC offset. Settings display `unavailable`, `configured`, `healthy`, `delayed` or `failed`, based on delivered jobs and verified objects.
- [ ] Expose the proposed internal `runBackupJob({userId, scheduledFor, jobId}, deps)` handler with a unique owner/schedule dedupe key. It consumes committed job intents and creates a consistent bundle. The verified job runner supplies authenticated service identity and owner scope; an anonymous public endpoint must never trigger arbitrary-owner backups.
- [ ] Test missed runs, duplicate delivery, backoff, executor crash, partial upload, quota exhaustion and retention deletion after a new complete snapshot. Deleting an old snapshot requires a newer verified recovery point and must never remove the only usable snapshot.
- [ ] Keep existing UUID-format receipts indefinitely as minimal tombstones. Do not delete old receipts and then treat a retry as a new command. For newly issued IDs, add server-issued epoch namespace `m1_<epoch>_<random>` and persist active/retired epochs per owner. Retirement first records the rejecting epoch tombstone; only then may detailed receipts for that epoch be compacted. A delayed retry from a retired epoch receives `retired` and must not execute.
- [ ] Surface receipt/snapshot/module usage separately from document usage. Soft-limit warnings do not discard evidence or receipts. A hard limit returns a typed capacity error before any partial command writes. Restoring an old workspace must not reset epochs or resurrect consumed commands.
- [ ] Test old UUID replay after workspace restore, new epoch replay before/after compaction, retirement concurrent with a command, active outbox containing a retiring epoch, different owner with same ID, and clock skew. Verify exactly-once effects are preserved even when an old success result is no longer available.
- [ ] Run `node --experimental-strip-types --test tests/backup-jobs.test.ts tests/idempotency-retention.test.ts`. Commit the handlers and policy; link scheduling acceptance to the integration phase and release matrix instead of claiming schedules run from a local timer.

## Task 8: Auth/privacy boundaries and accurate operational documentation

**Files:** modify `app/chatgpt-auth.ts`, `app/api/workspace/route.ts`, `components/control-center.tsx`, `components/session-state.tsx`, `README.md`, `docs/verification.md`, `docs/superpowers/verification/2026-10-17-reliability-baseline.md`; create `docs/operations/privacy.md`, `docs/operations/recovery.md`, `docs/data/workspace-bundle.md`, `tests/auth-boundaries.test.ts`.

- [ ] Apply the existing trusted Sites identity mechanism to new browser-owner APIs. Never accept owner/user identity in a body, URL or client-supplied authenticated header as authority. Verify the deployment gateway strips or overwrites identity headers and prevents direct origin bypass; local mocks cannot prove this production boundary. Background/device APIs instead require verified private-service ingress plus a registered scoped principal mapped to the owner, as defined in phases 4–7; a service bearer alone must not be treated as a visitor identity.
- [ ] Keep browser mutations same-origin, JSON-only and size-bounded; use private/no-store responses for document, drafts, outcome, backup and attachment routes. Service/device callers use their separate authentication/replay controls and do not forge a browser Origin or authenticated-user header. Validate same-origin return paths. Avoid adding passwords, WebAuthn registration or passkey storage inside this app; Sites/ChatGPT sign-in remains the owner-controlled identity boundary.
- [ ] Add owner-isolation, missing-session, expired-session, cross-origin, malformed content, injection-shaped IDs, response-cache and sanitized-diagnostics tests for the new route families. Check no private content remains rendered after 401 and no background replay continues.
- [ ] Document draft retention/device storage behavior, snapshot limits, recovery/export steps, receipt retirement semantics, import quarantine and unresolved-hosted states. Preserve dated earlier verification facts; append a dated reconciliation rather than rewriting historical claims as if they were newly tested.
- [ ] Run the complete `npm test`, `npm run typecheck`, `npm run lint`, then `npm run build` sequentially after code integration. Add recovery browser regressions at `tests/e2e/recovery.spec.ts` using Task 0's phase-1 harness and `npm run test:e2e` script; phase 8 extends that harness and must not invent a second browser test directory/runner. Record exact counts, environment, commit and limitations. Obtain independent code review focused on cross-table atomicity and recovery; resolve actionable findings before declaring this phase implemented.

## Phase 1 acceptance and handoff

- [ ] An unchanged uncertain save produces one committed effect across every module; a stale or rejected change produces none.
- [ ] The legacy capacity fixture loads, exports, restores and accepts a reducing edit without losing records or inventing history.
- [ ] Server drafts and opt-in offline queue are visibly distinct from saved planning data; owner change/logout clears local private state.
- [ ] Invalid or incomplete imports remain quarantined and reversible; successful restore covers all registered modules in one transaction.
- [ ] Destructive removal has a usable prior recovery point, and backup history contains multiple independently retrievable snapshots.
- [ ] Scheduled backup acceptance is complete only after the verified scheduler/R2 path runs; absent infrastructure is explicitly unavailable, not silently simulated.
- [ ] Phases 2–7 receive the protocol, module registry, bundle versions, audit event contract and fixture helpers. Phase 8 receives the real commands, failure fixtures and known unavailable hosted/device checks.

The cloud executor may implement and verify local parts without Windows, an authenticated Sites browser or a physical device. It must record those missing checks as unavailable/owner-dependent and continue other independent work; it must not mark the entire phase verified merely because the local suite passes.
