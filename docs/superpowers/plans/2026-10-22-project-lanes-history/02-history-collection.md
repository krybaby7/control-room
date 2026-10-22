# Complete Available History Collection Implementation Plan

> Execute after Chapter 1 contracts are locked. Use bounded GPT-6.1 Sol reader workers with disjoint files; the integrator owns shared codecs, schema and migrations. This chapter implements readers, not source-chat execution.

**Goal:** Inventory and import all retained, readable history in the configured Codex/Claude Code local/cloud scope, with resumable pagination and explicit losses.

**Architecture:** Provider-specific read-only adapters emit the shared immutable page/manifest format; inventory and content reconciliation persist resumable cursors and visible gaps independently.

**Tech Stack:** Node 24 collector, TypeScript hosted adapters, strict versioned codecs, private object storage and shared operational CAS.

**Contracts:** Use Chapter 1 `SourceCapability`, `HistoryAdapter`, `CollectionPage`, immutable message revisions and operational ingestion unchanged. Successful parsing is not capability proof. A source's `contentComplete` includes required segments and attachment availability; an exhausted inventory alone cannot set it.

## Task C1 — Freeze scope, segment and attachment codecs

**Create:** `lib/history/source-scope.ts`, `lib/history/segments.ts`, `tests/history-source-scope.test.ts`, `tests/history-segments.test.ts`, `docs/implementation/project-lanes-history/collection-scope.md`.

- [ ] Inventory configured provider accounts, devices, roots, archived sources, accessible cloud surfaces and explicit exclusions. Persist stable source IDs and a private scope manifest; publish only sanitized scope labels and proof references. Inventory hints may discover missing transcripts but do not constitute transcript coverage.
- [ ] Integrator implements Chapter 1's `HistorySegment`/`HistoryAttachment` codec before readers depend on it, during the S1 contract freeze. Distinguish a referenced attachment from fetched and verified bytes. Future changes require a versioned codec update shared by collector and server.
- [ ] Define source configuration outside `SourceCapability`: selected roots/account/device, scope revision, parser/normalization version and exclusion policy. Do not insert secrets or private absolute paths into exported capability records. Add epoch-scoped inventory membership to distinguish current inventory from retained historical records; absence during a partial sweep is not deletion.
- [ ] Test scope change, archived inventory, unresolved inherited segment, foreign message attachment, unavailable attachment and unknown codec version. Preserve source dates as null where absent.
- [ ] Run `node --experimental-strip-types --test tests/history-source-scope.test.ts tests/history-segments.test.ts tests/history-contracts.test.ts`; expect strict validation and no false complete coverage. Commit `feat: define history scope and segment manifests`.

## Task C2 — Codex local retained-history reader

**Create:** `collector/src/adapters/codex-local.mjs`, `collector/src/readers/jsonl.mjs`, `collector/src/readers/compressed-jsonl.mjs`, `collector/test/codex-local.test.mjs`, `collector/test/fixtures/codex/` with synthetic content only.

- [ ] Inspect installed version and metadata schemas using bounded approved discovery. Inventory conversation-bearing files and metadata, including retained archives/compressed segments. Do not recursively dump private transcript content into tools, logs or the repository.
- [ ] Stream JSONL and supported compressed JSONL with decompressed-byte, depth and record limits. Pin a dependency only if the installed Node runtime cannot decode the observed format; integrator owns lockfile changes. Reject corrupt streams as gaps without erasing earlier valid pages.
- [ ] Separate native thread ID from shared session-tree ID. Preserve continuation/fork/inherited lineage and segment order; resolve inherited ranges once, preserving their original message provenance. Do not assume a file or summary is a complete thread.
- [ ] Parse user/assistant/tool/system records and observed attachment references. Preserve raw source objects privately under explicit retention; generate deterministic normalized text/digests and code-point citation offsets. Unsupported records stay counted and attributable, not silently dropped.
- [ ] Handle partial trailing writes, missing dates, duplicate records, tool-result continuations and replacement files. Use source record identity plus stable location fallback; changing content produces a revision, not a new unrelated conversation.
- [ ] Test compressed multi-segment history, distinct threads sharing a session tree, inherited ranges, partial final line, corrupt compressed segment and missing attachment. Run `node --test collector/test/codex-local.test.mjs`; expect complete retained fixtures imported once and unresolved content represented as gaps. Commit `feat: collect retained Codex local history`.

## Task C3 — Claude Code local retained-history reader

**Create:** `collector/src/adapters/claude-code-local.mjs`, `collector/test/claude-code-local.test.mjs`, `collector/test/fixtures/claude-code/`.

- [ ] Inventory actual retained transcript stores and subagent/continuation files for configured roots. Compare with prompt/session indexes as hints; older index-only entries become unavailable conversation records plus `missing_transcript` gaps.
- [ ] Preserve UUID/parent lineage, subagent identity, compaction boundaries and continuation relationships. Compaction summaries do not replace accessible original messages. Keep observed order separate from absent source timestamps.
- [ ] Deduplicate repeated records by defensible native identity/revision; repeated identical prose in distinct messages remains distinct. Avoid merging by project-directory encoding, title or text. Record source aliases only with evidence.
- [ ] Reuse bounded JSONL, normalization and attachment handling from C2. Preserve unknown schema variants as parse gaps; expose parser version and affected counts.
- [ ] Test duplicates, subagents, compaction plus retained originals, older index-only entries, resumed sessions, Unicode citations and reordered records. Run `node --test collector/test/claude-code-local.test.mjs`; expect no invented recovered content or duplicated inherited messages. Commit `feat: collect retained Claude Code local history`.

## Task C4 — Prove cloud acquisition independently

**Create:** `lib/history/adapters/codex-cloud.ts`, `lib/history/adapters/claude-code-cloud.ts`, `lib/history/adapters/manual-import.ts`, `tests/history-cloud-adapters.test.ts`, `docs/implementation/project-lanes-history/cloud-capability-proof.md`.

- [ ] Revalidate current official interfaces and actual installed binaries. Record executable/version, account/workspace scope, inventory pagination, archive coverage, history pagination/segments, content limits, attachment support and authentication lifetime. The Oct 22 Codex desktop readable-chat versus bundled CLI empty-list mismatch must be reproduced or explained with sanitized IDs/counts. An empty CLI result cannot certify cloud inventory exhaustion.
- [ ] Prove Codex cloud inventory and content reads across all pages, including older history and inherited segments. Desktop tools are interactive evidence; they are not automatically a supported hosted/unattended API. No credential scraping or assumed endpoint.
- [ ] Investigate Claude Code cloud specifically. Compliance APIs excluding this source and ordinary Claude.ai exports do not satisfy it. Teleport fetches/checks out a branch and resumes a session: never execute it as an automatic read-only collector. Any separately authorized manual acquisition must disclose effects and retain provenance.
- [ ] Enable `unattendedRead: true` only after a renewable supported principal reads inventory and content in a fresh process without visitor browser/session context, and renewal/revocation behavior is demonstrated. `proofRef` identifies sanitized reproducible evidence with verification date and exact scope.
- [ ] Where unsupported, return truthful capability with limitation, leave automatic coverage open, and implement validated manual import plus synthetic adapter behavior. Continue C5 and Chapter 3 for available sources. Do not manufacture a cloud cursor or mark fixture access verified.
- [ ] Test pagination past the first page, older segment omission, empty incomplete inventory, expired access, attachment denied, manual import replay and interactive-only capability. Run `node --experimental-strip-types --test tests/history-cloud-adapters.test.ts`; commit `feat: add capability-gated cloud history adapters`.

## Task C5 — Resumable initial import and coverage reconciliation

**Create:** `lib/history/collection.ts`, `lib/history/coverage.ts`, `app/api/history/imports/route.ts`, `app/api/history/coverage/route.ts`, `tests/history-collection.test.ts`, `tests/history-coverage.test.ts`.

- [ ] Run separate inventory and content phases with durable run/epoch, page cursor, per-conversation segment cursor, work budget and failed-item retry state. All `CollectionPage` metadata stays within Chapter 1 limits. Persist bounded continuations rather than keeping the entire import in memory.
- [ ] Stage and verify body/attachment objects, then use Chapter 1 page CAS. A page is acknowledged only after records, gaps, receipt and cursor commit atomically. Resume after the last acknowledged cursor; check replay identity before rejecting an already-committed page's old previous cursor.
- [ ] Reconcile local/cloud copies with source occurrences and evidence-backed aliases. Retain both origins and distinct coverage; matching text alone cannot prove identity. Do not delete retained records because a provider later omits them.
- [ ] Compute coverage from committed inventory membership and unresolved segment/message/attachment gaps. `complete + partial + unavailable === discovered`; unavailable is not zero-message complete. Inventory exhaustion, content completion and source capability remain separate. Report unknown historical denominator and exclusions explicitly.
- [ ] Record oldest/newest known dates, segment/attachment counts and parser errors in a supplemental coverage detail projection; do not silently change Chapter 1 `CoverageSnapshot`. A source with inaccessible inventory cannot advertise all-history percentage.
- [ ] Test 3+ inventory pages, 3+ content pages, crash after committed page, dropped success response, mid-run scope change, missing segment resolved later, partial inventory omission and two-owner isolation. Example behavior contract:

```ts
await ingest(page); // chapter 1 atomic receipt
assert.deepEqual(await ingest(page), await receipt(page.pageId));
assert.equal((await coverage(page.sourceId)).discovered, 3);
assert.equal((await coverage(page.sourceId)).contentComplete, false); // missing segment
```

- [ ] Run `node --experimental-strip-types --test tests/history-collection.test.ts tests/history-coverage.test.ts tests/history-storage.test.ts` and `node --test collector/test/*.test.mjs` (use explicit filenames if shell glob expansion is unavailable). Commit `feat: import complete available history with resumable coverage`.

## S2 gate and evidence

- [ ] Record actual local inventory/import and a known older retained conversation readback for each installed provider, without publishing transcript bytes. Compare inventory count and gap categories against the private run manifest.
- [ ] Record each cloud source independently as verified/partial/unsupported/unverified with exact remaining step. Full requested coverage remains open until all four source classes pass; missing historical transcripts remain explicit losses even after all available content is imported.
- [ ] Run `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`; record commands/results and commits in checkpoint. These checks establish implementation, not unattended deployment. Chapter 3 owns that gate.
