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

## Subsequent cloud evidence

- Source b8467872047538bf9a67f59766c10e3714c50279 has tree02394565a6020f9715fd8954c1cdea065a2a7eac. [CI39129127677](https://github.com/krybaby7/control-room/actions/runs/39129127677), job117680467946, passed a real clean locked install,243 Node tests, typecheck, lint, build, isolated Wrangler smoke and three Chromium Playwright journeys. This supersedes the earlier pending browser and installation limitations above.
- Browser journeys proved synthetic response-loss reconciliation exactly once, server draft reload/owner isolation and session-expiry hiding. They do not prove the private gateway, live provider, Windows device or real R2 execution.
- New uncommitted slice adds immutable repair lineage, explicit trusted-device unlock and CAS-safe device storage, plus disabled backup policy/runner contracts. Focused tests pass; integrated checks and expanded browser CI are next. Private hosted v2 remains unchanged.
- Resume with `git status --short`, `npm test`, then `npm run typecheck`. Review active worker changes before editing. The rejected inspection commit remains excluded.

## Device, repair and retention integration checkpoint

Parent source b8467872047538bf9a67f59766c10e3714c50279. Working-tree Node regression:305 tests pass, zero failures/skips (includes11 independent, unintegrated Phase2 selector tests). Complete normalized reference-set insert/update/delete races roll back effects. Concurrent recovery preparation now returns authoritative revision conflicts; retirement is rechecked before replay. Independent review found no data-loss blocker after that fix.

Device storage stays unopened by default. Explicit unlock verifies current owner scope. Native IndexedDB uses CAS, exact draft discard and empty revision tombstones; locked reload Forget reauthenticates before clearing only that namespace. If expiry occurs before a namespace was unlocked, clearance cannot be claimed; same-account reauthentication and explicit Forget remain required. Three new browser journeys are prepared, not yet executed.

Receipt usage is read-only; compaction is internal, explicit, retired-epoch-only and atomically blocked by unexpired draft references or schema/rowset changes. No automatic retirement or pruning occurs. Backup policy exposes disabled/unavailable defaults with exact provisioning requirements; a persisted active policy or live scheduled execution is not claimed.

Next: run cloud CI for this source and resolve any native device recovery failures. Then integrate Phase2 schema/workflows after foundation gates; feature-specific module merge/reference schemas remain with their owning phases. No deployment occurred.

## Native browser failure and correction

Published foundation adbff55da1c99b2e07a9e9d4aaca30ae8127d27c (tree a251a761bd0ea0e2bba94c5b4368f9de2623eba9) and independent selectors897a5415a6a22c3f3a54c0e26a957480a88defe1 (tree ba0fe80f48264d0e8260035dd76c83440027b046). CI39130469730/job117684416418 passed install,305 tests,typecheck,lint,build and HTTP fixture; Chromium passed4/6. Failures were initial local/server draft autosaves, not a claimed passing gate. Synthetic trace artifact SHA256 fa69885e435306c608ea27a5308bcb9e0078be568f73231ecafc1c696d5f526c matched downloaded evidence.

Root cause: separate updatedAt and expiry clock samples could differ by milliseconds, exceeding the strict30-day bound. All three payload builders now derive expiry from the same timestamp. A deterministic clock-offset native regression checks both device and server saves; no timeout or retention guard was weakened. Expanded import repair browser journey also awaits execution. Next command: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, then publish this correction to the existing draft PR and observe terminal cloud CI.
