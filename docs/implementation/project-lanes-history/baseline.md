# Actual cloud baseline — 22 October 2026

The implementation branch is `feat/project-lanes-history-cloud`, transferred at `916b9bfa1c01228992826605d1cbca3d2002c218`, tree `3a5e9ec3829ee9c4bd7fbcbb329781486549aec2`, parent `0e4e5098dc96d09d5b4c9dac33a9ee149bf8bcfe`. The preserved 47-path briefings increment is public commit `17f7103e131bd6b9979a404d8a7535bba3b3a661`, identical tree `08a6b569fe0fc47c30df023dec2d0e0a2970094c` to local test commit `b75e2c87eb312bbf86deeb4c27e12e667b83a3cc`. API and local commit metadata differ; source bytes agree.

The existing managed cloud checkout was inspected before switching: no tracked changes, an older implementation branch and untracked synthetic benchmark files were preserved. No original Windows checkout was touched. Node24.19.0 executes commands here. No cloud-environment skill is installed in the available skill catalog; the installed Sites skill governs any later existing-Site preparation/publication. Existing Site identity, private access and declared DB/BUCKET bindings remain unchanged. A declaration is not proof of an active hosted history binding.

## Fresh immutable-baseline checks

Checks ran in an isolated detached cloud worktree at the exact imported commit above, before new behavior was added:

| Command | Actual result |
|---|---|
| `npm run install:ci` | Passed;690 locked packages installed |
| `npm test` | Passed;1936tests,1936pass,0failed/cancelled/skipped;189341.639901ms |
| `npm run typecheck` | Passed |
| `npm run lint` | Failed;21errors/28warnings. All21errors came from a generated `.baseline-render-*` CommonJS test bundle left inside the checkout; narrow cleanup investigation pending. This failure is retained. |
| `npm run build` | Passed, including companion prebuild |

Historical Node22 briefings results are preserved in the imported record; the fresh Node24 full-suite pass supersedes neither its failures nor unverified Windows/provider behavior.

## Existing equivalents to extend

- Actual planning schema is v4, not the stale v2 source described by local preparation. Next version is v5. Existing compact codec, archived completion history, weekly pins, owner baselines, receipt/CAS and export schemas must survive.
- `executeWorkspaceCommand`, guarded module writes, immutable audit, durable receipts, mutation/execution epochs, `workspace_job_intents`, bounded D1 recovery admission, typed reference and module export registries are implemented. Do not create a competing planning writer or queue.
- Structured evidence/owner acceptance, sources/reviews, protected Windows bridge, owned-process executor, personal repository onboarding, mission-control dashboard and project briefings already exist. Keep their original scope and authority. New history collection gets separate `history.read`/`history.ingest` permission.
- Existing scripts include `test:e2e`, native D1/R2/HTTP checks, `test:bridge`, `test:companion`, `test:github`, benchmark and package scripts. Reuse these before adding overlapping commands.
- SQL tests use a new in-memory SQLite database with every ordered migration and synthetic owners. Never reseed, restore or destructively test the existing hosted owner data.
- Earlier program evidence was read from checkpoint `ded3953e6e36a5c9d05df0ff8c0ed3536545d977`: exact E1 verification,48-gap ledger,resume checkpoint and release handoff. Those source-specific cloud passes do not certify this newer branch. Its real owner backup, hosted/provider/device acceptance limitations remain applicable. Unrelated older phase statuses remain unchanged by the new program.

Four source classes remain independently unverified here. See capabilities.md and cloud-capability-proof.md. A fixture parser, empty CLI list or a manual import never proves unattended or all-history coverage.
