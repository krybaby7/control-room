# Phase 2 — Complete planning workflows implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing personal planning workspace usable for a changing portfolio, complete attention management, milestone workspaces, recurring work, and deliberate weekly planning.

**Architecture:** Retain Sites, Vinext/React and owner-scoped D1. Upgrade the bounded planning document from foundation schema v3 to v4; use normalized side tables for weekly plans, weekly review snapshots and recurrence. All changes use the foundation's shared revision, guarded transaction, durable mutation receipt and backup/export registry; no background process accepts suggested work on the owner's behalf.

**Tech Stack:** Existing TypeScript, React 19, Vinext, Drizzle/D1, Zod, Node 24 test runner with real in-memory SQLite; foundation browser test harness.

---

## Execution boundary and prerequisites

This is a plan for later cloud implementation, not authorization to mutate production during planning. Begin after [01-foundation-recovery.md](01-foundation-recovery.md)'s transaction, migration, backup, draft, timeout and local browser acceptance gates pass. Use its documented isolated checkout and local databases. Deploy only through the master plan's release gate. Continue with [03-evidence-history.md](03-evidence-history.md) after this phase passes.

The audited starting point is source `b50aa5c`: four views (`Today`, `Projects`, `Inbox`, `Sources`), editable fixed projects, task/milestone editors, same-project dependencies, six recommendations, a three-item review preview, manual Cairo-week pins, and a static 17 October baseline. This phase must preserve the signed-in owner's existing records and IDs. A changed seed must never reset saved planning data.

Read these existing files before work: `lib/types.ts`, `lib/planning.ts`, `lib/workspace-validation.ts`, `lib/project-baselines.ts`, `lib/calendar.ts`, `lib/weekly-summary.ts`, `lib/workspace-store.ts`, `components/control-center.tsx`, `components/projects-view.tsx`, `components/task-editor.tsx`, `components/planning-editors.tsx`, `components/inbox-view.tsx`, `components/today-view.tsx`, `components/ui.tsx`, and `tests/helpers/sqlite.ts`.

Foundation APIs used here are proposed by the foundation chapter, not present in the audited source:

```ts
// lib/workspace-transaction.ts — foundation-owned public contract
// userId is derived by the authenticated route, never by request JSON.
executeWorkspaceCommand(userId, {
  protocolVersion: 1,
  expectedRevision,
  mutationId,
  command,
}, { db, now, handlers });
// handlers.prepare({ userId, before, command, now, query }) returns:
// { planningAfter, writes, events, backup?, jobs }
// writes are compiler-owned GuardedWrite values, not request-supplied SQL.
// Owner planning/weekly/configuration commands advance the shared workspace revision.
```

Do not introduce a second independent planning write route that bypasses this transaction. Owner-facing planning/weekly/configuration commands must conflict if their base workspace revision is stale, even if only a side table changes. Operational polling cursors, heartbeats, leases and job-progress updates use separate owner-scoped compare-and-swap streams; they cannot alter planning or authorize effects and must not make an open editor conflict every poll. Preserve unchanged retry mutation IDs across conflict refreshes. New commands still require same-origin JSON, authenticated owner scope, strict unknown-field rejection and bounded request sizes.

## Decisions and contracts

1. Planning schema migrations run **v1 → v2 → v3 → v4**. Continue accepting the original standalone v2 JSON export through the foundation importer; bundle/module schema versions are separate.
2. Stable entity IDs never change during rename, task move, project archive or restore. Names and repository URLs are editable labels, not identity keys.
3. Portfolio priority remains `equal` for every project; task priorities remain high/normal/low. Adding a project extends fair recommendation interleaving; it does not introduce hidden weighting.
4. Cross-project dependencies are permitted only between tasks inside the same authenticated workspace. Global cycles and completed-dependent guards replace the old same-project constraint. A missing or unfinished prerequisite is always explicit.
5. Project/milestone archive hides work from ordinary active views without rewriting descendants' statuses or evidence. An archived project's incomplete prerequisite still blocks active work and links to the archived project; a completed prerequisite remains fulfilled.
6. Project deletion requires an archived, empty project and a revision-bound impact preview plus backup. Milestone deletion requires archive and zero linked tasks. Move, unlink or explicitly purge records first using the foundation cleanup workflow. Never silently cascade-delete evidence or dependent work.
7. Recurrence produces **proposed**, unpinned tasks. Owner-defined recurrence is permission to generate proposals; generated status is never `todo`, `doing` or `done`.
8. Weekly capacity is advisory. Unknown estimates remain unknown; show them separately instead of treating them as zero effort. Carry-forward is an explicit owner choice.
9. Source freshness and missing evidence contribute to attention through a provider contract; later phases supply those providers. This phase includes actual planning blockers, overdue tasks/milestones, review, proposals, old commitments and capture triage.
10. Robust focus/visibility polling is the required transport. Live subscriptions are optional only after the runtime supports them and production acceptance proves them; do not block this phase or claim live sync based on polling.

## File map

| Files | Responsibility |
|---|---|
| Modify `lib/types.ts`, `lib/workspace-validation.ts`, `lib/seed.ts` | Schema v4 fields, strict validation, new-workspace defaults without reseeding existing data |
| Create `lib/planning-contract.ts`, `lib/planning-migration.ts` | Typed commands and v3→v4 migration |
| Modify `lib/planning.ts`; create `lib/planning-workflows.ts`, `lib/task-graph.ts` | Delegate cohesive portfolio/move/bulk commands and shared graph validation |
| Modify `lib/project-baselines.ts` | Preserve baseline lineage when a task is moved or explicitly purged |
| Create `lib/entity-links.ts`, `lib/planning-search.ts`, `lib/attention.ts` | Stable navigation, global search, complete attention selectors |
| Create `lib/weekly-planning.ts`, `lib/recurrence.ts`, `lib/planning-module.ts` | Week/review/recurrence handlers and portable export/import adapters |
| Modify `db/schema.ts`; generate one new append-only migration under `drizzle/` | Owner-scoped week, review and recurrence tables; do not edit shipped migrations |
| Modify `components/control-center.tsx`, `components/projects-view.tsx`, `components/planning-editors.tsx`, `components/task-editor.tsx`, `components/inbox-view.tsx`, `components/today-view.tsx`, `components/ui.tsx` | Wire commands and replace limited selectors |
| Create `components/project-editor.tsx`, `components/milestone-workspace.tsx`, `components/task-bulk-actions.tsx`, `components/search-view.tsx`, `components/attention-view.tsx`, `components/weekly-planning-view.tsx`, `components/recurrence-editor.tsx` | Focused accessible views and editors |
| Create `lib/workspace-polling.ts`; modify foundation workspace client and `components/control-center.tsx` | Single-flight revision polling with draft preservation |
| Create `tests/planning-workflows.test.ts`, `tests/planning-search.test.ts`, `tests/attention.test.ts`, `tests/weekly-planning.test.ts`, `tests/recurrence.test.ts`, `tests/workspace-polling.test.ts` | Behavioral/domain/storage regressions |
| Create `tests/e2e/planning-workflows.spec.ts` | Local browser journeys using foundation harness |

The next Drizzle migration number is selected by `npm run db:generate` after the foundation migration has landed; record the generated filename in the implementation commit. Module keys are exactly `weekly_plans`, `weekly_reviews`, `recurrence_rules`, `recurrence_occurrences`, all initially module schema version 1.

## Task 1 — Establish schema v4 and command shapes

**Files:** `lib/types.ts`, `lib/planning-contract.ts`, `lib/planning-migration.ts`, `lib/workspace-validation.ts`, `lib/seed.ts`, `tests/planning-workflows.test.ts`.

- [ ] Add the following complete contract to `lib/planning-contract.ts`; import the existing `TaskInput`, `Project` and `Workspace` types. Extend the existing types rather than maintaining parallel persisted entity types.

```ts
import type { Project, TaskInput, Workspace } from './types.ts';

export interface ProjectInput {
  name: string;
  description: string;
  goal: string;
  color: Project['color'];
  repositories: Project['repositories'];
}
export type BulkTaskPatch = Partial<Pick<TaskInput,
  'status' | 'priority' | 'horizon' | 'dueDate' | 'milestoneId'>>;
export type PlanningWorkflowCommand =
  | { type: 'project.create'; project: ProjectInput }
  | { type: 'project.edit'; id: string; patch: Partial<ProjectInput> }
  | { type: 'project.archive'; id: string }
  | { type: 'project.restore'; id: string }
  | { type: 'project.delete'; id: string; impactToken: string }
  | { type: 'milestone.archive'; id: string }
  | { type: 'milestone.restore'; id: string }
  | { type: 'milestone.delete'; id: string; impactToken: string }
  | { type: 'milestone.reorder'; projectId: string; orderedIds: string[] }
  | { type: 'task.move'; ids: string[]; projectId: string; milestoneId: string | null }
  | { type: 'task.bulk'; ids: string[]; patch: BulkTaskPatch }
  | { type: 'capture.bulk'; ids: string[]; patch: {
      projectId?: string | null; status?: 'inbox' | 'filed' | 'archived';
    } }
  | { type: 'capture.bulkConvert'; items: Array<{
      id: string; projectId: string; milestoneId: string | null;
      horizon: 'now' | 'next' | 'later';
    }> };

export interface MoveImpact {
  taskIds: string[];
  previousProjectIds: string[];
  targetProjectId: string;
  crossProjectEdges: Array<{ from: string; to: string }>;
  captureIds: string[];
}
export interface WorkflowContext { now: string; newId: () => string; }
export interface WorkflowResult { workspace: Workspace; impact: MoveImpact | null; }
```

- [ ] Extend planning schema v4 with `Project.archivedAt: string | null`, `Milestone.archivedAt: string | null`, `Milestone.sortKey: number` and `TaskInput.estimateMinutes: number | null` (inherited by `Task`). The estimate is an integer 1–10,080 or null; milestone sort keys are unique nonnegative integers per project. Dates are valid ISO instants or validated calendar days as appropriate. Existing titles/text limits remain unchanged. The project maximum remains 100. Adopt foundation `measurePlanning` with 1,000,000 user-content bytes and 1,250,000 serialized bytes; register only generated default/null metadata for omission/hydration. Never exclude owner-entered IDs, text, URLs or estimates from content accounting.
- [ ] Implement `migratePlanningV3ToV4(input)` as a clone: populate null archive fields, assign milestone sort keys from existing array order per project, set null estimates, set schemaVersion 4. Preserve every existing ID, task status, date, commitment, source, evidence and completion timestamp. Validate only after migration using the v4 contract. Keep standalone v1/v2 migrations intact.
- [ ] Update `lib/seed.ts`, baseline-created tasks in `lib/project-baselines.ts`, editor defaults and task/capture conversion factories for the added estimate field. Create `tests/helpers/workspace.ts` with current typed project/milestone/task fixtures and migrate existing typed fixtures in `tests/planning.test.ts`, `tests/project-baselines.test.ts`, `tests/reliability-lifecycle.test.ts` and storage tests. Keep explicit old-version raw JSON fixtures unchanged so compatibility is genuinely exercised.
- [ ] Add regression fixtures for v1, v2 and foundation v3; assert their v4 output preserves content except the explicit defaults, rejects unknown schema versions, and round-trips through `parseWorkspaceExport`. Include the existing 1,800-task near-limit v2 fixture: it must remain writable/exportable/restorable within the foundation content/metadata budgets. Truly oversized user content still rejects without partial writes.
- [ ] Run `node --experimental-strip-types --test tests/planning-workflows.test.ts tests/reliability-validation.test.ts`. Expect all preservation and rejection cases to pass; then run `npm run typecheck`. Commit only this completed vertical slice using `git commit -m "feat: add versioned planning workflow contract"`.

## Task 2 — Portfolio lifecycle, milestone workspace and stable navigation

**Files:** `lib/planning-workflows.ts`, `lib/planning.ts`, `lib/entity-links.ts`, `components/project-editor.tsx`, `components/milestone-workspace.tsx`, existing portfolio/editors/control-center, `tests/planning-workflows.test.ts`, `tests/e2e/planning-workflows.spec.ts`.

- [ ] Implement `applyWorkflowCommand(workspace, command, context): WorkflowResult`. It clones the workspace, validates strict command keys and input lengths, applies a single mutation, validates the full graph/document, and returns the result. Transaction handlers supply `context.newId`; routes never accept trusted owner IDs or arbitrary entity IDs for creation. Preserve the old `project.update` goal/description command as a compatibility adapter.
- [ ] Add tests before the handler: rename preserves links; create rejects blank name and malformed credential-bearing URL; archive retains descendants; restore returns the same IDs; deletion of nonempty projects or referenced milestones is rejected without changes. UI deletion previews use foundation impact tokens pinned to revision and affected IDs; any intervening mutation invalidates the preview. Only the successful delete adds an automatic backup. The foundation reference registry checks every normalized module and preserves deleted-entity tombstones; legacy activity references may become null while their text and canonical audit retain the historical subject.
- [ ] Implement project creation/edit/archive/restore and the archived-project filter. Repository changes affect future reference display and connector configuration review; they never rewrite old baseline provenance or migrate a connector silently. Store duplicate repository links once after canonical URL normalization. A missing exact supported baseline identity hides the add-baseline action but keeps previously saved source records readable.
- [ ] Build the milestone workspace: title/description, acceptance criteria, target date/status, completion evidence, all linked tasks with status/search/horizon controls, direct prerequisites grouped by project, linked captures/decisions, add task preselected to milestone, and edit/archive controls. Until phase 3, evidence/decisions use current inline evidence and capture records; retain a clear empty state. Add archive restore and keyboard-operable Move up/Move down actions. Reorder requires every nondeleted milestone ID for that project exactly once, including archived rows; normalize sort keys to 0…n−1 atomically.
- [ ] Existing tasks remain linked to an archived milestone for history and can be moved/unlinked explicitly; creating or newly assigning tasks to an archived milestone is rejected. Neither archive nor restore invents changes to task status, weekly commitment or milestone acceptance.
- [ ] Use URL query state for copyable deep links while retaining the app's single-page routing. This complete encoder is the canonical format; add parser validation against known view/kind values and owner-visible records.

```ts
// lib/entity-links.ts
export type EntityTarget =
  | { kind: 'project'; id: string }
  | { kind: 'milestone'; id: string }
  | { kind: 'task'; id: string }
  | { kind: 'capture'; id: string };
export function entityHref(target: EntityTarget): string {
  const query = new URLSearchParams({ view: 'projects', entity: target.kind, id: target.id });
  if (target.kind === 'capture') query.set('view', 'inbox');
  return `/?${query.toString()}`;
}
```

- [ ] Back/forward restores the same selection and scroll target. Links resolve by stable ID after project rename/move; archived targets open with an archive banner. Missing/deleted/foreign targets produce the same neutral unavailable state, reveal no private data and offer navigation home. A dirty editor uses the foundation discard/recover behavior before navigation.
- [ ] Browser acceptance: create a third project, add/reorder/archive/restore a milestone, open a milestone link in a second authenticated local context, rename its project and reopen the original link, then delete an empty archived project through its preview. Check 390 px and 1280 px widths and keyboard-only reorder. Run targeted domain/browser tests, then commit `feat: complete portfolio and milestone workspaces`.

## Task 3 — Cross-project dependencies, safe moves and atomic bulk editing

**Files:** `lib/task-graph.ts`, `lib/planning-workflows.ts`, `lib/planning.ts`, `lib/workspace-validation.ts`, `lib/project-baselines.ts`, `components/task-editor.tsx`, `components/task-bulk-actions.tsx`, `tests/planning-workflows.test.ts`, existing planning tests.

- [ ] Extract graph validation into `validateTaskGraph(workspace)` used by ordinary commands, workflow commands and import. Remove only the same-project dependency ban; preserve existence, uniqueness, 50-prerequisite bound, self/cycle rejection and completed-dependent guards across the entire owner's graph. Return blockers with linked prerequisite IDs and project labels; do not infer completion from a project's archived state.
- [ ] Update the dependency picker to search all projects, show project labels and unavailable/archived states, and offer a read-only dependency graph rooted at a task (prerequisites and dependents, with accessible textual list). The graph is a bounded traversal with cycle detection, maximum 200 displayed nodes and an explicit “show more” table for larger valid graphs; it never silently omits blockers.
- [ ] Implement task move preview for 1–100 unique selected tasks. A single explicit target milestone must belong to the destination project, or `null` unlinks all selected tasks. Preserve task IDs, title/content/status, evidence, completion and dependencies. Keep associated capture `projectId` as the capture's original filing context while its `convertedTaskId` remains valid. Show these retained captures and newly cross-project edges in the preview. Reject an archived destination or a completed-task violation. Commit the complete move in one transaction.
- [ ] Make baseline application record-aware after a move: existing deterministic proposal IDs count as previously applied even if the task moved. Display its current project through its ID and keep the original dated proposal text unchanged. If foundation cleanup explicitly purges a baseline task, its tombstone/application provenance prevents recreation; the package reports “previously applied; task removed” rather than re-adding the owner's rejected work. Unrelated ID/type collisions still block application.
- [ ] Implement atomic bulk patches for status/priority/horizon/dueDate/milestone only; 1–100 unique IDs, no broad text replacement or implicit dependency removal. Validate the final clone, not each item in input order. This allows completing a prerequisite and dependent together if the final graph is valid; it forbids completing a dependent alone. Selection persists across filters but the confirmation names selected hidden tasks. Display proposed changes and any rejected IDs before submitting; one invalid task rejects the whole mutation.
- [ ] Add this behavioral test after Task 1 defines the migration and Task 3 defines the reducer. `createSeedWorkspace` supplies stable seed project/task records; create the explicit tiny graph so the test is independent of seed content counts.

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeedWorkspace } from '../lib/seed.ts';
import { parseWorkspaceExport } from '../lib/workspace-validation.ts';
import { applyWorkflowCommand } from '../lib/planning-workflows.ts';

test('bulk completion checks the final cross-project graph and remains atomic', () => {
  const ws = parseWorkspaceExport(createSeedWorkspace('2026-10-18T12:00:00Z'));
  const base = ws.tasks[0];
  ws.tasks = [
    { ...base, id: 'a', projectId: ws.projects[0].id, milestoneId: null,
      status: 'todo', dependsOn: [], blocker: '', completedAt: null },
    { ...base, id: 'b', projectId: ws.projects[1].id, milestoneId: null,
      status: 'todo', dependsOn: ['a'], blocker: '', completedAt: null },
  ];
  ws.captures = [];
  const before = structuredClone(ws);
  const context = { now: '2026-10-18T13:00:00Z', newId: () => 'unused' };
  assert.throws(() => applyWorkflowCommand(ws,
    { type: 'task.bulk', ids: ['b'], patch: { status: 'done' } }, context), /blocked|unfinished/i);
  assert.deepEqual(ws, before);
  const result = applyWorkflowCommand(ws,
    { type: 'task.bulk', ids: ['b', 'a'], patch: { status: 'done' } }, context);
  assert.ok(result.workspace.tasks.every(task => task.status === 'done'));
  assert.deepEqual(ws, before);
});
```

- [ ] Run `node --experimental-strip-types --test tests/planning-workflows.test.ts tests/planning.test.ts tests/project-baselines.test.ts`. Replace the old “foreign project dependency rejected” assertion with separate valid cross-project and invalid foreign-owner cases; do not simply delete coverage. Browser-test move/cancel/409/retry and bulk failure retention. Commit `feat: add safe cross-project planning operations`.

## Task 4 — Global search and full capture triage

**Files:** `lib/planning-search.ts`, `components/search-view.tsx`, `components/inbox-view.tsx`, `components/control-center.tsx`, `tests/planning-search.test.ts`.

- [ ] Implement search over project names/goals/descriptions; milestone title/acceptance/description/evidence; task title/notes/evidence; capture title/body. Normalize Unicode with NFKC and lowercase; split trimmed query on whitespace; require every token to occur somewhere in an entity's combined searchable fields. Return stable ID, type, title, project, safe text snippet, archive status and entity URL. No HTML interpolation. Source URLs are searchable strings, never fetched by search.
- [ ] Bound query to 200 characters/20 tokens, page results 50 at a time, preserve exact filtered total count, sort relevance by title match then updated/created time descending then stable ID. Include archive only when selected. Add entity, project and status filters; show a separate “unknown timestamps” fallback for legacy entities. Deep links can restore query/filter state without putting private search terms in telemetry.
- [ ] Add inbox search, project/kind/status filters and multi-select file/archive/restore/project-assignment actions. Conversion remains one capture→one task with original source/body. Bulk conversion previews each proposed task, requires a project for every unassigned capture and commits up to 50 conversions atomically; existing converted or archived captures reject with named rows. No automatic capture ingestion is added here.
- [ ] Add tests for Arabic/English Unicode, literal `<script>` text, all-token matching, title tie breaks, archived filter, duplicate selections, assigning a converted capture without moving its linked task, and all-or-none conversion when one selected capture was already converted.
- [ ] Run `node --experimental-strip-types --test tests/planning-search.test.ts tests/planning-workflows.test.ts`; keyboard-test search results and returning from an opened task to the prior results. Commit `feat: add workspace search and capture triage`.

## Task 5 — Complete attention queues and explainable next actions

**Files:** `lib/attention.ts`, `components/attention-view.tsx`, `components/today-view.tsx`, `components/control-center.tsx`, `lib/planning.ts`, `tests/attention.test.ts`.

- [ ] Define these pure data contracts and `buildAttention(workspace, context): AttentionItem[]`. The context contains a fixed Cairo date/week plus current weekly plans and registered side-module findings; no selector reads the wall clock itself.

```ts
export type AttentionKind = 'blocked' | 'overdue' | 'review' | 'proposal'
  | 'carry-forward' | 'capture-inbox' | 'milestone-overdue'
  | 'missing-evidence' | 'stale-source' | 'failed-job';
export interface AttentionItem {
  key: string; // `${kind}:${entityType}:${entityId}`
  kind: AttentionKind;
  entityType: 'task' | 'milestone' | 'capture' | 'source' | 'job';
  entityId: string;
  projectId: string | null;
  title: string;
  reasons: string[];
  href: string;
  severity: 'action' | 'review' | 'information';
  sortAt: string | null;
}
export interface AttentionProvider {
  key: string;
  read(userId: string, asOf: string): Promise<AttentionItem[]>;
}
```

- [ ] Return every matching item, even if one task appears in multiple queue categories. The “All” view deduplicates entities while showing every reason; category totals count items explicitly. Filter out tasks in archived projects from ordinary action queues, but retain them when they block active dependents. Do not suppress overdue blocked tasks because ready recommendations exclude them. Do not label absent source checking as “fresh”.
- [ ] Add global attention navigation, exact counts and paginated rows; category/project filters; “View all” links from the three-row Today review preview. Review opens evidence/editor, blocker rows open prerequisites, overdue rows allow explicit reschedule, proposals accept as `todo` or archive, carry-forward can carry/unpin, inbox rows open triage. Never automatically dismiss because a row was viewed. Acknowledgement/snooze is not introduced as a hidden state; resolving the underlying condition clears the finding.
- [ ] Keep recommendations at six in the Today preview, but add “All ready work” using the same ranking function without a six-item limit. Alternate across all active projects that have ready tasks; explain why a project with no ready tasks has no recommendation. Priority values remain deterministic and user-inspectable.
- [ ] Tests: more than three review tasks are reachable; all blocked tasks appear; overdue-and-blocked appears in both categories and once in All; archived completed prerequisites do not block; midnight/week rollover updates selectors without requiring a save; all active projects interleave fairly; an empty provider returns no invented freshness. Run `node --experimental-strip-types --test tests/attention.test.ts tests/planning.test.ts`. Commit `feat: expose complete attention queues`.

## Task 6 — Weekly plans, effort budgets and immutable review snapshots

**Files:** `db/schema.ts`, generated migration, `lib/weekly-planning.ts`, `lib/planning-module.ts`, `lib/calendar.ts`, `lib/weekly-summary.ts`, `components/weekly-planning-view.tsx`, `components/task-editor.tsx`, `components/today-view.tsx`, `tests/weekly-planning.test.ts`.

- [ ] Add owner-scoped `weekly_plans` keyed by `(user_id, week_start)` with `revision`, `capacity_minutes`, `task_ids_json`, `created_at`, `updated_at`. Add `weekly_reviews` keyed by `(user_id, id)` with `week_start`, `created_at`, `supersedes_id`, `snapshot_json`, `reflection`, `next_week_notes`. Each review is a frozen snapshot, not a live join. Index `(user_id, week_start, created_at, id)`.
- [ ] Add complete week contracts:

```ts
export interface WeeklyPlan {
  weekStart: string;
  capacityMinutes: number | null;
  taskIds: string[];
  revision: number;
}
export interface WeeklyReviewSnapshot {
  weekStart: string;
  takenAt: string;
  commitments: Array<{
    taskId: string; title: string; projectId: string; status: string;
    estimateMinutes: number | null; completedAt: string | null;
  }>;
  completedTaskIds: string[];
  reflection: string;
  nextWeekNotes: string;
}
export type WeeklyCommand =
  | { type: 'weekly.set'; weekStart: string; capacityMinutes: number | null; taskIds: string[] }
  | { type: 'weekly.carry'; fromWeek: string; toWeek: string; taskIds: string[] }
  | { type: 'weekly.review'; weekStart: string; reflection: string; nextWeekNotes: string; supersedesId: string | null };
export function budgetSummary(plan: WeeklyPlan, estimates: Map<string, number | null>) {
  let knownMinutes = 0;
  let unestimated = 0;
  for (const id of plan.taskIds) {
    const estimate = estimates.get(id);
    if (estimate === undefined || estimate === null) unestimated += 1;
    else knownMinutes += estimate;
  }
  return { knownMinutes, unestimated,
    overBy: plan.capacityMinutes === null ? null : Math.max(0, knownMinutes - plan.capacityMinutes) };
}
```

- [ ] During schema v4 migration, create week records only for legacy pins with known saved Monday values. Deduplicate IDs; preserve their actual recorded week. Do not backfill closed reviews, missing historical commitments or effort estimates. Keep legacy `weekly`/`weeklyWeek` fields for import compatibility but make weekly side tables canonical. Old `task.update {weekly}` commands translate to the current Cairo week's membership. All views switch to weekly membership queries; future-week selection must not overwrite an earlier week's record.
- [ ] Weekly UI allows current/next/custom Monday weeks, add/remove task, estimate editing, optional owner capacity 0–10,080 minutes, known estimate total and unestimated count. More work than capacity is a visible advisory requiring no extra approval; it never silently drops a task. Completed tasks stay in commitment history and current-week completions include all tasks completed during the week, with a separate committed-completions metric.
- [ ] Carry-forward adds chosen unfinished tasks to the target plan while leaving the old week's membership intact. An already completed task is rejected with a row-specific message. Review snapshots include task titles/statuses at review time; later rename/reopen/delete does not rewrite them. Corrections append a new review linked by `supersedesId`; the UI can show all versions. Limit reflection/next-week text to 10,000 characters each and commitments to the workspace task bound.
- [ ] Register both side tables with foundation `registerExportModule`. Import validates Monday dates, owner-remapped row keys, task references or recorded tombstones, review supersession cycles and count/text limits. Snapshot historical task titles do not require their task still to exist. A restore replaces week modules atomically with planning, never merges silently.
- [ ] Tests in real SQLite: concurrent budget and commitment edits conflict; repeated carry has no duplicate IDs; a failed batch preserves both weeks; archived completed work remains in review; deleted tasks survive only as frozen history/tombstones; a 23:30 UTC Cairo week boundary uses the correct local date. Test `budgetSummary` with null capacity and unknown estimates. Run `node --experimental-strip-types --test tests/weekly-planning.test.ts tests/weekly-summary.test.ts tests/reliability-lifecycle.test.ts`. Commit `feat: add durable weekly planning and reviews`.

## Task 7 — Recurring proposals without duplicate commitments

**Files:** `db/schema.ts`, generated migration, `lib/recurrence.ts`, `lib/planning-module.ts`, `components/recurrence-editor.tsx`, `tests/recurrence.test.ts`.

- [ ] Add `recurrence_rules` keyed by `(user_id,id)` with revision, enabled flag, rule JSON, template JSON, created/updated times; `recurrence_occurrences` keyed by `(user_id,rule_id,occurrence_date)` with task ID, generation time and disposition (`created`, `skipped`, `removed`). Keep occurrence identity after explicit task removal so a retry never resurrects it. Foreign-owner task/rule references always reject.
- [ ] Use this finite recurrence contract; monthly day 29/30/31 clamps within that month but preserves the original anchor day for the following month. Weekly days are ISO weekday numbers 1–7. Date arithmetic uses calendar strings, not 24-hour additions to Cairo instants.

```ts
import type { TaskInput } from './types.ts';
export type RecurrencePattern =
  | { frequency: 'daily'; interval: number }
  | { frequency: 'weekly'; interval: number; weekdays: number[] }
  | { frequency: 'monthly'; interval: number; day: number };
export interface RecurrenceRule {
  id: string;
  startDate: string;
  endDate: string | null;
  pattern: RecurrencePattern;
  enabled: boolean;
  template: Omit<TaskInput, 'status' | 'weekly' | 'dueDate' | 'dependsOn' | 'evidence'>;
}
export type RecurrenceCommand =
  | { type: 'recurrence.create'; rule: Omit<RecurrenceRule, 'id'> }
  | { type: 'recurrence.update'; id: string; expectedRuleRevision: number; rule: Omit<RecurrenceRule, 'id'> }
  | { type: 'recurrence.materialize'; id: string; from: string; through: string };
export function occurrenceTaskId(ruleId: string, date: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(ruleId) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('A saved recurrence rule and calendar date are required.');
  }
  return `repeat:${ruleId}:${date}`;
}
```

- [ ] Implement `enumerateOccurrences(rule, from, through)` with inclusive valid day bounds, positive integer interval ≤365, unique weekdays, end≥start and a maximum 90-day preview range. Add deterministic tests: daily every two days; weekly Monday/Thursday across year boundary; monthly January 31→February 28→March 31; leap February 29; bounded end date; Cairo DST has no missing/double calendar date.
- [ ] UI shows the next ten dates and template before save. Never clone current dependency IDs into every new occurrence: recurring prerequisites must be explicitly chosen for an individual generated task. Existing source links and milestone association may be copied, but evidence is always empty, status proposed, weekly false, due date the occurrence date. A paused rule produces no tasks; disabling it does not delete existing proposals.
- [ ] Add a registered internal `recurrence.materialize` command/job using the foundation job dispatcher. Materialize up to 50 missing occurrences per execution and show larger backlog for explicit review. Unique occurrence rows and stable IDs make at-least-once execution safe. The rule row revision, occurrence insertion and planning task creation are one guarded transaction. If the target project/milestone is archived, rule becomes actionable “needs attention” without generating hidden work. Poll/open may request materialization only through a POST with normal mutation semantics; GET must not create tasks.
- [ ] Register rule/occurrence export adapters and restore validation. Import preserves occurrence keys and dispositions and does not automatically materialize historical missed dates. Tests cover two simultaneous generators, lost response, rule change between preview/save, full planning capacity, restored removed occurrence and cross-owner rule injection. Run `node --experimental-strip-types --test tests/recurrence.test.ts tests/weekly-planning.test.ts`. Commit `feat: generate recurring task proposals safely`.

## Task 8 — Reliable refresh, integration and acceptance

**Files:** `lib/workspace-polling.ts`, foundation workspace client, `components/control-center.tsx`, browser tests, `README.md`, new `docs/verification/planning-workflows.md`.

- [ ] Implement single-flight polling: refresh immediately on focus/online/visibility becoming visible, every 30 seconds while visible, and pause while hidden or signed out. Use the foundation bounded fetch and exponential failure retry (30, 60, 120, 300 seconds maximum), reset after success. A manual refresh is immediate. Share one in-flight GET and discard older revisions; add ±10% jitter for periodic retries using an injected random function in tests.
- [ ] Preserve open editor drafts and their captured base revision when a refresh changes saved data. New side-table summaries carry the same workspace revision; render an atomic view snapshot or a clear loading/stale indication. A 401 clears protected views, queued polls and source summaries. Poll success updates “last refreshed”; saving updates “last saved”; neither says external source sync happened.
- [ ] Add fake-clock tests for single flight, visibility pause, focus during save, timeout/error recovery, stale response ordering and session expiry. Browser-test changing a task in session B while a dirty editor remains open in session A: A receives saved state after refresh but does not silently change the draft; explicit save produces the conflict/review flow.
- [ ] Run `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, then `npm run test:e2e -- tests/e2e/planning-workflows.spec.ts`. Expected: zero test failures, no TypeScript/ESLint errors, successful production bundle. Record exact commands/tool versions and actual evidence; do not prewrite passing counts.
- [ ] Acceptance journeys must include all prior tasks plus fresh 320/390/768/1280 px views, keyboard focus/deep links, Arabic/English search, 100-task bulk preview, >3 review entries, 3+ projects, conflicting side-table mutation, full export/restore including weeks/recurrence, and old v2 JSON import. Use synthetic local owner data only.
- [ ] Update README feature boundaries and the new verification document. Distinguish automated/browser/physical checks and deployed versus local evidence. A passing planning test proves neither TAMENNI device reliability nor trading profitability. Commit `feat: finish integrated planning workflows` after the chapter gate passes.

## Completion checklist and cloud handoff

- [ ] Owner can create/edit/archive/restore/delete eligible projects and milestones, with stable links and explicit destructive previews.
- [ ] Milestone pages gather tasks, evidence, decisions and prerequisites; task move/bulk/dependency graph work across same-owner projects.
- [ ] Global search, capture search/triage, every review item and complete attention queues are reachable without hidden first-three/first-six limits.
- [ ] Weekly history, capacity, recurring proposed work and their export/restore adapters work after reload and conflict retry.
- [ ] Polling is labeled accurately; source ingestion, structured evidence and execution remain the respective later phases' responsibilities.
- [ ] All source-derived records remain proposals unless the owner explicitly accepts them.
- [ ] Record changed files, migrations, tests, screenshots and remaining environment gates in `docs/verification/planning-workflows.md`; link it from the master plan.

Assumptions already resolved for this phase: personal owner-scoped workspace, equal project priority, Cairo calendar, no team assignments, no automatic acceptance, side-table history outside the bounded planning document (1 MB user content plus foundation metadata allowance), maximum 100 items per bulk mutation, and polling as the supported baseline transport. Actual cloud secrets, deployment bindings and production authorization come from the foundation/master plan; their absence does not justify fake integrations or weakening ownership checks.
