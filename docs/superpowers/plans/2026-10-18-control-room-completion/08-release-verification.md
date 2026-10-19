# Phase 8: Release Verification and Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the completed Control Room works across its implemented features, recovery paths and operational boundaries, then release a traceable private artifact with rehearsed recovery and an honest account of remaining checks.

**Architecture:** Test one exact source revision through unit/integration checks, isolated worker/database/browser tests, a private staging deployment and owner-authenticated production smoke checks. Keep deterministic fixtures separate from owner data, retain backward-compatible migrations through the rollout window, and distinguish implemented features from verified deployment capabilities.

**Tech Stack:** Existing Node 24/TypeScript/ESLint/Vinext build, real SQLite and local D1 fixtures, proposed Playwright browser regression suite, GitHub Actions when the repository has a connected remote, Sites publication tools, private D1/R2 staging and owner devices.

---

## Status and execution boundary

This is planning only. The initial 18 October 2026 audit ran 71 tests plus typecheck/lint/build successfully at `b50aa5c`; those results do not verify any feature proposed in phases 1–7. No checkbox below is complete.

Build and test independent work autonomously within the authorized implementation scope. Do not add repeated approval gates for routine fixes or isolated fixture tests. Do not run destructive tests against production, activate paid providers, place trades, publish public access or create real notifications merely to satisfy a check. The owner handles interactive authentication/passkeys and real device actions where an executor cannot.

Cloud limitations are evidence, not failures to conceal: Windows-specific paths, native apps, authenticated Sites browser state, passkeys and physical devices may be unavailable. Finish portable work and leave a precise handoff for those checks. A capability without its required integration is displayed as unavailable/configuration-required; it is not labelled connected or healthy.

## Release evidence contract

Create `docs/releases/release-status.schema.json`, `scripts/record-release-check.mjs` and a per-candidate `docs/releases/<candidate>/status.json`. Each result records the actual environment and artifact, not just a checkbox.

```json
{
  "candidate": "control-room-v1-completion",
  "sourceCommit": null,
  "artifactSha256": null,
  "checks": [
    {
      "id": "hosted-owner-login",
      "status": "not-run",
      "environment": "private-staging",
      "observedAt": null,
      "commandOrProcedure": "Owner signs in through Sites, then opens the private workspace.",
      "evidencePath": null,
      "limitation": "Requires owner browser authentication."
    }
  ]
}
```

`sourceCommit` is populated from `git rev-parse HEAD` when the candidate is built; null means no artifact has been built. The status enum is `not-run`, `passed`, `failed`, `unavailable`, `owner-dependent`, `not-applicable`. The recorder rejects `passed` without timestamp, source commit, environment and evidence reference. `not-applicable` requires a reason tied to disabled scope. Store private traces/screenshots in ignored or controlled artifact storage, with sanitized descriptions in the repository; never commit owner data, cookies or tokens.

Report three independent phase states: `implementation`, `localVerification`, `hostedAcceptance`. A code-complete cloud task can be `implementation=complete`, `localVerification=passed`, `hostedAcceptance=owner-dependent`; that is not full release acceptance. Restore/deletion/connector/scheduler features require their applicable acceptance checks before enablement.

## Task 1: Reproducible test runners and CI

**Files:** modify `package.json`, `.gitignore`, `README.md` and phase 1's `playwright.config.ts`, `scripts/test-worker.mjs`, `scripts/test-fixtures.mjs`, `tests/e2e/helpers.ts`; create `scripts/verify-release.mjs`, `tests/e2e/smoke.spec.ts`; create `.github/workflows/control-room-ci.yml` only when an actual repository/runner is configured.

- [ ] Pin Node 24 in the chosen runtime configuration, matching the current SQLite test requirement. Install from the lockfile. Verify the Sites execution profile before choosing the platform build runner; `scripts/run-framework.mjs` already distinguishes managed Linux and portable environments.
- [ ] Add the exact scripts below after creating their referenced files and installing the chosen pinned Playwright dependency. `scripts/verify-release.mjs` invokes `npm test`, `npm run test:migrations`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm run test:worker`, then `npm run test:e2e` sequentially with inherited output, bounded timeouts and failure exit propagation. Build must not overlap other scripts sharing generated outputs. The performance runner is a separate explicit isolated check.

```json
{
  "test:e2e": "playwright test --config playwright.config.ts",
  "test:worker": "node scripts/test-worker.mjs --target local-fixture",
  "test:migrations": "node --experimental-strip-types --test tests/migrations/upgrade.test.ts",
  "test:release": "node scripts/verify-release.mjs",
  "test:perf": "node scripts/benchmark-workspace.mjs --target local-fixture"
}
```
- [ ] Extend phase 1's isolated worker harness: bind only temporary local D1/R2 fixture state, apply all appended migrations in order, and use loopback development auth with matching `TEST_PORT`/Playwright base URL. Refuse an occupied port, non-loopback URL or production database identifier. Mock identities must be absent from production artifacts.
- [ ] Create deterministic fixtures for two owners, both seeded projects, blocked dependencies, archived completed work, old Cairo weeks, uncertain mutations, near-capacity text, quarantined imports, drafts/outbox items and later module content. Fix clock values and IDs for reproducibility; inject time/network instead of sleeping through timeouts.
- [ ] Make `scripts/verify-release.mjs` usable in every supported cloud checkout without GitHub. The audited checkout has no configured remote; do not create or guess one. When an actual GitHub repository/runner is configured, add CI jobs invoking the portable runner for the Node suite, typecheck/lint, production build and Chromium browser suite. Run WebKit/Firefox recovery smoke checks where that runner supports them. Upload sanitized failure traces and summary JSON; never include session tokens or owner snapshots. Add dependency review/update policy only after confirming connected-repository capabilities; do not claim CI exists merely because a YAML file is present.
- [ ] Verify the initial browser test has meaningful assertions:

```ts
import { test, expect } from '@playwright/test';

test('fixture workspace loads and persisted state survives reload', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'A clear view of what’s next.', exact: true })).toBeVisible();
  await expect(page.getByText('Saved workspace', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Saved workspace', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Projects', exact: true })).toBeVisible();
});
```

The heading label above is present in the current `components/today-view.tsx`; update the test deliberately if the implemented copy changes. Do not add brittle snapshots of entire markup. `tests/e2e/helpers.ts` owns fixture login, API commands and injected-network utilities, with owner identity confined to the local mock harness.

- [ ] Run `npm run install:ci`, then `npm run test:release` in a clean checkout after all referenced runner files exist. The existing install wrapper preserves the lockfile and selects the configured environment path. Record actual test counts and failures. For an earlier phase without the full release harness, run the existing four commands and available phase-1 browser checks directly, marking absent migration checks not-run. Commit the harness only after it proves it rejects a production target and reproduces a deliberately failing fixture assertion.

## Task 2: Automated end-to-end feature and failure matrix

**Files:** create `tests/e2e/planning.spec.ts`, `tests/e2e/recovery.spec.ts`, `tests/e2e/import-export.spec.ts`, `tests/e2e/history-evidence.spec.ts`, `tests/e2e/integrations.spec.ts`, `tests/e2e/jobs.spec.ts`, `tests/e2e/privacy.spec.ts`; extend `tests/e2e/helpers.ts` and phase-specific tests.

Implement each row with UI assertions plus authoritative API/database assertions. Do not count a toast as proof of persistence or a mock provider response as a working production integration.

| Area | Required scenarios | Observable pass condition |
|---|---|---|
| Planning | Create/edit tasks and milestones; project/milestone archive; dependency cycle; blocked completion; evidence-required acceptance; restore archived work | Correct saved values; invalid changes leave revision and records unchanged; completion history preserved |
| Weekly/capacity/recurrence | Cairo Sunday/Monday boundary and DST; carry-forward; explicit weekly capacity; recurring occurrence dedupe; skipped/paused rules | No silent repinning or duplicate occurrence; accurate date range and capacity explanation |
| Timeout/conflict | Drop response after upstream commit; delay before commit; lookup not-found then late commit; 409 with same/different field edits | One unchanged submission effect; exact command retained; unrelated remote edits survive |
| Draft/offline | Default in-memory draft; server draft reload; opt-in device outbox; storage denied; two tabs; reconnect review | Saved/draft/queued states distinguishable; explicit replay; no private namespace crossing |
| Recovery/import | v1/v2/v3/v4 and module migrations; invalid/future bundle; repair preview; stale restore; interrupted commit; job/approval racing restore | No partial module changes; complete prior bundle downloadable; repeat restore ID is idempotent; old execution epoch cannot dispatch |
| Backup/deletion | Multiple snapshots; R2 missing/hash failure; quota full; failed scheduled run; referenced record delete; restore collision | No destructive action without usable recovery; healthy only after verified complete backup |
| Evidence/history | Source links, decisions, attachment versions, pagination, actor/origin provenance, undo conflict | Retained audit events beyond 100; safe attachments; undo refuses overwriting later changes |
| Search/recommendations | Text across authorized modules; filters; archived exclusions; equal project exposure; no invented deadlines | Stable relevant results, explainable next actions, no inaccessible-owner results |
| Repository/PC integrations | Read-only permissions; stale source; invalid credentials; disconnected collector; duplicate/out-of-order event; owner mismatch | Last-good evidence retained with freshness status; no writes to underlying repositories or runtime actions |
| Jobs/notifications | Retry/backoff; lease expiry; cancellation; duplicate delivery; schedule DST; quiet hours; absent provider | No duplicate user-visible effect; jobs cannot claim completion before delivery confirmation |
| Privacy/auth | Anonymous read/write; forged owner body; cross-origin JSON; expiry mid-save; logout/relogin as another owner | 401/403 and no data leak; private view cleared; no continued outbox replay |

- [ ] Use `page.route` to create network failure conditions against fixtures, including a POST that really commits upstream before its response is dropped. Persist the same mutation ID across the retry and count server effects.
- [ ] Add test-only server-side fault injection guarded by the local fixture harness or adapter dependency; never expose a production query parameter that can fail arbitrary transactions.
- [ ] Run targeted suites during feature integration, then all E2E suites once per integrated candidate. Fix failures using the affected phase contract; add a regression only when it proves behavior rather than mirroring implementation.
- [ ] Mark tests for unavailable provider/device capabilities as `unavailable` in the release matrix, with mock/unit verification tracked separately. Do not use a blanket skipped suite to hide a required acceptance failure.

## Task 3: Accessibility and responsive interaction

**Files:** create `tests/e2e/accessibility.spec.ts`, `docs/releases/<candidate>/accessibility.md`; modify affected `components/` files and `app/globals.css` during execution only.

- [ ] Test desktop 1440×900, tablet 768×1024, phone 390×844 and narrow phone 320×568, including long Arabic/English content, maximum-length titles, browser text scaling and zoom. Check Today, Projects, Inbox, Sources, recovery dialogs, settings and every newly added screen for horizontal overflow, clipped actions and unreachable content.
- [ ] Add an automated accessibility scanner against normal, empty, loading, error, conflict and modal states. Follow it with manual keyboard checks: visible focus, logical order, skip link, modal initial focus, Escape/dirty-draft handling, focus return and no keyboard traps.
- [ ] Verify meaningful accessible labels for icon-only actions; live-region announcements for saves/failures/queued work without repeated noise; field errors linked to inputs; status information not dependent only on color. Measure text contrast rather than inferring it from a screenshot.
- [ ] Test reduced motion, touch targets, scrolling within dialogs, on-screen keyboard obstruction and loading-state actions. Avoid disabling all navigation indefinitely during uncertain saves.
- [ ] Run Chromium emulation in CI and a screen-reader smoke test where the executor has support. Record browser/OS/assistive technology and the exact tested interaction. A scanner pass is not a claim of complete accessibility or physical-device verification.

## Task 4: Capacity, performance and cost budgets

**Files:** create `scripts/benchmark-workspace.mjs`, `tests/performance/capacity-fixtures.ts`, `docs/operations/capacity.md`, `docs/releases/<candidate>/performance.json`; modify query/index code only when measured results justify it.

- [ ] Generate separate fixtures for the current small workspace, 2,000 tasks/1,000 captures/100 milestones, 1 MB user content/1.25 MB serialized planning metadata, 10,000 audit events, 10,000 evidence/link records and 1,000 attachment manifests. Keep actual blob uploads bounded in isolated storage; do not use production owner data.
- [ ] Measure p50/p95 read and save latency, JSON size, D1 statement count/rows scanned, cold-start impact, memory, pagination and browser long tasks. Benchmark Arabic text and worst-case dependency depth; a large fixture must not trigger recursive stack overflow or quadratic rendering.
- [ ] Adopt initial release targets in the controlled warm staging harness: p95 workspace read ≤1.5 s; p95 normal save ≤2 s; first usable screen ≤3 s on the documented mobile-network profile; no interactive main-thread task >200 ms during normal navigation; stable paginated history/search with no unbounded query. Report cold starts and full export/import separately; background jobs show progress instead of holding interactive requests open.
- [ ] Run 20 concurrent isolated sessions, including conflicts against the same fixture owner and independent owners. Verify no lost updates, duplicate receipts/events, cross-owner data or silently dropped jobs. Repeat at deployment-approved resource budgets; these targets are proposed engineering gates, not performance already achieved.
- [ ] Confirm current D1/R2/Worker limits and billing from the configured platform at execution time. Check atomic bulk imports fit statement/parameter/runtime limits. Bound file count, file bytes, uncompressed archive bytes, job concurrency and per-owner module counts in one documented policy.
- [ ] Define storage/cost alerts using aggregate metadata only. If a budget is exceeded, optimize or lower the feature's advertised supported limit with a visible capacity plan; do not silently truncate evidence, events, receipts or snapshots.
- [ ] Run `npm run test:perf` only against the isolated harness; save the environment, source SHA and raw metrics. Do not compare developer-laptop timing to a hosted SLA without calibration.

## Task 5: Migration and rollback rehearsal

**Files:** create `scripts/rehearse-migrations.mjs`, `tests/migrations/upgrade.test.ts`, `docs/operations/migrations.md`, `docs/releases/<candidate>/migration-report.md`; review all `drizzle/*.sql`, `lib/workspace-migrations.ts` and export adapters.

- [ ] Inventory existing migration journal, source schema versions, feature/module versions and runtime bindings. Hash the candidate migration files. Reject renumbered/edited applied migrations and any accidental production seed/reset command.
- [ ] Rehearse upgrades from initial-release D1, reliability-release D1, large legacy documents, incomplete prior backup state and every supported bundle/module version. Use synthetic snapshots or owner-authorized sanitized copies in an isolated database. Record before/after row counts, canonical user-content hashes and foreign-reference checks.
- [ ] Inject failure after each migration/backfill segment and resume from its durable cursor. Backfills must be idempotent, owner-scoped and distinguish migrated records from unverified inferred facts. Do not make up erased completion history.
- [ ] Use expand/backfill/verify/switch/contract rollout where a large backfill cannot be atomic. Keep old readers usable until the compatibility window closes; commands from older clients either adapt safely or receive an explicit upgrade-required response before mutation. Test old/new clients concurrently against the staged database.
- [ ] Rehearse application rollback separately from data recovery. A prior build may run only if it understands the expanded schema and cannot overwrite new side-table state. Never apply a destructive down migration to production to make an old binary fit. Prefer a forward fix or redeployment of a compatible build.
- [ ] Restore a complete backup into an isolated replacement database/bucket, validate checksums/module counts, sign in as fixture owners and run recovery smoke tests. Confirm a backup includes actual attachment bytes where advertised. Target initial recovery objectives of ≤24 h scheduled-backup data loss and ≤60 min fixture recovery after operator access; record measured results, and qualify these targets if no scheduler is deployed.
- [ ] Define the production cutover runbook: capture current version and verified snapshot, deploy compatible schema, run bounded backfill, validate counts/hashes, deploy candidate, observe health, then enable dependent features. Stop on mismatched counts, owner leakage, missing recovery point or unverifiable source/artifact identity.
- [ ] Run `node scripts/rehearse-migrations.mjs --target local-fixture` and `node --experimental-strip-types --test tests/migrations/upgrade.test.ts`. The rehearsal script must reject production URLs/IDs. Save evidence before planning a real migration window.

## Task 6: Private staging and exact-artifact publication

**Files:** create `docs/releases/<candidate>/artifact-manifest.json`, `docs/releases/<candidate>/deployment.md`; update `README.md` and the root release status record. Use the current installed Sites workflow; do not invent CLI flags or bypass its credential handling.

- [ ] Resolve the final commit and clean/expected working-tree state. Package the exact reviewed tree with lockfile, migrations and configured bindings. Record artifact checksum, source SHA, test-result references, build environment, feature flags and dependency versions. If delivery remains a source handoff, produce a ZIP plus SHA-256 manifest and a portable start guide matching `CLOUD-START.md`; exclude dependencies, private data, credentials, runtime state and logs. A ZIP does not create a Git remote or deploy a Site.
- [ ] Verify Sites capability availability in the executor. A direct `npm run build` proves compilation; it does not prove Sites packaging, migration delivery, private audience or successful publication. If the plugin/browser is unavailable, finish the candidate artifact and hand off exact publication steps without claiming deployment.
- [ ] Publish to an isolated private staging target when supported. Keep private audience and authentication unchanged. Verify server-side production identity, D1/R2 binding names, connector service grants and scheduling from actual deployment state. Source config alone cannot prove a connected resource.
- [ ] Confirm no development mock auth, fixture endpoints, secret values, personal absolute file paths or private traces are shipped. Verify anonymous access is denied and direct identity-header spoofing cannot bypass the hosted gateway. Do not use local mock auth as evidence for this check.
- [ ] Run read-only staging smoke checks first, then allowed fixture-account writes/deletes/imports with a recoverable isolated workspace. Exercise timeout/reconciliation, module restore, backup retrieval, scheduled job delivery and revoked connector access there.
- [ ] Promote the tested artifact through the authorized Sites process, append migrations, and record the terminal deployment result and exact published version. Do not rebuild a different artifact after acceptance without rerunning affected checks.
- [ ] On production, use the normal owner-authenticated app for a bounded smoke check: route loading, current saved revision, preserved project records, source freshness labels, backup availability and actual enabled capabilities. Avoid changing owner tasks, restoring production data or triggering live external actions merely for testing. Record any explicitly authorized write separately.

## Task 7: Owner authentication and physical-device acceptance

**Files:** create `docs/releases/<candidate>/owner-device-checklist.md`; update only the release status record when checks are actually observed.

- [ ] Prepare exact URLs, candidate version, expected screen labels and non-destructive procedures so the owner can perform authentication without sharing secrets. Pause at the passkey/biometric/device prompt; do not request credential exports, browser-profile extraction or impersonation.
- [ ] Ask the owner to verify the private workspace on their actual Windows PC, Android phone and tablet where owned. Record actual device/OS/browser; an unavailable device remains unavailable rather than inventing coverage. Browser viewport emulation remains a separate result.
- [ ] Check sign-in/expiry/sign-out, keyboard/touch input, rotation, on-screen keyboard, long dialogs, download/upload behavior, server-draft recovery and opt-in outbox privacy on a non-production fixture workspace when available. On production, limit to reading and export unless the owner has authorized a concrete reversible test record.
- [ ] For the PC collector, verify the real installation/service/allowlist/connectivity path through its phase-specific acceptance procedure. A cloud executor can test its protocol and installer artifact but cannot attest to a running Windows service it has not observed. No trading/runtime control follows from collector visibility.
- [ ] For notifications/passkeys/push, verify actual platform support and permissions. If the chosen Sites/browser environment cannot supply the required service worker, push subscription or native grant, keep that delivery option unavailable and use the implemented supported alternative; do not label an in-app mock notification delivered.
- [ ] Record owner acceptance by feature with evidence and remaining concerns. No acceptance of planning UI implies acceptance of TAMENNI, exchange execution, profitability, paid-provider usage or underlying product release readiness.

## Task 8: Operational runbooks and final reconciliation

**Files:** create `docs/operations/incident-response.md`, `docs/operations/backup-restore.md`, `docs/operations/connectors.md`, `docs/operations/jobs.md`, `docs/operations/release.md`; modify `docs/operations/privacy.md`, `docs/operations/capacity.md`, `README.md`, `docs/verification.md`, `docs/superpowers/verification/2026-10-17-reliability-baseline.md`; create `docs/superpowers/verification/2026-10-18-completion-candidate.md` or the actual execution-date equivalent.

- [ ] Document failure triage using request IDs and sanitized error codes: uncertain save, revision conflict, expired auth, unsupported schema, storage quota, failed backup, stale sync, collector offline and job retry exhaustion. Include the exact read-only checks and recovery action for each; do not recommend deleting the workspace or reseeding.
- [ ] Document backup schedule/retention, last-good snapshot verification, isolated restore rehearsal, damaged import quarantine, attachment recovery and contact/owner handoff. State actual recovery objectives measured in Task 5; do not advertise scheduled protection until a scheduled backup has completed and been restored successfully in isolation.
- [ ] Document connector scopes, revocation, credential rotation, freshness checks, provider outage behavior, rate limits and privacy boundaries. Document job leases, dead-letter inspection, manual retry/deduplication and quiet-hours behavior. Ensure runbooks refer to real implemented controls and routes.
- [ ] Add operational health checks for storage, last successful backup, oldest pending job and source age, without logging private content. Test a synthetic alert in isolated staging; real notifications require the configured authorized recipient/delivery scope.
- [ ] Reconcile all audit gaps to phase task IDs and evidence. Record exact implemented features, feature flags, disabled/unavailable integrations, private Site URL/version, source SHA, test counts, migration IDs, physical-device results and remaining owner-dependent actions.
- [ ] Keep historical 17 October verification records dated and intact; append links to the new report and a clear current-status note. Remove stale claims from the current README only after replacement evidence exists.
- [ ] Conduct independent review of the final source, schema migrations, permissions, failure recovery and release evidence. Resolve actionable findings; rerun only affected checks plus the final integrated suite once changes are complete.

## Release completion criteria

- [ ] Every audit gap maps to implemented behavior or an explicit unavailable capability with a supported fallback and a concrete next action.
- [ ] No unresolved data-loss, owner-isolation, duplicated-effect, false-success or non-recoverable migration defect remains in the enabled scope.
- [ ] Unit/integration, typecheck, lint, build and applicable browser suites pass on the exact candidate; counts and environment are recorded.
- [ ] Backup restore and migration recovery have been rehearsed in isolation. Production data was preserved and destructive QA remained isolated.
- [ ] The private published artifact, bindings and deployed migration state are verified through real Sites evidence, not inferred from source files.
- [ ] Required owner-authentication and physical-device checks are either observed passing or explicitly remain owner-dependent; the overall result is labelled partial if a release-critical one remains.
- [ ] Runbooks and current documentation match the delivered product, and the owner can distinguish saved facts, proposals, stale imported evidence, queued actions and confirmed external effects.

The final handoff should state outcome, exact artifact/version, completed checks, remaining limitations and the next concrete owner action. It must not say “fully verified” while hosted authentication, storage, scheduler, collector or required device checks are unobserved.
