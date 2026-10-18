# Source Synchronization Implementation Plan

> **For agentic workers:** Execute the checklists with the master plan and Phase 1 transaction/export contracts. Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` when available.

**Goal:** Replace static-only source links with current, attributable GitHub/document/conversation observations and reviewable plan-change proposals.

**Architecture:** Provider-specific read adapters produce immutable observations. A bounded synchronization engine stores cursor/provenance state separately from planning, then prepares proposals. The owner accepts proposals through the existing mutation boundary. Interactive connected-app access and unattended service access are distinct verified capabilities.

**Tech stack:** Existing TypeScript/Zod, `lib/connectors.ts`, D1 normalized tables, R2 content objects, same-origin API routes, Node test runner and browser regression tests.

## Starting evidence and prerequisite

Phase 3 must provide structured evidence and history; Phase 1 provides transaction/receipt, service actor and export contracts. Existing `components/sources-view.tsx` explicitly labels GitHub sync and PC collector disconnected. `lib/project-baselines.ts` is a dated source package, not a connector. Preserve its historical date and existing saved markers.

The current repository already has `lib/connectors.ts`, `lib/connector-contract.mts`, `lib/connector-context.ts`, `components/connector-error.tsx`, `build/sites-worker.ts` and the local connector-preview helpers. Reuse them. Do not construct another credential proxy.

## Files and data ownership

Create during implementation:

- `lib/sources/{contracts.ts,validation.ts,store.ts,sync.ts,freshness.ts,proposals.ts,service-access.ts}`
- `lib/sources/adapters/{github.ts,documents.ts,conversation-export.ts}`
- `lib/background/{job-contract.ts,job-store.ts,job-runner.ts}` for bounded integration jobs, reused by Phase 5
- `app/api/sources/route.ts`, `app/api/sources/[sourceId]/refresh/route.ts`, `app/api/sources/[sourceId]/observations/route.ts`
- `app/api/proposals/route.ts`, `app/api/proposals/[proposalId]/decision/route.ts`
- `app/api/integrations/jobs/run/route.ts` for a verified service principal; not a browser bypass
- `components/sources/{source-connections.tsx,source-detail.tsx,source-diff.tsx,proposal-review.tsx}`
- `tests/{source-adapters,source-sync,source-proposals,source-auth}.test.ts`, `tests/fixtures/sources/`, `tests/e2e/source-sync.spec.ts`
- `docs/integrations/{provider-capabilities.md,source-selection.md,unattended-sync.md}`

Modify `components/sources-view.tsx`, `components/project-baseline.tsx`, `components/control-center.tsx`, `db/schema.ts`, `.openai/hosting.json` only when actual eligible integrations are known, and the export registry. Generate the next schema-only SQL migration after earlier phases are integrated.

Tables: `source_connections`, `source_targets`, `source_observations`, `source_sync_runs`, `source_proposals`, `integration_jobs`, `integration_job_attempts`. Every key/query includes owner scope. `integration_jobs` extends the foundation's `workspace_job_intents` through a unique `intent_id`; it is not a second independent queue. Observations are immutable; latest successful cursor and freshness status are mutable. Store compact metadata in D1 and large snapshots in R2; Phase 3 evidence links cite immutable observation IDs/digests and exact evidence versions.

## Proposed contracts

Create this complete adapter contract in `lib/sources/contracts.ts`; refine provider-specific schemas without weakening it:

```ts
export type SourceKind = 'github_repository' | 'github_file' |
  'document' | 'conversation_export';
export type AccessMode = 'interactive' | 'unattended';
export type SourceState = 'disconnected' | 'needs_connection' | 'syncing' |
  'fresh' | 'stale' | 'failed' | 'unsupported';
export interface SourceTarget {
  id: string;
  projectId: string;
  kind: SourceKind;
  providerResourceId: string;
  canonicalUrl: string;
  selectedPaths: string[];
  staleAfterSeconds: number;
}
export interface SourceObservation {
  id: string;
  sourceId: string;
  externalId: string;
  sourceRevision: string;
  sourceUpdatedAt: string | null;
  observedAt: string;
  title: string;
  canonicalUrl: string;
  contentDigest: string;
  payload: Record<string, unknown>;
}
export interface SourcePage {
  observations: SourceObservation[];
  nextCursor: string | null;
  nextEtag: string | null;
  unchanged: boolean;
}
export interface AdapterCapabilities {
  sourceKinds: SourceKind[];
  interactiveRead: boolean;
  unattendedRead: boolean;
  verifiedAt: string | null;
  blockedReason: string | null;
}
export interface SourceAdapter {
  capabilities(mode: AccessMode): Promise<AdapterCapabilities>;
  readPage(target: SourceTarget, context: {
    cursor: string | null;
    etag: string | null;
    observedAt: string;
    signal: AbortSignal;
  }): Promise<SourcePage>;
}
```

`payload` is validated by the adapter-specific Zod schema before persistence. It is not executable instructions or arbitrary HTML. The authenticated principal is injected into the server adapter factory; never place a bearer token or authoritative owner ID in `SourceTarget` supplied by a browser. Provider adapters do not mint owner evidence IDs. Source citations identify an immutable observation and its content digest; accepted evidence citations use `{id, version}` from Phase 3. Owner evidence creation/linking remains a separate explicit command, so routine refresh does not churn the editor revision.

## Task 4.1 Discover and prove access

- [ ] Discover the actual Sites plugin eligibility tool and follow pagination if available. Resolve canonical connector IDs/actions and record supported read schemas. A connection in the authoring agent does not establish Sites eligibility or hosted access.
- [ ] If eligibility discovery is unavailable, implement/test adapters with fixtures but leave live activation `unsupported` with a precise explanation. Do not guess manifest IDs, scrape cookies, widen site access or silently substitute another account.
- [ ] Interactive mode uses `connectorsForRequest()` in a signed-in server route; require explicit `status === 'success'`, preserve structured content including falsy values, and classify reauthentication/rate-limit/disabled failures. Return private/no-store responses.
- [ ] Unattended mode must have a separately tested, renewable principal. Preferred GitHub path when available is an owner-installed GitHub App restricted to selected repositories and read permissions. A short-lived authoring task credential is not a permanent scheduler credential. Use Sites connector mode for background calls only if the platform explicitly supports it without a visitor.
- [ ] Prove both private Sites ingress and application service ownership with a real request. A Sites service bearer alone supplies no visitor identity or connected-app consent. Store only references to secrets in D1; configure actual secrets with supported runtime controls.
- [ ] Add capability metadata UI: which account/resources, read-only scope, last verified access, interactive vs unattended, revoke/disconnect action and blocked reason.

**Tests:** fixture interactive success; missing binding; denied connector; expired request context; wrong owner; service token with no app principal; supported interactive but unsupported unattended. None may become a green connected indicator accidentally.

## Task 4.2 Connect GitHub read sources

- [ ] Resolve selected repositories by immutable provider identity and canonical URL. Start with the existing configured TAMENNI application, map-lab and Trade Graph repositories; allow owner selection of additional repositories via Phase 2's project settings.
- [ ] Read commits/default branch, PR summaries and states, checks/workflow conclusions where permitted, and explicitly selected repository documents. Keep branch, commit SHA, PR head SHA, check run identity, source timestamp and observation timestamp distinct.
- [ ] Use bounded pages (default 50, at most 100 items), provider continuation links/cursors, conditional reads/ETags and rate-limit headers. Advance the persisted cursor only after its observations commit successfully. A PR check for a different SHA cannot prove the current PR head passed.
- [ ] Prefer verified webhook delivery where the deployment has a supported authenticated ingress. Otherwise use bounded scheduled conditional reads. GitHub recommends webhooks and efficient conditional requests; do not run parallel bursts. [GitHub REST best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api).
- [ ] If using webhooks, validate the untouched raw body with HMAC-SHA256, deduplicate delivery IDs, resolve installation/repository against registered owner mappings and enqueue bounded work before returning. Private Sites must not be made public to receive a webhook. [Webhook validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries).
- [ ] Treat authorization loss, repository deletion/rename, moved source paths and force-pushes as source state changes. Retain prior evidence with its old identity; never silently rewrite it to point at new content.

**Tests:** paginated reads interrupted/restarted; duplicate delivery; 304 unchanged; 403/429 with retry timing; 404 after access revocation; force-pushed SHA; check result belongs to old head; two owners connect the same public repository without cross-owner proposal state.

## Task 4.3 Documents and selected conversation import

- [ ] Support repository Markdown/text/JSON first, using selected paths and commit pins. Cap one source page to 2 MiB before parsing; keep excerpts bounded and store large permitted content as private R2 objects.
- [ ] Add a document adapter for a provider actually discovered and enabled. Preserve file ID, modified version/time, source URL, extraction format/version, content digest and reading limitations. Start with native text exports; Office/PDF extraction goes to an isolated bounded worker, never macro execution in the Site.
- [ ] Give the owner an explicit selected-source list. A Drive connection does not authorize indiscriminate whole-drive ingestion. Document updates produce a diff and replacement observation, not a silent goal edit.
- [ ] Add a stable conversation-export import format and preview: conversation/source ID, selected message IDs, speaker, timestamps, text and source link when available. Deduplicate by provider/message identity plus content hash; edited messages become new revisions with provenance.
- [ ] Automatic conversation refresh is enabled only for a verified supported export/read API and the selected conversations. Codex desktop `read_thread` tools are not assumed to be a public server API. If only manual export exists, ship the importer and label automatic ingestion unavailable; keep its acceptance row open.
- [ ] Route imported ideas/decisions/actions into a review inbox with source references. Source-authored instructions cannot issue commands, create approvals or dispatch agents.

**Tests:** duplicate import; changed message; mixed sources; missing timestamps; unsupported attachment; oversize file; HTML/script payload; path traversal filename; revoked document; hostile text asking the agent to bypass its scope. Invalid content is rejected or safely rendered, never executed.

## Task 4.4 Synchronization engine and jobs

- [ ] Extend `workspace_job_intents` with uniquely linked `integration_jobs` metadata for kind `source_refresh`, owner, target, due time, attempt count, lease expiry, retry-after and stable idempotency key. Insert the intent and extension together; claims, attempts and lifecycle updates share one owner-scoped operational CAS transaction. Only a verified service runner can claim work. Owner configuration/request commands use the shared receipt boundary; already-authorized scheduled occurrences use their unique operational occurrence key. Expired leases resume from committed cursors, never a duplicate independently enqueued job.
- [ ] Limit a run to a bounded amount of work (initially 5 pages/250 observations and a 20-second provider-call budget); persist continuation for the next run. UI shows progress and partial freshness rather than waiting for a large import.
- [ ] Observation uniqueness is `(user_id, sourceId, externalId, sourceRevision, contentDigest)`. Commit immutable observations, operational stream events, deduplicated pending proposals and cursor updates together under the owner-scoped operational CAS. This does not increment the editor revision, alter owner evidence or accept a proposal. Creating/linking/versioning owner evidence or accepting a proposed delta uses `executeWorkspaceCommand`; it cites the saved immutable observation. Use the Phase 1 object lifecycle for R2 metadata finalization.
- [ ] Track `attemptedAt`, `lastSuccessAt`, source revision, failure class, retry time and count. Failed refresh preserves last good content and marks it stale. Do not update last-success time on a partial failure.
- [ ] Register explicit portable projections for source selection/settings, immutable observations, proposals and sanitized run/job/attempt history. Exclude credentials, provider grants, active leases, service identities, executable intent payloads and authorization state. Imported job/attempt rows are historical records only; restore never recreates a runnable queue. Restoring data pauses integrations, invalidates old execution epochs, retains historical observations and requires access revalidation plus an explicit owner resume before scheduled refresh resumes. Exports capture both owner revision and operational stream watermarks through the foundation registry.

**Required acceptance:** repeat a refresh after dropping its success response; one observation/proposal survives. Interrupt pagination after a committed page; retry starts at the next persisted cursor. A foreign owner cannot claim/read another owner's job.

## Task 4.5 Generate and review change proposals

- [ ] Create `source_proposals` containing immutable observation references `{id,contentDigest}`, any accepted evidence references `{id,version}`, affected entity IDs, base workspace revision, proposed field delta, rationale, confidence label, created date, state and dedup key. Generate pending proposals in the operational domain; owner accept/edit/reject/defer decisions use the shared receipt/history boundary. Never resolve a historical citation to the latest mutable evidence version.
- [ ] Deterministic mappings cover concrete facts first: new failed check, merged PR, stale selected document, newly changed accepted source and unresolved previous blocker. A merged PR may suggest progress; it never completes a task automatically.
- [ ] Add side-by-side review with accept selected fields, edit before accept, reject with reason and defer. Source deletion does not erase an accepted decision. Accepted proposal ID must be recorded in history and protected by a durable receipt.
- [ ] On concurrent owner edits, show the source proposal and current entity diff; do not overwrite the goal/status. Resolve per-field or reject the proposal with a conflict status. Task completion and milestone achievement remain separate explicit acceptance actions.
- [ ] Rework baseline display into dated revisions: retain the 17 October package, show newer observations separately, show last successful synchronization, and offer an explicit new baseline review. Never overwrite historical source-check dates.

**Behavior contract test:** implement `proposalDedupKey` in `lib/sources/proposals.ts` to hash a canonical owner/source revision/entity/field-delta tuple. This complete test defines stable ordering and revision sensitivity:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { proposalDedupKey } from '../lib/sources/proposals.ts';

test('proposal identity ignores field order but not source revision', async () => {
  const base = { ownerId: 'owner-a', sourceId: 'source-a',
    sourceRevision: 'revision-a', entityId: 'task-a',
    fields: { notes: 'Check failed', priority: 'high' } };
  const same = { ...base, fields: { priority: 'high', notes: 'Check failed' } };
  assert.equal(await proposalDedupKey(base), await proposalDedupKey(same));
  assert.notEqual(await proposalDedupKey(base),
    await proposalDedupKey({ ...base, sourceRevision: 'revision-b' }));
});
```

Also test duplicate acceptance, changed entity revision, stale evidence, reject/defer retention, owner isolation and imported source text that claims it is already approved.

## Task 4.6 Real integration acceptance and checkpoint

- [ ] Run adapter/domain/storage tests and the source-review browser suite. Record failure-mode screenshots and the actual source IDs/revisions using sanitized metadata.
- [ ] Connect at least one selected real repository, refresh it, verify one returned SHA/check/document against the provider, and read back persisted observations. Record whether this was interactive or unattended.
- [ ] For each claimed automatic integration, launch a fresh supported runner without browser cookies, refresh, and read back evidence. A scheduled job saved without a successful run does not pass.
- [ ] Verify disconnect/revocation disables further reads while retaining permitted historical evidence. Run owner-isolation tests before enabling the connection.
- [ ] Update the gap ledger and `progress.json`, including any provider whose automatic access is unavailable. Commit the phase checkpoint; do not mark unavailable adapters complete.

```bash
node --experimental-strip-types --test tests/source-adapters.test.ts tests/source-sync.test.ts tests/source-proposals.test.ts tests/source-auth.test.ts
npm test
npm run typecheck
npm run lint
npm run build
```

Add `test:e2e` through the Phase 1 harness before invoking `npm run test:e2e -- tests/e2e/source-sync.spec.ts`. Use the browser path supported by the actual cloud environment; lack of that path is a verification gap, not permission to invent one.

## Exit evidence

Sources has useful data and precise disconnected/stale/error states; retained baselines stay historical; replay creates no duplicates; proposals preserve owner edits; selected imports are attributed; manual and unattended reads have separate proof. No external source is modified by this phase.
