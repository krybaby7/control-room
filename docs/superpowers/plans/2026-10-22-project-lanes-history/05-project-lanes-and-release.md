# Project Lanes and Release Implementation Plan

> **For agentic workers:** Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` when available. Follow the checkboxes; keep implemented and live-verified gates separate.

**Goal:** Make every project's progress, recent outcome and pending action understandable from one consistent overview, then verify the complete collection-to-display path.

**Architecture:** A read-only lane projection joins planning, area stories and source coverage. Owner edits use the existing mutation client; operational refreshes use a separate watermark and cannot reset open forms. Details expand beneath their area.

**Tech Stack:** Existing React/TypeScript/CSS, shared workspace API/client, Node tests and a small Playwright browser suite against isolated synthetic data.

## Approved screen structure

The default Today screen becomes Project lanes. Use the current visual language and existing navigation. Keep a single reading direction, stable project/area order, clear typography and generous row spacing.

```text
CONTROL ROOM                  Updated 2 min ago · 1 source needs attention
Your projects                                              Capture +

TAMENNI                                      2 things need you
Area             Progress                  Latest / next
Android testing  [checkpoint strip]         Acceptance still needs a device run
Map              [checkpoint strip]         Review the source and PR
  Expanded Map:  Finished | Still open | Next
                 Roadmap · Tasks · Evidence

TRADE GRAPH                                  1 thing needs you
Area             Progress                  Latest / next
...

This week  [collapsed summary; opens the existing commitment controls]
```

Text above is illustrative, not a statement that current project records have those exact counts or states. Render real projections or explicit empty states. Project summaries may use at most one sentence; area rows use one short status/next-action line. Show more details on expansion. Do not duplicate the same task in a separate home-page Next up feed.

Progress strips represent named checkpoints, with distinct observed and accepted states. Show `3 of 8 checkpoints accepted` only when the owner has agreed the eight-checkpoint scope. Without defined scope show `Scope not set`; without history show `No history yet`. Empty bars must not imply zero work. Color is supplementary to labels/icons.

## Task L1 — Lane projection and read endpoint

**Create:** `lib/history/lane-projection.ts`, `lib/history/client.ts`, `app/api/history/lanes/route.ts`, `app/api/history/conversations/[conversationId]/route.ts`, `app/api/history/messages/[messageRevisionId]/route.ts`, `tests/history-lanes.test.ts`, `tests/history-lanes-route.test.ts`.

**Read/reuse:** Chapter 4's checkpoint/progress projection, `lib/history/contracts.ts`, `lib/workspace-client.ts`, and the current authenticated route conventions.

Define a UI projection, not another authoritative store:

```ts
export interface AreaLaneSummary {
  projectId: string;
  areaId: string | null;
  title: string;
  agreedScope: boolean;
  checkpoints: Array<{
    id: string;
    label: string;
    observed: 'unknown' | 'planned' | 'in_progress' | 'implemented' | 'verified' | 'released';
    accepted: boolean;
  }>;
  needsOwnerCount: number;
  nextAction: string | null;
  storyId: string | null;
  freshness: 'current' | 'syncing' | 'partial' | 'stale' | 'error' | 'unverified';
}

export function progressLabel(lane: AreaLaneSummary): string {
  if (!lane.agreedScope || lane.checkpoints.length === 0) return 'Scope not set';
  return `${lane.checkpoints.filter(c => c.accepted).length} of ${lane.checkpoints.length} checkpoints accepted`;
}
```

Chapter 4's authoritative model may express stage states differently; map them explicitly in this file and test each mapping. Never cast a rejected, conflicted or outdated observation to `verified`. `needsOwnerCount` counts deduplicated unresolved owner decisions/acceptance requests, not all unfinished work. The `Unclassified` row uses null area and remains visible when it contains work. Unknown repository conversations appear under a compact `Unassigned history` indicator with a mapping action; they cannot disappear from coverage.

- [ ] Create synthetic projection fixtures with two projects, several areas, one unclassified task, one accepted checkpoint and one implemented-but-unaccepted checkpoint. Assert `progressLabel` returns `1 of 2 checkpoints accepted`, including when the second has passed software checks.
- [ ] Test zero checkpoints, partial source history, stale story watermark, conflicting evidence, archived area links and stable ordering when a newer chat arrives. Sorting can be changed explicitly, but refresh must not reorder lanes under the pointer.
- [ ] Run `node --experimental-strip-types --test tests/history-lanes.test.ts tests/history-lanes-route.test.ts`; expect failures before the projection/route exists.
- [ ] Implement `GET /api/history/lanes` with server-derived owner and private no-store caching. Return planning revision, operational watermark, lane rows and a coverage summary. Bound detail responses and read full history via a paginated endpoint, never embedding transcripts in every lane response.
- [ ] Implement the conversation/message detail routes with owner checks, stable cursors and immutable revision selection. The evidence viewer can page through the entire retained conversation, resolve quoted spans and open a verified native/provider deep link when supported. If no native deep link exists, show the retained transcript and source identity; do not fabricate a URL. Display unavailable segments/attachments inline.
- [ ] Test unauthenticated access, two-owner isolation, unknown area and no misleading fresh timestamp when the story trails ingestion. Return separate collection and analysis times so a newly collected message does not make an old summary appear current.
- [ ] Run the focused tests plus `npm run typecheck`; commit `feat: expose project lane projections with honest progress`.

## Task L2 — Default home and area detail

**Create:** `components/project-lanes.tsx`, `components/area-briefing.tsx`, `components/checkpoint-progress.tsx`, `components/history-evidence.tsx`.

**Modify:** `components/today-view.tsx`, `components/control-center.tsx`, `components/projects-view.tsx`, `app/globals.css`.

- [ ] Add the lane projection read to the central controller separately from workspace mutation state. Preserve the existing project/task editing callbacks and deep-link selection state.
- [ ] Replace the default overview's scattered project cards/Next up/review panels with one project stack using the approved structure. Keep Capture accessible in the header. Put weekly commitments/carry-forward behind one labelled expandable section; all existing actions remain reachable.
- [ ] Render project name, area name, checkpoint strip, current status/next action and needs-owner count in aligned columns. On narrow screens stack these same fields inside one area row, without horizontal scrolling or tiny badges.
- [ ] Expand an area in place. Present Finished, Still open and Next in that order; collapse long lists after the first three items with a count and Show all. Every synthesized fact can reveal its citations, date and evidence basis. Use `Observed` or `Inferred` on relevant finished claims; reserve accepted completion indicators for explicit owner state.
- [ ] Link roadmap checkpoints to their associated tasks, observed evidence and acceptance action. Let the owner choose accept/reopen/correct through normal guarded commands, with confirmation only when required by existing product semantics. Do not create an extra blanket approval step for reading a briefing.
- [ ] Add a compact Edit roadmap control in area detail that edits F6's checkpoint labels/criteria/task links, saves a scope revision and lets the owner agree the scope. Show historical acceptance separately after criteria changes. A suggested roadmap can prefill an unsaved draft but cannot agree itself.
- [ ] Keep project detail for editing scope and longer lists; reuse the same area briefing component there. Preserve archive/search, captures, sources and existing baseline proposals. A historical baseline remains visibly dated and cannot override newer evidence silently.
- [ ] Use accessible buttons with `aria-expanded`, labelled progress cells, visible focus, keyboard operation, adequate contrast and reduced-motion support. Do not rely on hover for state or evidence.
- [ ] Run `npm run typecheck` and `npm run lint`; commit `feat: make project lanes the default control room overview`.

## Task L3 — Task context everywhere and safe refresh

**Create:** `components/task-context.tsx`, `tests/task-context.test.ts`, `tests/history-refresh.test.ts`.

**Modify:** `components/ui.tsx`, `components/task-editor.tsx`, `components/capture-editors.tsx`, `components/planning-editors.tsx`, `components/today-view.tsx`, `components/projects-view.tsx`, `components/inbox-view.tsx`, `components/project-baseline.tsx`, `components/control-center.tsx`, `lib/workspace-client.ts`.

Use one formatter for the metadata label, reused by all task renderers:

```ts
export function taskContext(project: string, area: string | null, workTypeLabel: string) {
  return [project, area ?? 'Unclassified', workTypeLabel].join(' / ');
}
```

The proposed file is a component; move the pure formatter to `lib/areas.ts` so Node tests can import it without a JSX loader. Work type labels come from one exhaustive mapping of Chapter 1's `WorkType`, with `other` shown as `Other`. Do not infer classification merely for display.

- [ ] Add assertions for `TAMENNI / Android testing / Planning` and `TAMENNI / Map / Review`, plus unclassified legacy tasks. Create these as synthetic fixtures; applying labels to actual tasks is an owner command or an accepted mapping proposal.
- [ ] Find every task title renderer with `rg 'task\.title|proposal\.title' components`; list the results in implementation notes and use the shared context component in lists, weekly focus, search, task detail, capture conversion and proposals. Avoid repeating the project name in every visual row when an enclosing project heading already supplies it; retain area/type visibly and complete context in the accessible label.
- [ ] Add editable Area and Work type fields to task/capture conversion forms. Preserve them on unrelated edits, archive/restore, baseline conversion, import/export and project changes. Keep status and priority secondary, visible in task detail and where decisions need them.
- [ ] Implement operational polling/backoff in `lib/history/client.ts` or reuse a proven supported push channel. Fetch only while visible; refresh immediately on returning to the app. This is display refresh, not the collection scheduler.
- [ ] Test with a dirty task draft while an ingestion/story watermark changes: draft title/area remain intact, planning revision is unchanged by ingestion, and fresh lane data appears. An actual conflicting owner edit still uses the existing conflict handling.
- [ ] Run `node --experimental-strip-types --test tests/task-context.test.ts tests/history-refresh.test.ts`; commit `feat: show task area and type across control room`.

## Task L4 — Coverage and connection controls without clutter

**Create:** `components/history-coverage.tsx`, `components/history-connections.tsx`, `tests/history-coverage-ui.test.ts`.

**Modify:** `components/sources-view.tsx`, `components/control-center.tsx`, `components/project-lanes.tsx`.

- [ ] Add a single compact freshness line above lanes. It summarizes the worst relevant collection/analysis state without declaring all sources current based on one provider's success. A current-source timestamp cannot clear another source's stale/error badge.
- [ ] On expansion, show all four required source classes with configured scope, discovered/read/partial/unavailable counts, unresolved gaps, last inventory/read success, analysis watermark/time and unattended verification state. Separate `Not connected`, `Unsupported`, `Awaiting verification`, `Partial` and `Current`.
- [ ] Explain each gap in plain language and provide one relevant action: reconnect, retry, enroll another device, map repository, inspect missing segment or export/import. Label manual imports as manual. Regular Claude.ai/Cowork chats are outside the selected scope and must not inflate Claude Code cloud coverage.
- [ ] Provide source selection, pause/resume, disconnect and explicit removal using the Chapter 1/3 command boundaries. Keep detailed collector logs in the diagnostic view and redact paths/tokens from shared views.
- [ ] Test status priority, truthful partial counts, restart liveness expiry and a source with zero discovered records but unverified inventory. Expected output is `Awaiting verification`, never `All caught up` for the last case.
- [ ] Run `node --experimental-strip-types --test tests/history-coverage-ui.test.ts` and typecheck; commit `feat: expose history coverage and actionable source gaps`.

## Task R1 — Browser and system acceptance

**Create:** `tests/e2e/project-lanes.spec.ts`, `tests/e2e/history-sync.spec.ts`, `playwright.config.ts` if absent, `docs/implementation/project-lanes-history/acceptance.md`.

**Modify:** `package.json` and lockfile only if a pinned browser-test dependency/script is needed. Use the established app preview workflow; do not introduce an auth bypass into production code.

- [ ] Add `test:e2e` before invoking it. Configure a separate synthetic owner/database/object store and the platform's existing test identity mechanism. If a test identity facility is unavailable, test components with injected fixtures and perform authenticated end-to-end checks in a private preview; document the exact remaining automation gap.
- [ ] Implement browser scenarios: lanes are the initial view; expanding Map shows finished/open/next; Android planning and Map review labels differ; an observed implementation remains unaccepted; pending work survives another unrelated chat; partial cloud coverage remains visible; dirty drafts survive refresh; keyboard navigation works.
- [ ] Capture desktop and narrow-phone screenshots with synthetic data. Check 1440px and 390px widths, 200% zoom, long project/area names, many areas, empty state and error state. No overlapping text, body horizontal scroll or unreachable actions. Keep screenshot artifacts free of actual chat content.
- [ ] Exercise one complete synthetic path: initial multi-page import → duplicate retry → resumed old conversation → claim reconciliation → lane refresh → explicit owner acceptance → export → isolated restore. Assert old content/citations remain inspectable and restored connections are paused.
- [ ] Run `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, then the new `npm run test:e2e`. Record actual counts and failures, not simply command names. Fix failures in scope and rerun affected checks.
- [ ] Commit `test: verify project lanes and history reconciliation end to end`.

## Task R2 — Live verification ledger

Record each gate below separately in `progress.json` and the implementation acceptance file. Synthetic tests never substitute for live proof. Private details stay in the private evidence store; repository notes contain sanitized outcomes only.

| Gate ID | Required observation | Failure effect |
|---|---|---|
| G-local-codex | Enumerate retained local Codex scope, import compressed/segmented bodies, compare inventory with a few known retained old/new conversations, then ingest an update to an older conversation | Local Codex remains unverified/partial |
| G-local-claude | Enumerate Claude project/subagent scope with compaction, account for known index-only missing transcripts, ingest a later update | Local Claude remains unverified/partial |
| G-cloud-codex | List correct connected account/backends with every page and archive/source class, read a known cloud thread's full available content, capture a subsequent change through the proposed unattended runtime | Cloud Codex remains unverified; desktop tool success alone fails gate |
| G-cloud-claude | Prove a supported read-only Claude Code web/cloud inventory/content path and subsequent unattended change read under the connected account | Cloud Claude remains unavailable/partial; manual teleport/import fails automatic gate |
| G-unattended | Start installed local collector; close development terminal/browser; capture later activity; restart collector/machine and catch up offline changes; hosted scheduled work runs independently | Automatic operation remains unverified |
| G-story-runtime | Use the explicitly configured/authorized inference runtime on selected retained history; compare cited finished/open/next with human-inspectable source passages, including a multi-chat unresolved loop | Semantic understanding remains unverified; deterministic test fixtures are insufficient |
| G-private-hosted | Existing private Site reads new tables/objects correctly; an unrelated identity cannot read them; owner edits/recovery work and prior records survive | Hosted release remains unverified |
| G-owner-workflow | Owner can identify each project's current areas, locate pending decisions, understand task context and open supporting chats without hunting across multiple feeds | Usability acceptance remains open; implementation can be ready for review |
| G-physical-acceptance | Any real device/deployment/operational requirement attached to project checkpoints has its own recorded evidence and owner acceptance | Such project checkpoints stay pending; not a blocker to shipping Control Room |

- [ ] Run live checks only on connected authorized sources and the selected history scope. Record collector/provider versions, time, sanitized counts, capabilities and remaining limitations. Do not manufacture a new coding turn merely to make a source appear active; reuse actual user activity or a synthetic dedicated test conversation.
- [ ] When a cloud API is unsupported, complete the adapter state/UI/manual import/retry path and continue other work. Record which missing capability prevents the gate; do not call the entire source automatic or the five-point objective complete.
- [ ] If local-only work cannot execute in a cloud worker, deliver a runnable packaged collector and exact Windows installation/start/diagnostic instructions from Chapter 3, then leave the corresponding live gate pending for the enrolled machine.
- [ ] Keep current owner task completion/acceptance intact during verification. A Control Room test pass cannot mark Android device acceptance, a map promotion or a trading outcome complete.
- [ ] Commit sanitized verification notes with `docs: record live history coverage and release gates`.

## Task R3 — Review, private release and handoff

**Create:** `docs/implementation/project-lanes-history/release.md`.

- [ ] Ask a separate `gpt-6.1-sol` worker to review the integrated diff, migration/recovery paths, owner boundaries, multi-chat semantics and readability of the overview. Supply exact baseline/head refs and acceptance results. Record the accepted model parameter and returned worker ID; resolve substantive findings before publication.
- [ ] Preserve the existing private Site identity. Use its supported provisioning/publish workflow and current installed Sites skill. Back up through verified read/export facilities before applying migrations. Publish only within the user's authorized scope; if a final platform approval is required, present the tested concrete release and exact effect then.
- [ ] Verify the published private app using the owner's identity and a negative unauthorized-access check. Confirm old project/task IDs, weekly commitments and baseline markers survive. Record deployment/version and rollback instructions with previous code/schema compatibility, not a destructive production restore test.
- [ ] Create a draft PR when repository write access is available and attach it to the implementation task with the Codex artifact tool. Do not merge automatically. If publication/tools are unavailable, deliver code, checks and exact publication steps; keep G-private-hosted open.
- [ ] Update the new checkpoint and cross-reference the older program's gap ledger without marking unrelated phases complete. List implemented functionality, verified sources, disabled inference choices, open live gates and next runnable action.
- [ ] Deliver a brief walkthrough: overview → area briefing → cited source → owner action → connection coverage. The release is successful when the user can understand state from the lanes; every requested cloud source still needs its own truthful capability proof.
