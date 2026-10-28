# Project briefing coverage across folders - 2026-10-28

Work is confined to `fix/project-coverage-line` from `main` `270e403`. This is a display-only correction in the existing deferred dashboard model. No push, merge, deployment, provider call, production data read or companion installation was performed.

The supported runtime accepted explicit `model: gpt-6.1-sol` selections for implementation worker `/root/coverage_implementation` and independent reviewer `/root/coverage_review`. The integrator owns this verification record, the progress checkpoint and gap ledger. Repository instructions, required completion-plan documents, source-import provenance and the owner-turn format were read before implementation.

## Change and compatibility

`evidenceLine` previously used first-folder top-level evidence for a multi-folder saved report. Version 4 reports with more than one evidence repository now sum local commits, branches, uncommitted files and local chat sessions from the folder rows. GitHub totals include fetched/stale rows, preserve any stale marker, distinguish absent and unreachable remotes, and report the number of folders missing GitHub or pull-request data. Cloud owner turns and sessions sum per provider, with included coverage taking precedence over unavailable and not-found coverage.

The existing project-wide owner-turn totals, framing, task-plan and carried-forward text remain intact. Exact-output tests cover single-folder and normalized version 1, 2 and 3 reports. Individual folder coverage remains independent. No saved report is mutated; no contract, stored format, server, companion, dependency, lockfile, hosting identity or startup import changed.

All fixtures are synthetic. The main fixture passes the unchanged saved-report validator, keeps project owner totals at 56 messages across 11 chats while folder owner totals differ, and reports 43 owner turns across 8 Claude Code cloud sessions from the second folder. Additional coverage proves summation when both folders include the same provider.

## Verification

Node `v24.14.1`, npm `11.11.0`; existing installed dependencies were used after the required locked installer was blocked.

- RED: the worker temporarily saved the implementation bytes, used the original `HEAD:lib/dashboard/model.ts`, and restored the implementation in `finally`. `node --experimental-strip-types --test --test-isolation=none --test-name-pattern="multi-folder briefing sums" tests/dashboard-model.test.ts` reported one expected assertion failure: original output had 12 local commits and 9 cloud commits with unrecorded cloud-chat coverage, while expected output had 17 local commits, 15 cloud commits and 43 owner turns across 8 Claude Code cloud sessions. Both outputs kept the project-wide 56 messages across 11 chats. This was a test assertion failure after fixture validation, not a subprocess setup failure.
- GREEN: the restored model suite passed 20/20. Integrator affected-suite verification passed 99/99 with no failures or skips, using the command below. The existing SQLite experimental warning was emitted.
- `npm run typecheck`: passed.
- `npm run lint`: passed with zero errors and 15 existing warnings outside the changed files.
- Independent exact-model review found no runtime defects; its fixture-validity and owner-total regression recommendations were applied.
- `git diff --check`: passed.

```powershell
node --experimental-strip-types --test --test-isolation=none tests/dashboard-model.test.ts tests/dashboard-feed.test.ts tests/dashboard-format.test.ts tests/dashboard-display-boundaries.test.ts tests/mission-control-render.test.ts tests/simple-ui-render.test.ts tests/briefing-feed-source.test.ts tests/briefing-feed-save.test.ts tests/project-folder-briefing-client.test.ts tests/project-briefing.test.ts tests/project-briefing-contract.test.ts
```

## Environment limits and handoff

- `npm run install:ci` failed with `spawn EPERM` in `scripts/npm-install.mjs:153` before installation. The lockfile is unchanged.
- `npm test` could not start any of its 370 test-file subprocesses (`spawn EPERM`); test bodies were not reached. The in-process affected-suite pass above is separate evidence.
- `npm run build` packaged the ignored companion ZIP, then failed resolving Vite configuration because subprocess creation returned `spawn EPERM`. There is no passing build, browser, live-PC or deployed result for this change.
- `git add -- lib/dashboard/model.ts tests/dashboard-model.test.ts` failed to create `.git/index.lock` with permission denied. All changes remain uncommitted as requested for this sandbox limitation; nothing was pushed, merged or deployed.
- Original UTC timestamps for this session's owner messages were unavailable. No owner-turn handoff or timestamps were fabricated; current observation times cannot substitute for message timestamps.

The integrator should run locked installation, the default full suite, build and browser acceptance in an environment permitting subprocesses, review the diff and commit the five changed files. Any later publication remains separately authorized work.
