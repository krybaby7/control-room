# Foundation and History Contracts Implementation Plan

> **For agentic workers:** Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` when available. Execute the checkboxes and record evidence.

**Goal:** Establish compatible area classification, immutable history identity, reliable storage and honest coverage before parallel readers and UI work.

**Architecture:** Keep small owner-authored planning records in the existing workspace document. Store growing history, citations, operational cursors and story snapshots in normalized owner-scoped modules. Extend the current durable mutation boundary; never create a competing planning writer.

**Tech Stack:** TypeScript, strict Zod validation, existing D1/Drizzle/SQLite helpers, Node 24, private R2.

## Task F1 — Establish the actual baseline

**Read:** `AGENTS.md`, `package.json`, `.openai/hosting.json`, `lib/types.ts`, `lib/planning.ts`, `lib/workspace-validation.ts`, `lib/workspace-store.ts`, `lib/workspace-client.ts`, `app/api/workspace/route.ts`, `db/schema.ts`, `tests/helpers/sqlite.ts` and the older foundation/recovery plan.

**Create:** `docs/implementation/project-lanes-history/baseline.md` and `docs/implementation/project-lanes-history/capabilities.md`.

- [ ] Record actual checkout/branch/SHA, package scripts, Node version and available D1/R2/runtime bindings. Record which previously planned modules actually exist. Do not expose credentials.
- [ ] Run the baseline commands from the master plan. Record failures before changing behavior.
- [ ] Choose an isolated synthetic owner/database for migration and recovery tests. Inspect production only through authorized read/export paths; never restore or reseed it for a test.
- [ ] Record four separate source capabilities: `codex_local`, `codex_cloud`, `claude_code_local`, `claude_code_cloud`, including account/device scope, inventory/read/automatic support, proof, and limitations.
- [ ] Commit the sanitized baseline notes with `docs: record project history implementation baseline`.

## Task F2 — Planning areas and task classification

**Modify:** `lib/types.ts`, `lib/planning.ts`, `lib/workspace-validation.ts`, `lib/seed.ts`, `lib/project-baselines.ts`, `components/planning-editors.tsx`, `components/task-editor.tsx`, `components/capture-editors.tsx`, `components/control-center.tsx`, `components/ui.tsx`.

**Create:** `lib/areas.ts`, `tests/areas.test.ts`, `tests/history-migration.test.ts`.

Use these proposed records, adapting the transport envelope to any existing implemented contract:

```ts
export type WorkType = 'planning' | 'implementation' | 'testing' | 'review' |
  'research' | 'decision' | 'operations' | 'other';
export interface ProjectArea {
  id: string;
  projectId: string;
  name: string;
  aliases: string[];
  order: number;
  archivedAt: string | null;
}
export interface TaskClassification {
  areaId: string | null;
  workType: WorkType;
}
```

Add `areas: ProjectArea[]` to `Workspace` and the classification fields to `TaskInput`. New records use explicit owner choices; legacy tasks migrate to `areaId: null`, `workType: 'other'` unless an owner accepts a proposed mapping. UI label for null area is `Unclassified`. Do not guess from title during migration. Seed/example labels are suggestions, not accepted historical classification.

At the inspected v2 baseline allocate planning schema v3 for this change. If another branch has already allocated v3, use the next actual version and record the mapping; update all codecs/tests/export versions together. The older program's proposed v3/v4 numbering is not evidence those schemas shipped. Preserve original IDs, timestamps, dependencies, archived completion fields, weekly metadata and baseline markers.

- [ ] Add migration behavior tests for v1/v2, current-version round trip, null classification, invalid cross-project area, archived area references and maximum-size legacy documents. Assert every legacy task field survives.
- [ ] Allocate migration headroom: increase the bounded planning document limit from 1,000,000 to 1,500,000 UTF-8 bytes for the new schema, updating validators, request limits and error copy together. Keep legacy input validation at its original bound before normalization; never truncate to fit. Limit areas to 100 per project/1,000 total, names to 120 characters and aliases to 10 names. Test a near-limit v2 document through migration, ordinary edit and export/restore so added defaults cannot strand it. If deployed platform limits differ, record a compatible storage solution before freezing the migration.
- [ ] Run `node --experimental-strip-types --test tests/history-migration.test.ts tests/areas.test.ts`; expect failure until the migration and commands exist.
- [ ] Implement `area.create`, `area.update`, `area.archive`, `area.restore` using the same command validation and receipt boundary as existing edits. Reject duplicate normalized names within one project. Renaming preserves ID/aliases. Archiving preserves task/history links. Do not hard-delete areas in this release.
- [ ] Implement classification through `task.create`/`task.update`, editor defaults, capture conversion, search and baseline proposals. Reject missing/foreign-project area IDs. A task moved to another project must explicitly reclassify or become unclassified.
- [ ] Run focused tests and typecheck; commit `feat: add stable project areas and task types`.

## Task F3 — Freeze shared history contracts

**Create:** `lib/history/contracts.ts`, `lib/history/validation.ts`, `tests/history-contracts.test.ts`.

These are new implementation contracts. Keep field names consistent across chapters; version any later change.

```ts
export type HistorySourceKind = 'codex_local' | 'codex_cloud' |
  'claude_code_local' | 'claude_code_cloud';
export type Availability = 'complete' | 'partial' | 'unavailable';
export interface SourceCapability {
  sourceId: string;
  kind: HistorySourceKind;
  scopeLabel: string;
  inventory: 'verified' | 'partial' | 'unsupported' | 'unverified';
  contentRead: 'verified' | 'partial' | 'unsupported' | 'unverified';
  unattendedRead: boolean;
  verifiedAt: string | null;
  proofRef: string | null;
  limitation: string | null;
}
export interface ConversationRecord {
  id: string;
  sourceId: string;
  nativeThreadId: string;
  sessionTreeId: string | null;
  parentConversationId: string | null;
  title: string | null;
  projectId: string | null;
  repositoryIdentity: string | null;
  branch: string | null;
  createdAt: string | null;
  sourceUpdatedAt: string | null;
  archived: boolean | null;
  availability: Availability;
}
export interface MessageRevision {
  id: string;
  conversationId: string;
  nativeMessageId: string;
  revisionDigest: string;
  parentNativeMessageId: string | null;
  sequence: number;
  role: 'user' | 'assistant' | 'tool' | 'system';
  occurredAt: string | null;
  observedAt: string;
  bodyObjectKey: string;
  contentBytes: number;
  availability: Availability;
}
export interface Citation {
  messageRevisionId: string;
  revisionDigest: string;
  start: number;
  end: number;
}
export interface HistoryGap {
  id: string;
  sourceId: string;
  conversationId: string | null;
  kind: 'inventory' | 'missing_transcript' | 'missing_segment' |
    'truncated_content' | 'attachment' | 'parse' | 'access' | 'scope';
  explanation: string;
  detectedAt: string;
  resolvedAt: string | null;
}
export interface CoverageSnapshot {
  sourceId: string;
  scopeLabel: string;
  inventoryComplete: boolean;
  contentComplete: boolean;
  discovered: number;
  complete: number;
  partial: number;
  unavailable: number;
  unresolvedGaps: number;
  lastInventorySuccessAt: string | null;
  lastContentSuccessAt: string | null;
  status: 'unverified' | 'syncing' | 'current' | 'partial' | 'stale' | 'error';
}
export interface CollectionPage {
  codecVersion: 1;
  sourceId: string;
  runId: string;
  pageId: string;
  previousCursor: string | null;
  nextCursor: string | null;
  inventoryExhausted: boolean;
  conversations: ConversationRecord[];
  messages: MessageRevision[];
  segments: HistorySegment[];
  attachments: HistoryAttachment[];
  gaps: HistoryGap[];
  objectManifest: Array<{ key: string; sha256: string; bytes: number }>;
}
export interface HistoryAdapter {
  capability(): Promise<SourceCapability>;
  readPage(cursor: string | null, signal: AbortSignal): Promise<CollectionPage>;
}
export interface CollectionEnvelope {
  protocolVersion: 1;
  epoch: string;
  scopeRevision: number;
  page: CollectionPage;
}
export interface IngestReceipt {
  sourceId: string;
  epoch: string;
  scopeRevision: number;
  pageId: string;
  pageDigest: string;
  committedCursor: string | null;
  watermark: string;
  committedAt: string;
}
export interface AreaStory {
  id: string;
  projectId: string;
  areaId: string;
  planningRevision: number;
  sourceWatermark: string;
  generatedAt: string;
  finished: Array<{ text: string; citations: Citation[]; claimIds: string[]; basis: 'observed' | 'inferred' | 'accepted'; acceptanceRef: string | null }>;
  open: Array<{ workItemId: string; text: string; citations: Citation[] }>;
  next: Array<{ text: string; citations: Citation[]; taskId: string | null }>;
  unknowns: string[];
  contradictions: string[];
}
export interface HistorySegment {
  id: string;
  sourceId: string;
  conversationId: string;
  nativeSegmentId: string;
  inheritedFromSegmentId: string | null;
  inheritedRange: { unit: 'bytes' | 'records'; start: number; end: number } | null;
  sha256: string | null;
  bytes: number | null;
  objectKey: string | null;
  availability: Availability;
  unavailableReason: string | null;
}
export interface HistoryAttachment {
  id: string;
  messageRevisionId: string;
  nativeAttachmentId: string | null;
  name: string;
  mediaType: string | null;
  sha256: string | null;
  bytes: number | null;
  objectKey: string | null;
  availability: Availability;
  unavailableReason: string | null;
}
```

Owner IDs are server-injected columns, never trusted from these wire records. `Citation.start/end` are half-open Unicode code-point offsets into the immutable normalized text, not byte or JavaScript UTF-16 offsets. Store the text-normalization version and digest; validate with `Array.from(text).slice(start,end)` for non-BMP characters. Missing source dates remain null. Provider system text is data, never executable instruction.

Segment ranges are half-open in the explicitly declared unit of the source segment. Complete content requires verified bytes; missing/inaccessible references have null digests/object keys and an explanation. Do not omit segments/attachments from `contentComplete`. Use provider IDs for identity where available; do not merge chats by title or by shared session-tree ID. Hash fallback identities from immutable source location plus record identity and preserve alias proofs. An accepted story entry requires a resolvable acceptanceRef; its citation array may be empty for an owner-authored acceptance, while observed/inferred entries require retained citations or claimIds resolving verified supporting snapshots, and a null acceptanceRef.

Adapters return CollectionPage; the collector/runner wraps it in CollectionEnvelope using the enrolled source's server-issued epoch and scope revision. Authenticate first, then match both fields against current source configuration. The canonical receipt digest covers the entire envelope, not bearer credentials. Changed epoch/scope invalidates old packets and leases; same-envelope replay returns the original IngestReceipt. Scope changes require a new inventory generation and may not carry forward an exhausted cursor as completeness proof.

Before declaring S1 contracts frozen, incorporate C1's source configuration/inventory membership contracts, Chapter 4's `SourceContext`, `HistoryClaim`, `HistoryWorkItem`, `AreaProgress` and repository snapshot contracts, and F6's roadmap commands into the shared codecs and export registry. Contract design happens in S1; later chapters implement readers/projections against it. Version the wire codec for any subsequent incompatible change.

- [ ] Write strict codec tests: unknown enum/key, bad digest, negative count, foreign citation, invalid offset, null timestamp, duplicate source identity and message revision.
- [ ] Implement bounded transport validation; initial limits are 250 message revisions or 2 MiB metadata per page, with oversized bodies stored in separately verified chunks. Large records must be chunked or surfaced as gaps, never silently truncated.
- [ ] Expose capabilities independently from successful fixture parsing. A parser passing a test cannot set `unattendedRead: true`.
- [ ] Run `node --experimental-strip-types --test tests/history-contracts.test.ts`; commit `feat: define versioned history and coverage contracts`.

## Task F4 — Shared transaction, operational ingestion and private objects

**Modify:** `lib/workspace-store.ts`, `app/api/workspace/route.ts`, `db/schema.ts`, `cloudflare-env.d.ts`, `.openai/hosting.json` only through the verified Sites provisioning workflow.

**Create/reuse:** `lib/workspace-transaction.ts`, `lib/workspace-modules.ts`, `lib/history/store.ts`, `lib/history/object-store.ts`, `lib/background/job-store.ts`, `lib/background/job-runner.ts`, `tests/history-storage.test.ts`, `tests/history-object-lifecycle.test.ts`. Append the next real migration under `drizzle/`; do not alter applied migrations.

Minimum normalized tables (all keys/queries owner-scoped): `history_sources`, `history_conversations`, `history_segments`, `history_message_revisions`, `history_attachments`, `history_aliases`, `history_gaps`, `history_ingest_pages`, `history_cursors`, `history_sync_runs`, `history_claims`, `history_work_items`, `history_work_item_events`, `area_story_snapshots`. Reuse an existing equivalent table rather than duplicate it. Index source/thread identity, conversation/sequence, source/update time, owner/project/area, and open gaps/work items.

Reuse the older foundation's `executeWorkspaceCommand`/guarded-write shape if already implemented; otherwise extract that minimal shared boundary from current `mutateWorkspace`. Owner area/configuration/acceptance commands increment the planning revision with a durable receipt. Ingestion, cursor/lease changes and generated stories use separate operational sequence/CAS and never increment the editor revision.

In one ingestion transaction, conditioned on the same successful expected cursor/epoch:

1. Verify all object manifests have finalized private objects with matching digest/length.
2. Claim unique `(owner, source, epoch, pageId)` with a canonical page digest.
3. Insert immutable records and gaps; same identity+digest is a replay; same page ID with different digest is rejected.
4. Advance the cursor and operational watermark only if the page's previous cursor matches current state.
5. Record one durable acknowledgement. A lost response is retried using the same page ID/digest.

Use one `workspace_job_intents` substrate with typed `history_import`, `history_reconcile` and `area_analysis` extensions, or add these kinds to the existing substrate. Do not create independent task queues with competing lifecycle state.

- [ ] Add two-owner tests and the critical lost-CAS case: a losing page/owner command leaves **zero** related side rows, cursor advances, receipts or accepted facts.
- [ ] Implement parameterized conditional SQL/guarded writes using the existing SQLite/D1 abstraction. A zero-row UPDATE is not an error, so every related write must share its successful guard.
- [ ] Implement private object staging → digest verification → metadata finalization. Reconcile abandoned objects after a grace period; do not erase the last good version on failed replacement. Preserve private raw source snapshots separately from redacted analysis text, with explicit retention and export selections.
- [ ] Register a service/device principal restricted to its enrolled owner/sources. Private Site ingress authentication and application owner authorization must both be verified. No caller-supplied owner override and no raw credentials in the browser, logs or tables.
- [ ] Run `node --experimental-strip-types --test tests/history-storage.test.ts tests/history-object-lifecycle.test.ts` and existing storage tests; commit `feat: persist history with atomic ingestion and private objects`.

## Task F5 — Portable export/restore and removal

**Create/reuse:** `lib/workspace-export.ts`, `lib/history/export.ts`, `tests/history-export.test.ts`.

- [ ] Add a module manifest containing module version, planning revision, source watermarks, object digests, history selection and unavailable/excluded content. Export authoritative and operational streams at a consistent watermark.
- [ ] Preserve legacy planning-only JSON imports. Bundle restore stages and verifies all required objects/records before one final pointer/epoch switch; failed imports leave the old complete generation available.
- [ ] Export/restore never includes credentials, active leases, renewable tokens or runnable authorization. Restored integrations are paused/disconnected, stale packets from old epochs are rejected, and fresh enrollment/access validation is required before collection resumes.
- [ ] Separate disconnect from delete. Disconnect stops reads and keeps retained records. Explicit removal previews affected citations/stories, tombstones deleted observations and recomputes affected views; source deletion alone must not silently erase accepted planning decisions.
- [ ] Test same-owner recovery, different-owner import remapping, digest tampering, incomplete blobs, legacy JSON, disconnect and removal. Run `node --experimental-strip-types --test tests/history-export.test.ts`; commit `feat: include project history in portable recovery`.

## Task F6 — Minimal roadmap scope and explicit acceptance

**Create/reuse:** `lib/history/roadmap.ts`, `lib/history/roadmap-store.ts`, `tests/history-roadmap.test.ts`. **Integrator modifies:** shared command registration, `db/schema.ts`, the next unapplied migration and F5 export modules. Use already-implemented evidence requirements/acceptance records from the older program if present; do not create a competing acceptance system.

The current app has milestones and evidence text, but no area checkpoint scope or structured acceptance. Implement the minimum needed here, without requiring the older full evidence editor:

```ts
export interface RoadmapScope {
  id: string;
  projectId: string;
  areaId: string;
  revision: number;
  agreedAt: string | null;
  checkpoints: Array<{
    id: string;
    label: string;
    acceptance: string;
    mandatory: boolean;
    milestoneId: string | null;
    taskIds: string[];
  }>;
}
export interface CheckpointAcceptance {
  id: string;
  scopeId: string;
  scopeRevision: number;
  checkpointId: string;
  verdict: 'accepted' | 'reopened';
  reason: string;
  claimIds: string[];
  recordedAt: string;
}
export type RoadmapCommand =
  | { type: 'roadmap.set'; projectId: string; areaId: string; expectedScopeRevision: number | null; checkpoints: RoadmapScope['checkpoints'] }
  | { type: 'roadmap.agree'; scopeId: string; expectedScopeRevision: number }
  | { type: 'checkpoint.assess'; scopeId: string; expectedScopeRevision: number; checkpointId: string; verdict: CheckpointAcceptance['verdict']; reason: string; claimIds: string[] };
```

- [ ] Add tests for initially undefined scope, owner-authored two-checkpoint scope, explicit agreement, accepted/reopened checkpoint, duplicate mutation replay, stale scope revision, foreign-project task, and a criteria edit making an earlier assessment historical rather than current. Run `node --experimental-strip-types --test tests/history-roadmap.test.ts`; expect failure before implementation.
- [ ] Store owner-scoped scope versions and append-only assessments in `history_roadmap_scopes` and `history_checkpoint_assessments`, or adapt existing equivalent tables. Validate same-project milestone/tasks/area, nonempty label/criteria/reason, distinct IDs and a bounded checkpoint list (maximum 100 per area). Server supplies acceptance ID/time and authenticated owner.
- [ ] Register all three commands in the shared revision/receipt transaction. Scope edits create a new revision and clear current agreement; never rewrite historical acceptance or silently carry it onto changed criteria. A later owner assessment may cite prior evidence explicitly. Automated observations only attach claims; they cannot call acceptance commands.
- [ ] Treat existing completed tasks/achieved milestones as historical owner records. They do not create retrospective checkpoint acceptance or invented timestamps. A checkpoint can link them for review; preserve original task/milestone status until an explicit owner edit.
- [ ] Include scope versions/assessments in export/restore and source removal impact; accepted decisions survive removal of source bytes with a visible missing-evidence marker. Use receipt/audit references for new owner-completed tasks too, and label legacy records as recorded before structured acceptance.
- [ ] Rerun focused tests and storage/export tests; commit `feat: track area roadmap scope and explicit checkpoint acceptance`.

## Gate

S1 passes when F1–F6 preserve synthetic legacy data, all shared contracts are frozen, new records are owner-scoped/exportable, operational updates cannot mutate acceptance, and storage replay/CAS failure tests pass. It does not require live cloud-provider access. Record implemented and live-verification statuses separately in `progress.json`.
