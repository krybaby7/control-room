# Reviews and Automation Implementation Plan

> **For agentic workers:** Execute after the planning, evidence and source contracts are verified. Use the master plan and Phase 1 mutation/export boundary.

**Goal:** Make Today explain recent progress, blockers, stale evidence, decisions and next actions; support reproducible briefs, optional AI analysis, recurring reviews and meaningful in-app notifications.

**Architecture:** Deterministic evidence queries produce a review snapshot. Optional model analysis annotates that fixed snapshot with cited suggestions. A persisted schedule runner invokes bounded background jobs with occurrence keys, leases and proof of service access; it does not depend on an open browser.

**Tech stack:** TypeScript, D1, existing recommendation/calendar modules, Phase 4 integration job runner, provider-neutral analysis adapter and React review views.

## Files

Create `lib/reviews/{contracts.ts,assemble.ts,freshness.ts,brief-store.ts,analysis-policy.ts}`, `lib/automations/{schedule.ts,store.ts,runner.ts,notifications.ts}`, `lib/reviews/adapters/model.ts`, `components/reviews/{project-brief.tsx,changes-since-review.tsx,decision-queue.tsx,review-history.tsx}`, `components/automations/{schedule-editor.tsx,run-history.tsx,notification-inbox.tsx}`, `app/api/reviews/route.ts`, `app/api/reviews/[reviewId]/acknowledge/route.ts`, `app/api/automations/route.ts`, `app/api/automations/run-due/route.ts`, and tests `review-assembly.test.ts`, `review-analysis.test.ts`, `automation-schedule.test.ts`, `automation-runner.test.ts` plus `tests/e2e/reviews.spec.ts`.

Modify `components/today-view.tsx`, `components/control-center.tsx`, `lib/planning.ts` only where recommendation inputs change, `db/schema.ts`, the export registry and documentation. Tables: `review_snapshots`, `review_acknowledgements`, `automation_schedules`, `automation_occurrences`, `notification_events`. Reuse Phase 2 weekly review records instead of maintaining a second weekly-history store; review snapshots may reference them.

## Product and data contracts

```ts
export interface ReviewFact {
  id: string;
  projectId: string;
  kind: 'progress' | 'blocker' | 'decision' | 'deadline' | 'stale';
  text: string;
  evidenceRefs: Array<{ id: string; version: number }>;
  observationRefs: Array<{ id: string; contentDigest: string }>;
  observedAt: string;
  sourceUpdatedAt: string | null;
  basis: 'observed' | 'documented' | 'owner_decision' | 'inference';
}
export interface ReviewSnapshot {
  id: string;
  workspaceRevision: number;
  sourceWatermark: string;
  generatedAt: string;
  facts: ReviewFact[];
  unknowns: string[];
  modelRunId: string | null;
}
export interface AutomationSchedule {
  id: string;
  kind: 'source_refresh' | 'daily_review' | 'weekly_review' | 'backup';
  timezone: 'Africa/Cairo';
  enabled: boolean;
  nextDueAt: string;
  lastSuccessAt: string | null;
  catchUp: 'latest_only';
}
export function occurrenceKey(scheduleId: string, dueAt: string): string {
  return `${scheduleId}:${new Date(dueAt).toISOString()}`;
}
```

The authoritative owner comes from the server principal, not these browser-visible records. `sourceWatermark` represents the exact observation set used, not merely the last imported timestamp. Store cited evidence versions and immutable observation digests so later edits cannot silently change the meaning of a brief. At least one verified citation is required for an evidence-based fact; missing input is an unknown, not an invented fact. Schedule configuration and owner review acknowledgement use the shared owner-command receipt boundary. Generated snapshots, run state and notifications use scoped operational streams/CAS and do not advance the editor revision.

## Task 5.1 Assemble deterministic project briefs

- [ ] Add a project summary showing changes since last acknowledged review, active work, all material blockers, decisions awaiting owner input, upcoming dates and useful next steps.
- [ ] Keep implementation facts, owner acceptance and operational results separate. A passed build is not Android field acceptance; merged trading code is not profitable operation. Empty/unavailable evidence is labeled unknown.
- [ ] Pull facts from structured changes, evidence and source observations. Link each fact to a task/milestone/source detail route. Group related signals to avoid repeated notifications for one underlying failed check.
- [ ] Store a snapshot with workspace revision and source watermark. Acknowledge a specific snapshot; new changes since that snapshot remain unread even if another device acknowledges an older one.
- [ ] An automated weekly brief may prepare review material, but cannot fabricate the owner's reflection, close a weekly review, accept evidence or renew commitments. Phase 2's explicit owner review command retains that authority.
- [ ] Preserve fair visibility for TAMENNI and Trade Graph and explain recommendation ranking. Add user-selectable filtering without secretly changing project importance.
- [ ] Implement a freshness policy per source: show last success, source update time, observed time and retry/error separately. Initial proposed defaults: remote repositories/documents stale after 24 hours; PC freshness follows Phase 6's heartbeat window. These defaults are editable product settings, not scientific validity thresholds.

**Tests:** no facts without provenance; same source set produces stable brief; clock boundary; old acknowledgement cannot consume newer changes; missing source retains unknown; one failed provider does not blank another; no false completion/profitability claim; blocked tasks cannot become ready recommendations.

## Task 5.2 Optional evidence-linked AI analysis

- [ ] Start with deterministic briefs; add an optional server-side adapter `analyzeReview(snapshot, policy, signal)` whose inputs are bounded selected facts and whose structured output references existing fact IDs, exact evidence versions and immutable observations in that snapshot.
- [ ] Policy selects an available configured provider and exact model, maximum input size, maximum output tokens, maximum monetary cost when priced, and timeout. Default disabled until configured. Reuse Phase 7 provider contracts when available; Phase 5 may initially implement a fixture adapter behind the same interface.
- [ ] Validate output schema, citation membership, content bounds and dates. Unsupported claims become rejected output with retained diagnostics. Store model/provider/version, input digest, measured usage and known/unknown cost, not guessed costs.
- [ ] Model output may suggest risks, clarify conflicting sources, draft next actions and draft a baseline update. It cannot accept its own suggestions, set milestones achieved, change financial settings or issue execution jobs.
- [ ] Treat all source content as untrusted input. Keep system instructions and selected evidence distinct. Never include credentials, unrelated conversations or raw PC process command lines in model inputs.
- [ ] Surface `not configured`, `budget exhausted`, `unavailable`, `cancelled`, `invalid result`, `completed` and fallback deterministic brief states. Do not silently substitute another model or provider.

**Tests:** invented evidence ID rejected; unsupported assertion excluded; output attempts to change policies ignored; exact model unavailable; timeout; budget exhausted; lost provider response reconciled before retry; deterministic brief remains useful when AI is unavailable. Live paid analysis is a distinct configured acceptance check, not a CI prerequisite.

## Task 5.3 Persist schedules and execute occurrences once

- [ ] Add editable schedule definitions, next due, enabled/paused, last attempt/success, retry reason and run history. Use timezone-aware calendar calculations, not a fixed UTC offset for Cairo; test daylight-saving transitions and week boundaries.
- [ ] Propose daily review at 09:00 Cairo, weekly review Monday 09:00 and backup daily 03:00. Source refresh cadence defaults to 30 minutes only when provider access/rate budget supports it. Do not silently create or activate these schedules while merely implementing settings.
- [ ] Use the existing supported Sites schedule/runtime mechanism after verifying source and writer access. Reconcile existing linked schedules before creating one. If the host provides only coarse wakeups, one wakeup calls `run-due`, which selects persisted due occurrences; do not create duplicate per-project wakeups unnecessarily.
- [ ] Insert occurrence by unique `(user_id, scheduleId, dueAt)`, atomically claim its lease and create its bounded `workspace_job_intents` record plus the Phase 4 extension. Retry uses the same occurrence key and linked intent. Occurrence, intent and extension state changes share one owner-scoped operational CAS; do not maintain an independent schedule queue. Expired leases permit safe continuation, never a second economic effect.
- [ ] Missed schedules use `latest_only`: summarize missed intervals and run the newest due period once; never burst-run months of missed reviews or model spending. Backups retain last good generations; source jobs resume committed cursors.
- [ ] Clock rollback, runner restart and overlapping wakeups must not duplicate successful occurrences. Record failures and retry-after; surface stale schedules whose runner has not checked in.
- [ ] Verify a newly launched unattended runner can authenticate, claim, execute and write back without a logged-in browser. A token from the original developer session is insufficient proof of renewable access.

**Complete identity test for `lib/automations/schedule.ts`:**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { occurrenceKey } from '../lib/automations/schedule.ts';

test('the same instant is one occurrence regardless of offset spelling', () => {
  assert.equal(occurrenceKey('daily', '2026-10-18T09:00:00+03:00'),
    occurrenceKey('daily', '2026-10-18T06:00:00Z'));
  assert.notEqual(occurrenceKey('daily', '2026-10-18T06:00:00Z'),
    occurrenceKey('daily', '2026-10-19T06:00:00Z'));
});
```

Also run real SQLite races with two claimants, duplicate wakeups, expired lease, partial completion, invalid timezone and failed backup. Never test a fixed offset as a replacement for timezone-aware next-occurrence calculation.

## Task 5.4 Useful notifications and near-real-time plan updates

- [ ] Store in-app notifications for meaningful new blockers, completed requested jobs, failed background work, overdue owner decisions and recoverable integration failures. Deduplicate by underlying event and preserve read/unread across devices.
- [ ] Quiet unchanged runs by default. Provide per-source/type mute, quiet hours and severity. Email/Slack/push delivery stays disconnected until a real channel is explicitly configured; building an inbox does not send messages externally.
- [ ] Add a cursor-based `GET /api/changes` feed scoped to the signed-in owner. If the actual Sites hosting path supports streaming, implement SSE with heartbeats, reconnect cursor and bounded connection lifetime; verify proxy buffering and session expiry in hosting.
- [ ] Retain Phase 2's polling fallback: every 30 seconds while visible, paused while hidden, jittered and backed off on failures, with a check on focus/reconnect. A saved server snapshot may refresh while an editor is dirty, but never replace that draft or its base revision; update a change indicator and let the existing conflict flow reconcile it. Show whether the transport is streaming or polling. Tune cadence later only from measured hosting/load evidence, updating the shared policy and tests together.
- [ ] Bound server/database work per connection. If Sites cannot support a verified streaming path, keep fallback functional and mark streaming acceptance blocked rather than claiming genuine push synchronization.
- [ ] Connect notification and brief routes to deep links; a revoked/deleted item returns a useful tombstone rather than a blank page. Include notifications/schedules/snapshots in export; restore schedules paused.

**Tests:** duplicate failure emits one notification; unchanged refresh emits none; notification acknowledgement is owner scoped; SSE reconnect resumes after cursor; source disconnect yields stale state; expired session clears protected data; dirty editor survives incoming revision change; polling stops/backoffs appropriately.

## Task 5.5 Review and schedule acceptance

- [ ] Run targeted tests, full suite, typecheck and build, then browser-check brief links, decision queues, run history and notification acknowledgement across two sessions.
- [ ] Exercise one real unattended source-refresh/review occurrence using the intended principal, with AI disabled unless a provider/budget has been configured. Confirm stored outcome and next due.
- [ ] If AI is enabled, execute one bounded authorized analysis and verify citations, provider identity, cost/usage reporting and budget behavior. Keep unpriced cost unknown.
- [ ] Record enabled schedule definitions and how they are paused/revoked. Record any unsupported streaming or background access as an open acceptance row.
- [ ] Update `progress.json`, the gap matrix and the phase verification record; commit the checkpoint.

```bash
node --experimental-strip-types --test tests/review-assembly.test.ts tests/review-analysis.test.ts tests/automation-schedule.test.ts tests/automation-runner.test.ts
npm test
npm run typecheck
npm run lint
npm run build
```

## Exit evidence

Today answers what changed, what is blocked, what needs a decision and what to do next with linked evidence. Historical reviews survive new changes. Every enabled schedule has an actual unattended successful run. Every enabled AI result has validated citations and provider/usage provenance. Notification behavior remains quiet when nothing meaningful changes.
