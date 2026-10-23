# Project Lanes and Conversation History Implementation Plan

> **For agentic workers:** Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` when available. Execute the numbered chapter checklists, update `progress.json`, and retain verification evidence. This package is a plan for later implementation, not a claim of completed functionality.

**Goal:** Give the owner a simple Project lanes overview whose area briefings, observed progress and pending work stay current from all available Codex and Claude Code local/cloud conversations, with measurable coverage and explicit gaps.

**Architecture:** Extend the existing private Sites/Vinext app. A read-only local collector and separately verified cloud adapters feed immutable, owner-scoped history records outside the bounded planning JSON. Incremental reconciliation produces persistent area stories and cited progress observations; explicit owner commands still control commitments and acceptance.

**Tech stack:** Existing React 19, TypeScript, Vinext/Vite, Zod, Drizzle and Cloudflare D1; Node 24 collector/test runner; private R2 for immutable history chunks; the existing Sites identity/connector integration. New dependencies must be justified, pinned and recorded in the lockfile.

## Approved product decisions

- Default home: **Project lanes**, all active projects visible, one compact row per stable area, with progress and anything needing the owner highlighted. The user chose this over Compact cards on 22 October 2026.
- Each task displays project, area and work type wherever it appears. Status and priority remain available as secondary metadata.
- Example classifications: `TAMENNI / Android testing / Planning` for `Define Android device acceptance`; `TAMENNI / Map / Review` for `Review the landmark map source and PR`.
- Opening an area reveals Finished, Still open and Next, followed by roadmap/checkpoints, tasks and evidence. Expand in place; keep the overview in view. Raw history and connection diagnostics are secondary views.
- Stable project identity can span several repositories: TAMENNI application and map-lab work belong to one product while retaining their repository/branch identities.
- Cloud Claude scope is **Claude Code web/cloud sessions**, not ordinary Claude.ai chats or Cowork.
- Equal priority for TAMENNI and Trade Graph remains. No invented deadlines, progress percentages, accepted checkpoints or priority changes.

## Five requirements and delivery map

| Requirement | Implementation | Mandatory proof |
|---|---|---|
| 1. Import the available past, then collect changes | Chapters 1–2 | Complete pagination/inventory reconciliation, resumable import, explicit missing-content records |
| 2. Automatic updates plus catch-up | Chapter 3 | Restart, missed event, resumed old chat and offline recovery; actual unattended run |
| 3. One continuing story per project area | Chapter 4 | Cross-chat resolution, deduplication, cancellation/supersession and persistent open work |
| 4. Automatic observed progress with meaningful completion | Chapters 1, 4–5 | Cited implementation/test/release facts never silently become owner acceptance |
| 5. Measurable history coverage | Chapters 1–3, 5 | Scope, gaps, partial reads, last successful collection and stale/error states agree with inventory |

## Read in order

1. [START-HERE.md](START-HERE.md): copy-ready GPT‑6.1 Sol launch prompt.
2. [01-foundation-contracts.md](01-foundation-contracts.md): baseline, migration, shared records, transaction/storage contracts.
3. [02-history-collection.md](02-history-collection.md): full initial import, local readers, cloud capability investigation.
4. [03-automatic-sync.md](03-automatic-sync.md): durable capture, transport, scheduling, reconciliation and freshness.
5. [04-project-understanding.md](04-project-understanding.md): association, claim extraction, persistent area stories and evidence.
6. [05-project-lanes-and-release.md](05-project-lanes-and-release.md): simple UI, full acceptance matrix and release.
7. [progress.json](progress.json): interruption/resume checkpoint and separate live gates.

## Relationship to the October 18 completion program

Read root `AGENTS.md`, `docs/source-import.json` and the older master/coverage ledger for context. Their source-preservation, private-hosting, ownership, receipt/CAS, export and model rules remain applicable. This package narrows and updates the history/UI scope; it does not require executing all eight older phases first.

Reuse already-implemented equivalents if the implementation checkout has advanced. In the inspected local checkout, `lib/workspace-transaction.ts`, the module export registry, source observation store, job runner and review store are **planned, not implemented**. Chapter 1 builds the minimum needed portions. Do not import imaginary modules or claim an old checkbox proves implementation.

Reconcile these overlaps explicitly in `docs/implementation/project-lanes-history/baseline.md`:

| Older area | Required subset here | Defer unless independently necessary |
|---|---|---|
| Phase 1 foundation | Guarded owner transaction, durable receipts, operational CAS, portable module export/restore, object lifecycle | Offline draft outbox, generic capacity cleanup, full backup UI |
| Phase 2 planning | Areas, task classification, lane navigation, existing task/milestone behavior | Recurrence, estimates, generic dependency graphs |
| Phase 3 evidence | Immutable citations, observed versus accepted states, audit events for new commands | Generic undo and broad document attachment editor |
| Phase 4 sources | GitHub evidence reads, full available conversation inventory, selected-scope automatic ingestion | Drive/Office/PDF integrations |
| Phase 5 reviews | Area snapshots, one job substrate, meaningful change detection | Weekly review redesign and general notification center |
| Phase 6 PC bridge | Reuse device enrollment/transport if present; separate history scope | Hardware/process telemetry |
| Phase 7 agents | Reuse configured analysis runtime contract if available | Arbitrary coding dispatch, trading actions, Agent Lab benchmark orchestration |

The new history collector must not silently widen the telemetry bridge's permissions. It has its own `history.read`/`history.ingest` scope and source selection.

## Evidence as of 22 October 2026

These are observations from a read-only discovery, not deployment acceptance:

- Both providers have local conversation-bearing logs, including project association and tool-result records. Codex includes compressed and segmented history; Claude includes subagent and compaction records. Prompt/title indexes omit retained transcripts and cannot be authoritative inventories.
- Some older Claude prompt-index entries have no matching transcript in the inspected local store. Preserve a gap; do not claim deleted content can be reconstructed.
- A Codex cloud chat was readable through this desktop's chat tools, while the desktop-bundled CLI's `cloud list --json` returned an empty task list. Account/backend/surface coverage must be investigated; an empty list is not a completeness proof.
- Claude Code documents teleporting full cloud history to a local session, but teleport also fetches/checks out a branch and resumes a session. Do not run it as an invisible background reader.
- Anthropic's Compliance session API explicitly excludes Claude Code cloud sessions. It is not a shortcut for this scope.
- No persistent collector, unattended cloud reader or automatic project synthesis has been activated by this planning task.

Revalidate provider versions and current official interfaces during implementation. References: [Codex app-server](https://learn.chatgpt.com/docs/app-server), [Codex CLI](https://learn.chatgpt.com/docs/cli/reference), [Claude local session SDK](https://code.claude.com/docs/en/agent-sdk/sessions), [Claude storage](https://code.claude.com/docs/en/claude-directory), [Claude hooks](https://code.claude.com/docs/en/hooks), [Claude Code cloud](https://code.claude.com/docs/en/claude-code-on-the-web), [Compliance coverage](https://platform.claude.com/docs/en/manage-claude/compliance-sessions).

## Execution stages and ownership

| Stage | Result | Dependencies | Owner |
|---|---|---|---|
| S0 | Baseline and capability inventory | None | Integrator |
| S1 | Areas, provenance, storage and transaction contracts | S0 | Integrator |
| S2 | Resumable local import and cloud discovery | S1 | Separate Codex and Claude reader workers |
| S3 | Automatic capture and durable sync | S1; first S2 adapter | Transport/scheduler worker |
| S4 | Cross-chat area memory and evidence verification | S1; S2 normalized fixtures | Synthesis worker |
| S5 | Project lanes with real state | S1; S4 projection contract | UI worker |
| S6 | End-to-end verification and private release | Applicable prior stages | Integrator + independent reviewer |

After S1 contracts are locked, S2, S3, S4 and UI work against fixtures may run in parallel. Include C1's scope/segment definitions and Chapter 4's claim/progress additions in that S1 freeze; do not freeze only the first code block and let workers invent incompatible extensions. Assign disjoint files. One integrator owns `lib/types.ts`, `lib/planning.ts`, validation, `db/schema.ts`, migrations, dependency lockfile and central UI wiring. The shared roadmap/acceptance subset is F6.

Use exactly `gpt-6.1-sol` for implementation/review workers, selected by the runtime model parameter. Record accepted model requests and returned worker IDs. If unsupported, stop model-dependent work and report that limitation; do not substitute another model or rely on a model's self-description.

## Completion vocabulary

- **Implemented:** code and synthetic tests pass.
- **Verified local:** actual local transcript import plus a subsequent update passed, with source collection left read-only.
- **Verified unattended:** a newly started collector/runner works with the development terminal/browser closed, survives restart and records successful durable ingestion.
- **Verified hosted:** authorized private deployment ingests/displays real records correctly and preserves existing data.
- **Full requested coverage:** all four required source classes have verified inventories and automatic content reads for the connected account/device scope, all known retained histories have been read, and remaining historical losses/exclusions are explicitly recorded. Never translate this into a claim of access to deleted/unretained history.

Partial releases are useful, but must keep missing sources visible. A fixture cloud adapter or manual import cannot satisfy automatic cloud coverage. Continue independent implementation around access gaps and leave those exact live acceptance rows open.

## Implementation workflow

- [ ] Inspect the actual branch, instructions and current files; preserve unrelated edits and original owner IDs.
- [ ] Use an implementation branch; record the actual starting SHA, not a historical provenance SHA that may not exist in GitHub.
- [ ] Run `npm run install:ci` under Node 24, then the existing `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`.
- [ ] Complete each task with a meaningful failing behavior test, implementation, passing focused check and a reviewable commit. Do not add tests that merely mirror presentation markup.
- [ ] Update the checkpoint after each task with changed files, SHA, test command/result, blockers and next action.
- [ ] Keep private transcript bytes, account identifiers, machine paths and real screenshots out of the public repository. Use synthetic fixtures. Secrets remain in the appropriate private credential store.
- [ ] Add new script names before invoking them; `test:e2e` is not present in the inspected baseline.
- [ ] Before a coherent release, run the full baseline checks plus new collector/story/browser tests, obtain independent review, and use supported private Sites publishing if available. Otherwise deliver verified code and an explicit publication handoff. Do not merge a PR automatically.

## Non-goals

No changes to the content of source chats; no automatic sending of messages to agents; no auto-resume/teleport; no replacement Site; no public transcript hosting; no trading execution; no promise that a passing build proves device readiness or profitability. The inference provider used at runtime is a configuration decision, separate from the required implementation-agent model. Do not activate new paid inference without exact model/provider and approved budget.
