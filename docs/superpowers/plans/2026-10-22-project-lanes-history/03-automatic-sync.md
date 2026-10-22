# Automatic Collection, Catch-up and Freshness Implementation Plan

> Depends on Chapter 1 storage and at least one Chapter 2 reader. Continue against synthetic adapters while unavailable cloud sources retain explicit open gates.

**Goal:** New and resumed conversations reach persistent area processing without manual refresh, surviving missed events, restart and offline periods.

**Architecture:** An explicitly installed read-only local collector emits durable `CollectionPage` batches to owner-scoped ingestion. Supported cloud adapters use a separately verified renewable runner. Both reuse the single Chapter 1 job substrate, immutable storage, epoch/CAS and acknowledgement contracts; neither mutates planning acceptance.

**Tech Stack:** Node 24, protected per-user filesystem spool, Windows Task Scheduler, authenticated HTTPS transport, D1 job leases and the supported hosting scheduler.

## Task A1 — Durable local spool and checkpoints

**Create:** `collector/package.json`, `collector/src/cli.mjs`, `collector/src/config.mjs`, `collector/src/spool.mjs`, `collector/src/checkpoints.mjs`, `collector/test/spool.test.mjs`, `collector/test/checkpoints.test.mjs`.

- [ ] Add explicit configure/import/run/status commands with selected source roots and `history.read`/`history.ingest` scope. Keep credentials separate from configuration and protect private spool/checkpoint files for the current user. Do not reuse/widen PC telemetry payload permissions.
- [ ] Persist the Chapter 1 CollectionEnvelope, canonical envelope digest, object manifest and previous/next cursor before sending. Match IngestReceipt source/epoch/scopeRevision/pageId/digest before acknowledging. Write via temporary file plus atomic rename and durable flush where supported; recover interrupted writes without accepting corrupt entries.
- [ ] Advance acquisition checkpoint only after durable spooling; advance remote acknowledged checkpoint only after a matching durable server receipt. Keep both checkpoints so network loss never requires guessing whether content was delivered.
- [ ] Bound disk bytes/entries with visible backpressure. Never silently evict unacknowledged history. On full disk pause acquisition, retain the last checkpoint and report the catch-up required; telemetry-style dropping is unsuitable.
- [ ] Test crash before rename, corrupt spool entry, restart, full disk, lost ack and repeated page ID with changed bytes. Run `node --test collector/test/spool.test.mjs collector/test/checkpoints.test.mjs`; expect exact replay and no acknowledged data loss. Commit `feat: add durable history collector spool`.

## Task A2 — Read-only incremental discovery and catch-up

**Create:** `collector/src/watch.mjs`, `collector/src/reconcile.mjs`, `collector/test/reconcile.test.mjs`, `tests/history-incremental.test.ts`.

- [ ] Use watchers/hooks only as low-latency hints. Startup and periodic inventory reconciliation are authoritative; rescan on overflow, dropped watcher events and restart. Optional provider hooks must only enqueue a bounded dirty hint, never block source usage or execute chat instructions.
- [ ] Track stable file identity, length, last complete record offset, prefix/fingerprint and reader version. Reopen truncated/replaced/compressed files safely; do not seek using decompressed offsets in compressed bytes. Reparse affected segments with idempotent identities when necessary.
- [ ] Discover new conversations and updates to old/resumed conversations, archived files, subagent segments and changed attachments. Modified-time alone is insufficient: periodic fingerprint/inventory checks catch preserved timestamps and out-of-order writes.
- [ ] Resolve a previously unavailable transcript/gap by appending resolution provenance; preserve old observations. Recompute coverage and enqueue affected area analysis at the committed source watermark, coalescing repeated dirty hints without losing updates.
- [ ] Define measurable configured reconcile interval and maximum catch-up lag; initial defaults may be 5-second hint debounce and 5-minute full metadata sweep, then tune from bounded real measurements. Large scans continue in pages rather than blocking all sources.
- [ ] Test missed watcher, resumed old chat, preserved mtime, duplicate hint, truncate/rotate, offline restart, partial final JSONL and newly available segment. Run `node --test collector/test/reconcile.test.mjs` and `node --experimental-strip-types --test tests/history-incremental.test.ts`; commit `feat: reconcile incremental history after missed events`.

## Task A3 — Authenticated transport and atomic acknowledgement

**Create/reuse:** `collector/src/transport.mjs`, `collector/src/credentials.mjs`, `app/api/history/ingest/route.ts`, `app/api/history/objects/route.ts`, `lib/history/ingest-auth.ts`, `collector/test/transport.test.mjs`, `tests/history-ingest-auth.test.ts`, `tests/history-ingest-api.test.ts`.

- [ ] Reuse existing enrollment/device infrastructure if actually present; otherwise implement the minimum owner-approved enrollment with one-time expiring secret, hashed scoped credential, rotation/revocation and server-mapped owner/source permissions. Private Sites service ingress and application authorization are separate gates.
- [ ] Upload immutable objects with bounded streaming/checksums, finalize them, then submit the exact validated CollectionEnvelope. Its server-issued epoch/scopeRevision and entire-envelope digest use the Chapter 1 contract. Credentials stay in OS-protected storage; never log raw bodies, tokens, prompts or private paths. Explicitly classify typed diagnostics locally.
- [ ] Use bounded timeout, exponential backoff/jitter and `Retry-After`; retry uncertain outcomes with identical page ID/digest. Read acknowledgement before reacquiring the next page. Concurrent sender leases/epochs prevent a stale process from advancing a newer stream.
- [ ] Server returns a receipt only after Chapter 1 transaction commits. Duplicate matching page returns original receipt; changed digest returns conflict; unexpected previous cursor returns reconcile-needed; revoked/wrong-scope/old-epoch requests cannot write objects or metadata.
- [ ] Test foreign owner/source, revocation during upload, expired credential, oversized page, finalized-object mismatch, stale epoch, CAS loser leaving zero side rows, lost response and retry. Run `node --test collector/test/transport.test.mjs` and `node --experimental-strip-types --test tests/history-ingest-auth.test.ts tests/history-ingest-api.test.ts tests/history-storage.test.ts`; commit `feat: ingest history through scoped replay-safe transport`.

## Task A4 — Renewable cloud scheduling and continuation

**Create/reuse:** `lib/history/scheduler.ts`, `lib/history/sync-runner.ts`, `app/api/history/sync/route.ts`, `tests/history-scheduler.test.ts`, `tests/history-sync-runner.test.ts`, `docs/implementation/project-lanes-history/unattended-access.md`.

- [ ] Extend the single job substrate with `history_import`/`history_reconcile`; do not create a second queue. One stable occurrence key, owner/source/scope epoch, lease generation and retry state govern each run. Record attempted/success times and continuation cursor separately.
- [ ] Gate scheduling on `SourceCapability.unattendedRead` plus current credential proof. Interactive tools, a saved schedule, CLI fixture success or browser cookies do not enable this gate. Unsupported cloud rows stay visible and independent local work continues.
- [ ] Bound each attempt initially to 5 pages/20 seconds and page codec limits; commit each successful page before continuation. Lease expiry resumes the committed cursor; duplicate delivery and scheduler overlap cannot produce duplicate work or accepted planning facts.
- [ ] On partial failure preserve last good content and committed cursor; distinguish page success from complete sweep success. Renewal failure disables further attempts until revalidated and reports access limitation. Pause/disconnect/restore invalidate execution epochs and prevent stale queued jobs from running.
- [ ] Test two runners competing, lease expiry, fresh occurrence deduplication, continuation across restart, expired principal, unsupported provider and restore-paused queue. Run `node --experimental-strip-types --test tests/history-scheduler.test.ts tests/history-sync-runner.test.ts`; commit `feat: schedule capability-gated history reconciliation`.

## Task A5 — Coverage, freshness and meaningful change signals

**Create:** `lib/history/freshness.ts`, `lib/history/change-events.ts`, `app/api/history/status/route.ts`, `tests/history-freshness.test.ts`, `tests/history-change-events.test.ts`.

- [ ] Project Chapter 1 `CoverageSnapshot` from committed data. Expose collector heartbeat, last attempt, last successful inventory/content sweep, current continuation, next due, oldest pending spool item and typed failure separately. A heartbeat or successful HTTP request cannot make incomplete history current.
- [ ] Define deterministic precedence for error/stale/partial/syncing/current/unverified, with complete status requiring verified inventory and content for the configured scope, no blocking gaps and freshness within policy. `current` is a collection state, never project completion.
- [ ] Emit source-watermark change events only after commit; analysis consumes them idempotently and catches up from its own watermark. UI refresh/polling is merely display delivery. A dirty editor must not be overwritten by operational history updates.
- [ ] Track per-source discovered/complete/partial/unavailable, segment/attachment gaps, scope exclusions, sync lag and unattended proof date. Denominators refer to discovered retained inventory; unknown account history stays unknown. Reconciliation resolves stale errors only after the corresponding successful sweep.
- [ ] Test failed refresh preserving last success, fresh heartbeat with stale content, partial cloud inventory, clock skew, offline device, repeated unchanged import and analysis restart. Run `node --experimental-strip-types --test tests/history-freshness.test.ts tests/history-change-events.test.ts tests/history-coverage.test.ts`; commit `feat: report honest history freshness and catch-up state`.

## Task A6 — Install and prove actual unattended operation

**Create:** `collector/windows/install-task.ps1`, `collector/windows/uninstall-task.ps1`, `collector/windows/protect-credential.ps1`, `docs/implementation/project-lanes-history/collector-operations.md`, `docs/verification/project-history-sync.md`.

- [ ] Package the current-user Windows scheduled task with explicit paths, version, restart/backoff, single-instance behavior and protected credential access. Install only after explicit source/enrollment configuration; uninstall stops collection while preserving retained evidence unless removal is separately requested.
- [ ] Use an actual supported hosted scheduler/service principal for cloud sources. Record its deployment identity, schedule, renewable authentication, logs/receipts and revocation test without secrets. A development terminal loop is not unattended deployment.
- [ ] Prove local flow: initial import → close development terminal/browser → new/resumed conversation update → scheduled collector starts → durable hosted receipt → readback and updated source watermark. Restart the collector/device, interrupt network, reconnect and verify no gaps/duplicates. Do not initiate source messages merely to manufacture evidence without owner authorization; use an authorized existing/resumed activity or owner-produced update.
- [ ] Prove each enabled cloud source with a fresh runner and actual subsequent update; leave unavailable sources explicitly open with exact missing interface/access. PC-off local freshness must become stale/offline while independent cloud runs continue.
- [ ] Run `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, all explicit collector tests and the new focused suites. Record count/results, actual source scope, versions, receipt IDs and measured latency with private evidence stored outside the public repo. Commit `docs: record unattended history synchronization evidence`.

## S3 gate

Implemented requires spool/replay, restart, CAS/isolation, missed-event and freshness tests passing. Verified unattended requires the real installed collector or hosted fresh runner to deliver a subsequent update with the development terminal/browser closed. Full requested automatic coverage requires all four source classes; manual imports and unsupported cloud APIs leave their rows open. Record these separately in `progress.json`; do not block independent synthesis/UI implementation on an unavailable source.
