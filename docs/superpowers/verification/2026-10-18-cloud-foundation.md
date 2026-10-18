# Cloud foundation checkpoint — 18 October 2026

This is an in-progress implementation checkpoint, not a complete Phase 1 or release claim. Phases 2–8 have not started. Original deployed owner data and private access are unchanged.

## Configuration and provenance

- Corrected launch baseline: c08e8a15dc7291c4f68fa5edebaf2fa8c583d820; exact commit/tree verified through supported GitHub access.
- All 160 unchanged application import file hashes matched before editing.
- Node 24 cloud runtime. Explicit gpt-6.1-sol model parameter accepted for implementation/review workers: /root/foundation_review, /root/codec, /root/save_client, /root/export_registry, /root/drafts. Integrator configuration is gpt-6.1-sol.
- The rejected inspection checkpoint is excluded from the implementation branch and publication tree. No hosting identifiers, private absolute paths, host/kernel details, credentials or owner records are included in this new checkpoint.

## Verification

- Original baseline: npm test 71 passed, zero failures/skips; typecheck, lint and build passed.
- Integrated foundation checkpoint: npm test 169 passed, zero failures/skips; npm run typecheck, npm run lint and npm run build passed.
- Tests use synthetic data and SQLite with actual migration SQL. Coverage includes lossless near-capacity migration, command/row/hash races, owner isolation, receipt replay, ten transaction fault points, server draft retention, offline queue fencing, import chunk corruption/rollback, backup quota races and epoch retirement races.
- Independent review found same-ID race reporting and corrected-submission/durable-metadata issues; fixes integrated. Additional review required after the remainder of Phase 1.
- Clean npm run install:ci did not pass: network policy denied package downloads; offline installation found a missing locked tarball. 687 exact SHA-integrity-verified cached locked tarballs supplied the checks without altering the lockfile. CI repeats a clean installation; no hosted CI success is asserted here.
- Managed browser control skill and browser-test dependency unavailable. No browser QA, physical device, hosted failure drill, unattended run or real R2 write is claimed.
- Native Sites read confirmed owner access, current version 2 and no external visitors. No publication attempted for this partial checkpoint.

## Remaining work / next command

Run `git status --short` and `npm test` when resuming; inspect progress.json and current changes before editing. Complete reviewed atomic full-bundle restore/merge/repair, complete backup/deletion recovery and operational epoch invalidation, add browser harness when dependency access exists, then begin Phase 2. Keep provider inference and operational effects disabled. Provider, Windows/device and scheduler acceptance require their real configured execution path; fixtures are not live proof.

## Expanded recovery checkpoint

- First delivered source: ea075cda6d0631491d1aceb51702ea1087502961; [CI run39127618834](https://github.com/krybaby7/control-room/actions/runs/39127618834) passed a real clean install,169 tests,typecheck,lint and production build.
- Current expanded recovery source:243 Node tests pass, zero failures/skips; typecheck, lint and production build pass. Actual isolated Wrangler HTTP smoke passes with synthetic owners and actual migrations: GET, capture commit, unchanged receipt replay exactly once, and foreign-origin rejection.
- Reviewed import transactions replace normalized modules atomically, preserve target history and source claims, rotate execution epoch, cancel pending intents and request reconciliation for running ones. Selective planning merge creates proposed/unpinned tasks and preserves existing lifecycle authority. Missing/expired/changed previews never write planning.
- Permanent removal requires archived/unreferenced records, exact impact digest/revision and a full pre-change backup. Snapshot retention never automatically evicts manual/pinned generations; explicit removal requires a newer verified recovery point under the same transaction guard.
- Standard Playwright tests now exist for response loss after real commit, server draft reload/owner isolation and expired-session hiding. The actual browser result is not yet claimed; cloud CI will run Chromium against the isolated fixture.
- Remaining Phase1 work is recorded in progress.json. Later phases remain unstarted; no private deployment, provider/device execution or paid inference is claimed.
