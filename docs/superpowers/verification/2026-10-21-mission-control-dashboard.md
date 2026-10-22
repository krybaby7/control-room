# Mission control dashboard verification — 2026-10-21

This increment replaces the Today view with a mission-control dashboard on top of the current implementation branch head `f07f201` (`feat/personal-repository-connection`). It adds no database schema, dependency, hosted-audience, paid-provider or execution change. Every dashboard feed is a read-only owner read; the dashboard never issues a command.

## What the owner sees

- **Status strip**: enrolled PC heartbeat state with CPU/memory/GPU load and sample age when a fresh runtime sample exists; personal PC app presence with separate Codex and Claude Code readiness; agent counts (working, queued, awaiting approval, to reconcile); execution window state plus Codex Cloud report recency; the count of items that need the owner. The footer reports when the feeds were last checked and names any feed whose last read failed (its last good value stays on screen).
- **Project tiles**: milestone and task meters, a playful progress level (achieved milestones plus one per five completed tasks), status chips (in progress, review, blocked, overdue, pinned this week, proposed, current milestone), the live agent job on that project (operation, provider, requested/observed model, device, stage, work progress, elapsed time against the job's own timeout budget), the latest saved analysis with per-provider recent-chat coverage (message count and recency as reported by the companion; transcripts are never displayed), the last three saved activity lines, the next recommended action and token totals summed from recorded run results.
- **Live operations**: every active job with its event tail, active personal-PC analyses, and recent runs with recorded token usage, runtime, artifacts and acceptance state.
- **Needs you**: reviews, approvals, reconciliation, overdue work, carried-over pins and inbox captures, ordered by severity. **This week**, the **mission log** (saved workspace activity), the unchanged **Next up** queue (complete ordered ready work) and the unchanged saved project brief panel.

## Honesty boundaries kept

- Tokens, runtime seconds and model identity come only from recorded job results; while a run is active the tile says tokens are reported at completion.
- Codex Cloud work has no live telemetry in this application; the strip shows the recency of imported cloud reports and says live cloud task status is not connected.
- Lights describe heartbeats and saved records. Nothing on the dashboard approves, completes, pins or spends.
- Job specifications, results and event payloads are digest-checked before display; an invalid or tampered feed is reported as failed and the previous good value is retained with its check time.

## Live refresh

`lib/dashboard/feed.ts` reads `/api/jobs` (plus `/api/jobs/{id}` and its event pages for active attempts), `/api/runtime`, `/api/personal-repositories`, `/api/local-analysis` and `/api/github-analysis` with 15 s deadlines and a 2 MB body bound. The scheduler polls every 10 s while an agent or personal analysis is active and every 45 s otherwise, re-reads the saved reports at most every 90 s or when the workspace revision changes, backs off on failures (30/60/120/300 s), pauses while the tab is hidden and stops on session expiry. Elapsed timers tick every 10 s while something runs.

## Automated checks (this cloud environment, Node 22.22.0)

- New: `tests/dashboard-format.test.ts`, `tests/dashboard-model.test.ts`, `tests/dashboard-feed.test.ts`, `tests/mission-control-render.test.ts`: **18/18 passed** (view-model derivation, honest degraded states, scheduler pacing/backoff/visibility/expiry, snapshot reads with event-page following, tampered digest rejection, rendered panels).
- `npm run typecheck`: passed. `npm run lint`: 0 errors, 8 pre-existing warnings (none in the new files). `npm run build`: passed.
- `npm test` (default concurrency, run while browser checks and builds were also running): **1,920 cases, 1,917 passed, 2 failed, 1 cancelled**. The two failures are `tests/package-candidate-generated-output.test.ts`, which refuses this Node 22 environment by design ("Use the configured Node 24 Linux cloud packaging job"); the cancelled `tests/scheduled-backup-archive.test.ts` timed out under load and then passed **18/18** in isolation. Neither involves dashboard code.
- Playwright against the built Worker and isolated D1 fixture in the preinstalled Chromium (launched by executable path because the pinned headless shell is not installed here): new `tests/e2e/mission-control.spec.ts`, plus `ready-work.spec.ts` and `workspace-stream.spec.ts`, **passed**. `tests/e2e/sidebar.spec.ts` fails identically on the untouched branch head (the "More details" group is collapsed on Today, so "Briefs & automations" is not visible); it is pre-existing and unrelated to this change.
- The full-page screenshot from the fixture run (synthetic owner data only) was reviewed; two layout defects found there (a clipped provider chip and a stretched attention light) were fixed in CSS and confirmed on a rebuilt run.

## Not verified here

- No real agent job, PC heartbeat or personal-PC analysis was observed; the live states were exercised with synthetic records only. Hosted verification with the owner's enrolled PC and companion remains a local follow-up.
- No `gpt-6.1-sol` subagent workers were used: this runtime cannot select that model for workers, so the change was implemented and reviewed directly in the session. No provider was called.
