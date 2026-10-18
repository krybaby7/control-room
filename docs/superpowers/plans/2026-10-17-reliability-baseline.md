# Reliability and Current Baseline Implementation Plan

> For agentic workers: use superpowers:subagent-driven-development. The owner explicitly requested GPT-6.1 Sol implementation agents and approved this work. Root coordinates Sites and integration; agents do not publish or commit independently in the shared checkout.

**Goal:** Repair audited reliability defects and populate a current, sourced baseline while preserving existing user data.

**Architecture:** Versioned domain document, pure lifecycle/calendar/validation helpers, D1 atomic mutation receipts and recovery snapshot, authenticated command API, React editors and Sources recovery UI. Baseline is a dated source-backed additive package, not a workspace reset.

**Tech Stack:** TypeScript, React/Vinext, Cloudflare D1/Drizzle, Node test runner, local Chromium/browser verification.

## 1. Backend reliability — Sol implementer

Own lib/types.ts, lib/planning.ts, lib/seed.ts compatibility only, lib/workspace-store.ts, lib/api-guards.ts, app/api/workspace/route.ts, db/schema.ts, appended drizzle migrations, new domain/calendar/validation modules, backend tests.

- [x] Add failing regressions for done -> archived -> restored preserving completion; completed archived dependency; explicit reopening guard.
- [x] Add failing tests for same mutation retry after lost success, changed-command ID reuse, owner isolation, and concurrent stale writers.
- [x] Add failing migration/week tests including Sunday/Monday Cairo rollover and last-saved-week legacy pins.
- [x] Add validation/restore regressions for malformed and future-schema exports, foreign IDs, cycles, bounds, valid backup restore, stale restore, and recovery snapshot atomicity.
- [x] Implement the smallest safe fixes. Communicate exact shared API/type/helper contracts to the UI implementer before the UI uses them.
- [x] Generate append-only Drizzle schema migrations and test using the actual migration SQL.
- [x] Run focused tests then full tests and typecheck after integration. Report exact checks and unresolved concerns.

## 2. Frontend reliability — Sol implementer

Own components/control-center.tsx, task-editor.tsx, today-view.tsx, ui.tsx, sources-view.tsx, form-dialog.tsx, app/globals.css, new focused client modules/tests. Coordinate shared contracts with backend; do not edit backend-owned files.

- [x] Stable mutation IDs survive ambiguous network failure and unchanged retries; changed commands get fresh IDs. Preserve conflict draft behavior.
- [x] Explicit 401 and stale-refresh states; hide protected view on session expiry and offer same-origin sign-in.
- [x] Current dated week, completion filtering, prior-week carry-forward, correct pin affordances.
- [x] Sources export/import preview, validated final restore, prior-snapshot export, usage information and clear failure retention.
- [x] Darken audited text to normal-text contrast requirements; verify CSS rather than adding brittle style tests.
- [x] Add meaningful pure client/session/submission regressions; leave browser interaction to root or a separately assigned verifier.

## 3. Research and baseline — Sol agents, after reliability integration

- [x] Read project instructions and sources for TAMENNI, map-lab, and Trade Graph; inspect fresh remote GitHub state without altering checkouts.
- [x] Save dated evidence and proposed milestone/task mapping under .codex-scratch/control-room-reliability-baseline for review.
- [x] Root reviews factual claims and separates observations, owner decisions, and proposals.
- [x] Assign a Sol implementer to create the baseline module, project display, additive idempotent command, and preservation/deduplication tests using the reviewed content.

## 4. Integration, review, publish — Root coordinates

- [x] Review source and regression outputs; run full test/typecheck/lint/build against the integrated tree.
- [x] Apply appended migration locally and verify actual lost-success retry, revision conflict, completion/archive history, restore conflict/recovery export, refresh failure and session expiry in the development browser.
- [x] Verify local baseline application, lost-response replay, preserved records and desktop layout in the integrated UI. Mobile responsiveness has CSS breakpoint review only.
- [x] Complete independent Sol review of spec compliance and code quality; no outstanding findings remain after runtime wording correction.
- [ ] Inspect hosted production behavior separately from development mock authentication; mobile browser/device checks remain outside the completed desktop QA.
- [ ] Package exact verified source through Sites, privately deploy and confirm terminal success. The Windows build-site wrapper failed before build; direct production build passed. Final packaging/publication remains pending.
- [ ] Apply the reviewed baseline through the normal authenticated hosted workflow; verify both project baselines and preserved records.
- [x] Record implemented changes, local evidence and remaining limitations in docs/superpowers/verification/2026-10-17-reliability-baseline.md.
- [ ] Record final publication and hosted verification results and report delivery.
