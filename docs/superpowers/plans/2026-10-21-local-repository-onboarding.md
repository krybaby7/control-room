# Local repository onboarding implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development to implement this plan task-by-task. The integrator owns shared contracts, central wiring and release; GPT-6.1 Sol workers own disjoint helper, storage and UI files.

**Goal:** Add a local repository, obtain a finite read-only AI briefing and retain it privately in Control Room.

**Architecture:** An authenticated browser pairs with a loopback companion and saves its bounded report as versioned project evidence using existing workspace transactions. The companion reads a filtered working snapshot and invokes an exact-model subscription CLI without model tools. Existing agent-coordinator authority and saved planning remain separate.

**Tech Stack:** Node 24 standard library, existing Codex CLI, React/TypeScript, existing D1 evidence tables and workspace receipts.

## Task 1 — Contract and local transport

Files: `shared/local-analysis.mjs`, `shared/local-analysis.d.mts`, `tests/local-analysis-contract.test.mjs`, `companion/*`, `tests/local-companion.test.mjs`.

- [ ] Write failing contract tests for a valid cited report, malformed paths, unexpected model, invalid dates, overlong content and oversized serialized report.
- [ ] Export `validateLocalAnalysis(value)` and `reportContentSchema`; report format is `control-room-project-analysis`, version 1, limited to 9600 JSON characters. It contains repository/snapshot/run provenance and bounded summary, architecture, findings, suggestions and limitations.
- [ ] Write real HTTP/snapshot tests before helper implementation. Require token on status, run, result and cancellation; exact Host/Origin; no wildcard CORS; local folder registration only.
- [ ] Implement `createCompanion({repositories, origin, port, stateDirectory})`, local pairing page and `node companion/cli.mjs --repo PATH --state-dir PRIVATE_PATH`.
- [ ] Validate the installed CLI without invoking a model, then support one bounded run with disabled model tools and no automatic retry. Validate model output and exact file citations locally.
- [ ] Run `node --test tests/local-analysis-contract.test.mjs tests/local-companion.test.mjs`.

## Task 2 — Private durable reports

Files: `lib/local-analysis-handler.ts`, `lib/local-analysis-store.ts`, `app/api/local-analysis/route.ts`, `tests/local-analysis.test.ts`, central `lib/workspace-handlers.ts` registration.

- [ ] Test `local-analysis.save` with real SQLite: active owner project required; immutable evidence version and project context link saved atomically; stale expected version rejected; planning unchanged; foreign-owner report inaccessible.
- [ ] Save the validated JSON in an existing evidence version, marker `control-room-local-analysis-v1`, basis `documented-result`, scope `implementation`. Refresh appends a version and its exact context link.
- [ ] Export `localAnalysisCommandHandlers` and `readLocalAnalyses(db, owner, projectId?)`; GET returns only the signed-in owner's bounded reports with private no-store headers.
- [ ] Register the handler through the existing workspace registry and verify audit kind handling.
- [ ] Run `node --experimental-strip-types --test tests/local-analysis.test.ts` and evidence/export regressions.

## Task 3 — Browser onboarding

Files: `components/local-repository-onboarding.tsx`, `lib/local-companion-client.ts`, `components/control-center.tsx`, `components/projects-view.tsx`, selected component/browser tests.

- [ ] Add an **Add local repository** entry from Projects. Pair through a code held only in component memory, show registered repositories and clear disconnected/error states.
- [ ] **Add and analyze** creates an owner project only when requested, starts exactly one idempotent request and polls authenticated status. Show cancellation, local report awaiting save and reconnection recovery.
- [ ] Save through the existing `onCommand`/receipt path. Retain the report after conflict/uncertainty and offer save retry without rerunning inference.
- [ ] Show saved understanding on project detail with source snapshot, timestamp, exclusions, model request/observation and explicit suggestions. Use normal task editor for any selected suggestion.
- [ ] Exercise actual Sites-origin loopback transport before claiming browser compatibility.

## Task 4 — Verification and private release

- [ ] Review spec compliance then implementation quality with GPT-6.1 Sol; fix findings before release.
- [ ] Run targeted tests, `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, and appropriate browser checks. Reuse unchanged dependency installation and preserve lockfile.
- [ ] Retain a fresh private pre-release export outside Git. Use the supported Sites source/build/archive/deploy workflow for the existing owner-private project and URL.
- [ ] Start the reviewed local helper against the owner-selected folder. Test a real exact-model analysis, save/readback after reload and unchanged source repository status.
- [ ] Publish public source changes on a reviewable branch/draft PR only; never commit private repo paths, reports, snapshots, login state or pairing codes.
- [ ] Record source/version, actual verification, local startup instructions and any concrete remaining limitation.
