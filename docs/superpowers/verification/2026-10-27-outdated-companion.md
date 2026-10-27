# Outdated PC companion fast failure — 2026-10-27

A companion that cannot run a queued briefing now fails that request during its next poll with `companion_outdated`, without claiming it. The owner sees: “Your Control Room PC app is out of date, so it couldn't run this briefing. Close the old PC app; if it keeps happening, update the PC app.” A failed request stays failed when a current companion subsequently polls; it cannot become a ten-minute orphaned claim or silently run again.

## Source and coordination

Work is confined to the supplied clone, branch `feat/outdated-companion-fails-fast`, from `main` `3e6e020`. Read `AGENTS.md`, `README.md`, the requested large-working-tree and multi-folder verification notes, bootstrap/master/gap/progress documents, source-import provenance and owner-turn format. The 21 October connector source was inspected read-only; no installed connection, private registry, credential, session or owner workspace was read or changed.

Explicit supported runtime requests with `model: gpt-6.1-sol` succeeded for `/root/companion`, `/root/ui` and `/root/review`. One integrator owns the shared contract, server and dashboard changes; leaf workers owned separate connector and presentation files. Review found a missing shared module in the companion archive. An extracted-ZIP import test first reproduced `ERR_MODULE_NOT_FOUND`; the corrected archive passes that test. Final independent review found no remaining actionable issues.

Node **24.14.1**, npm **11.11.0**. `npm run install:ci` was attempted and failed with `spawn EPERM`; existing dependencies were used. The lockfile and hosting identity are unchanged.

## Change and compatibility

- The existing shared personal-repository module defines protocol **1** and the supported kinds. Idle polls, active cancellation polls and direct `auto-brief` admission send `{companion:{protocol:1,kinds:['browse','analyze','brief']}}`. Optional release IDs are validated but omitted by this source because no reliable build/release ID is available. The UI shows the declared check-in version; it does not invent a release identity for legacy processes.
- Declaration validation accepts protocol integers **0–255**, at most three unique known kinds and an optional **1–64** character release ID restricted to letters, digits, dot, underscore, plus and hyphen. Unknown fields, duplicate/unknown kinds, null and malformed declarations reject. Omitting the declaration remains valid.
- An undeclared poll is legacy: browse/analyze retain their prior admission behavior; brief requires protocol at least **1** and an explicit `brief` capability. An incompatible queue head becomes failed immediately with a bounded diagnostic and `claimedAt: null`. Automatic admission has the same gate and cannot borrow a different process's previous declaration.
- An incompatible poll never receives an already-claimed briefing. It does not interrupt a capable companion's existing claim or alter that claim's expiry. Serial queue ordering is retained: an existing active claim still takes precedence over queued work.
- The latest declaration and explicit legacy flag are persisted under the existing row CAS. Owner projection adds the existing raw check-in timestamp. Identical polls continue updating raw presence without changing portable payload bytes, row revisions or export hashes. No database migration or saved-state rewrite is required. Historical error codes and optional-field-free saved records remain readable.
- The companion journals and immediately sends `fail` with `unsupported` for an unknown kind with a valid request ID. Delivery retries and restarts preserve that terminal receipt and never invoke a picker or model for the unsupported work.
- Repositories, project Folders and Today share the plain recovery words and show `PC app: current` or `PC app: out of date — update it`. Details expose the observed check-in version and optional reported release. Before any declaration has been observed, the status says it has not checked yet. Other incompatible job kinds receive equivalent folder/action-specific guidance.
- The ZIP allowlist includes both shared personal-repository files. The new package test imports the connector from extracted archive bytes in an isolated temporary directory, so checkout-only dependencies cannot mask a broken download.

`3e6e020` rejects unknown poll keys through its strict action validator. A new companion therefore requires the new Site to be deployed first; it does not retry an undeclared poll, change origins or send credentials to another endpoint. Adding the declaration to direct automatic admission and filtering already-claimed responses extend the specified gate to every path that can return work.

The briefing data contract, prompt and chat transport are unchanged. No claim window, timeout, budget or existing assertion was changed. Existing capable-companion test inputs now supply their declaration. No static import was added to `components/control-center.tsx`; the existing source-closure regression still passes. Build-generated closure sizes and browser behavior require the integrator's checks.

## Automated evidence

All fixtures are synthetic. These results do not establish an installed PC, hosted Site or model integration.

- New protocol/store regression first: **2 passed, 10 failed**, including the original symptom (`claimed` instead of `failed`). After implementation, **12/12 passed**.
- Server/history/export/briefing regression command passed **57/57**, no skips:

```text
node --experimental-strip-types --test --test-isolation=none tests/personal-companion-protocol.test.ts tests/personal-repository.test.ts tests/personal-repository-presence.test.ts tests/project-briefing.test.ts tests/personal-repository-capacity.test.ts tests/personal-repository-multi-folder.test.ts
```

- UI/dashboard/request recovery passed **83/83** before the final additive non-brief failure-copy case. Final integrated count is recorded below. New Today regressions were observed failing before the dashboard changes. The source startup-closure regression is included.
- Connector worker's affected two-file run passed **24/24**, no skips. This is worker-specific evidence: the integrator sandbox's direct 27-case connector/package run passed **17**, with **10** failures caused by `spawnSync git EPERM` before those Git-dependent fixtures could execute.
- `npm run test:companion` was attempted: **0 passed, 17 file-worker failures**, all `spawn EPERM` before test bodies. This is blocked execution, not a passing full companion suite. A direct no-isolation selection covering all seven new connector/package cases passed **7/7** with the unchanged 30-second timeout:

```text
node --experimental-strip-types --test --test-isolation=none --test-timeout=30000 --test-name-pattern="idle and active polls|unknown work|invalid unknown|downloaded connector|exact reviewed|download includes" tests/local-personal-connector.test.mjs tests/local-companion-package.test.mjs
```

- Extracted-package tests separately passed **3/3**, including real archive bytes, CRCs and module loading. No subprocess or installed companion is involved in that proof.
- `npm run typecheck`: passed. `npm run lint`: passed, **0 errors and 15 existing warnings**. Final verification results are recorded below.
- Default Node test isolation is unavailable here because worker processes cannot spawn. The direct commands disable process isolation without changing test assertions or timeouts. Build, Playwright and the complete companion suite remain integrator gates; they are not claimed as run or passed by this work.

## Release order and remaining acceptance

1. Review and commit the source, then run the integrator's build, Playwright and full companion gates with child-process access.
2. **Deploy the Site first**, preserving its existing private identity, audience and owner records. New Site + old companion is supported; old Site + new companion rejects the new request keys.
3. **Then reinstall the companion** from that deployed Site's corrected ZIP. Close the old PC app, including any older process sharing the device credential. Confirm the owner-visible current check-in version. The protocol cannot identify or terminate another process on the PC.
4. On a designated synthetic hosted/device setup, verify legacy-first polling fails a briefing on that poll with the recovery message and no claim, then verify a newly requested briefing reaches the current app. A real briefing/model call requires its own authorization; none was made here.

No push, merge, deployment, reinstall, paid inference or trading effect occurred. Git staging failed with `Unable to create .../.git/index.lock: Permission denied`; no commits could be created in this worker. The reviewable local changes are retained for the integrator. Suggested commit groups are protocol/store compatibility, connector/package defense, owner-facing presentation, and verification/checkpoint documentation. Each eventual message must end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` as requested.

Original owner messages are visible, but their real UTC message timestamps are not supplied by this session. No timestamped owner-turn handoff or reconstructed timestamp was invented; that missing evidence is disclosed here under the owner-turn format's explicit rule.

## Final local verification and file inventory

The final combined application command passed **141/141**, **0 failed**, **0 skipped**, in **4450.2705 ms**. It combines the six server/history files listed above with `tests/project-action-reasons.test.ts`, `tests/personal-repository-render.test.ts`, `tests/project-folders-render.test.ts`, `tests/dashboard-model.test.ts`, `tests/dashboard-feed.test.ts`, `tests/mission-control-render.test.ts`, `tests/personal-repository-request-recovery.test.ts`, `tests/personal-repository-rejection.test.ts`, `tests/personal-repository-destination.test.ts` and `tests/personal-completed-save-recovery.test.ts`, using the same `node --experimental-strip-types --test --test-isolation=none` invocation. The final seven-case connector/package selection passed **7/7**, **0 failed**, **0 skipped**, in **1195.1427 ms**. Final typecheck passed. Final lint passed with **0 errors, 15 existing warnings**. Diff whitespace checks passed. Progress JSON parses. There are no changes to the lockfile, hosting identity, briefing data contract, briefing prompt or control-center source imports.

Changed files, including the two newly added files:

- Shared/server: `shared/personal-repository.mjs`, `shared/personal-repository.d.mts`, `lib/personal-repository-store.ts`.
- Companion/package: `companion/personal-connector.mjs`, `scripts/package-local-companion.mjs`.
- Presentation: `lib/project-action-reasons.ts`, `lib/dashboard/contracts.ts`, `lib/dashboard/model.ts`, `components/personal-repository-onboarding.tsx`, `components/project-folders.tsx`, `components/briefing-card.tsx`.
- New regression: `tests/personal-companion-protocol.test.ts`.
- Existing regressions: `tests/project-briefing.test.ts`, `tests/personal-repository-multi-folder.test.ts`, `tests/personal-repository-capacity.test.ts`, `tests/local-personal-connector.test.mjs`, `tests/local-personal-connector-briefing.test.mjs`, `tests/local-companion-package.test.mjs`, `tests/project-action-reasons.test.ts`, `tests/personal-repository-render.test.ts`, `tests/project-folders-render.test.ts`, `tests/dashboard-model.test.ts`, `tests/mission-control-render.test.ts`.
- Documentation/checkpoint: this new verification note, `docs/superpowers/plans/2026-10-18-control-room-completion/progress.json`, `docs/superpowers/plans/2026-10-18-control-room-completion/09-gap-coverage.md`.

Commits: **none**, because Git cannot create its index lock in this checkout. Proposed reviewable subjects for the integrator are `fix: gate personal jobs by PC app protocol`, `fix: fail unsupported companion work and package its protocol`, `fix: explain outdated PC apps across owner views`, and `docs: record outdated companion verification`. Each requires the requested co-author footer. These are proposed subjects, not fabricated commits or hashes.
