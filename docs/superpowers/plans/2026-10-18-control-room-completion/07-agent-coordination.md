# Agent Coordination and Controlled Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn explicit project work into finite, reviewable agent jobs with real execution evidence, reliable cancellation, and a clear separation between model output and accepted project completion.

**Architecture:** The cloud coordinates owner-scoped jobs, approvals, leases, events, and private artifacts; a separately enabled Windows executor performs only locally configured capabilities. Reuse Agent Lab as the evaluation evidence source and extract its tested subscription-CLI runtime into a pinned shared package through an independent Agent Lab change. Do not treat its finite fixture queue or Codex desktop chat tools as a general hosted execution API.

**Tech Stack:** Existing TypeScript/Vinext UI and D1 transaction boundary, private R2 artifact storage, Phase 6 enrolled device transport, Node.js 24 executor, existing Codex/Claude subscription CLI runtime under preserved local authentication and policy rules.

---

## Dependencies and evidence boundary

Implement after owner isolation, the atomic mutation/receipt/event foundation in `lib/workspace-transaction.ts`, project/task evidence primitives, and Phase 6 device enrollment and verified private ingress. A cloud environment can build and test the coordinator with fake adapters. It cannot access a Windows checkout, assume desktop tools are available to server code, establish subscription login, or certify actual Windows model execution.

Nothing in this plan was executed during planning. No evaluation was started, model/provider settings changed, CLI invoked, service started, or local run data read. Existing evaluation results remain private local data; synthetic fixtures below are not actual run outcomes.

### What Agent Lab already provides

| Inspected Windows source | Observed interface or behavior | Reuse decision |
| --- | --- | --- |
| `<AGENT_LAB>\README.md` and `src\cli.mjs:16` | Dependency-free Node 24 local workbench on `http://127.0.0.1:4317`; installed subscription CLIs; finite extracted/synthetic fixtures. | Keep it as an evaluation lab, with its own storage and queue. |
| `<AGENT_LAB>\src\server.mjs:23` | `GET /api/state` includes settings, providers, runs, queue, **and csrfToken**. `GET /api/report` returns comparisons and Markdown. | Read a strict projection; never upload raw state, token, provider executable paths, or raw transcripts. |
| `<AGENT_LAB>\src\server.mjs:25` | `GET /api/runs/:id`; writes require local `X-Lab-Token`, same-origin/Host protection, loopback remote address. | No public forwarding; the read-only adapter never obtains a token for a write. |
| `<AGENT_LAB>\src\config.mjs:18` and `src\jobs.mjs:20` | Batch is suite task IDs × enabled model IDs × one to three repetitions; at most twelve runs, thirty to six hundred seconds, one process at a time. | `/api/runs` cannot accept arbitrary project tasks or a general repository/prompt. Do not pretend it can. |
| `<AGENT_LAB>\src\jobs.mjs:10` | Restart marks running jobs interrupted and pauses recovered queued work. | Preserve honest recovery semantics. |
| `<AGENT_LAB>\src\providers.mjs:7` and `:39` | Exact executable/model checks, subscription authentication, sandbox/tool policies, no API fallback. | Share tested runtime policy through a versioned module; do not create divergent copies in the dashboard. |
| `<AGENT_LAB>\src\runner.mjs:5`, `:35`, and `:53` | Streaming protocol parsing, owned subprocess execution, output cap, timeout/cancel, authentication/quota stop, model identity checks, `terminationUnconfirmed`. | Extract the low-level runtime, preserving tests and limits; add device lease/journal ownership around it. |
| `<AGENT_LAB>\src\reports.mjs:3` | Cohorts separate provider/runtime/tool policy/task/version/fixture/model; objective grading and human review are separate. | Imported results may inform task-specific trials; never infer general readiness or dollar savings. |
| `<AGENT_LAB>\AGENTS.md` | Agent Lab development requires GPT-6.1 Sol, standard-library Node and `node:test`, subscription auth, finite batches, no global/sibling changes. | The extraction is a separate Agent Lab handoff implemented by the required model, with its own review and acceptance. |

The inspected README explicitly says successful model-executed fixture reads with the current Windows sandbox adjustment have not yet been demonstrated. Do not erase that limitation because fake-process tests pass. At local installation, re-read the current AGENTS and verify the installed CLI versions/policies; plan-time model availability is not an ongoing entitlement claim.

### Working boundaries

1. **Evaluation visibility:** Read-only Agent Lab summary import is enabled only for the enrolled owner and configured device; no evaluations start as a side effect of GET or sync.
2. **Project execution:** A new Control Room executor uses the shared CLI runtime package inside a dedicated local workspace. It is not the Agent Lab fixture queue, does not write `.lab/`, and does not share active queue state.
3. **Desktop chats:** Codex app chat/list/send tools may be useful to an interactive assistant, but are not a supported unattended server dependency. Store optional human-provided links as references; no scraping app state or invented chat API calls.
4. **Operational systems:** Trading and other production adapters remain read-only/disabled under Phase 6. Jobs cannot obtain deployment, process-control, venue/order, billing, credential, or global-setting privileges through a natural-language prompt. Those require separately defined adapters and explicit authority outside default activation.

## File map

Paths are relative to `project-control-center` unless an Agent Lab path is explicitly identified.

| Files | Responsibility |
| --- | --- |
| Create `lib/agents/contracts.ts`, `lib/agents/policy.ts`, `lib/agents/store.ts`, `lib/agents/transitions.ts`, `lib/agents/artifacts.ts` | Versioned contracts, admission/approval policy, atomic job/lease state, artifact validation. |
| Create `lib/agents/evaluation-import.ts` | Sanitized Agent Lab evidence normalization and deduplication. |
| Modify `db/schema.ts`; add next migration `*_agent_jobs.sql` | `agent_jobs`, `job_attempts`, `job_events`, `job_approvals`, `agent_capabilities`, `evaluation_runs`. Existing private artifacts table/R2 boundary stores result bytes. |
| Create `app/api/jobs/route.ts`, `app/api/jobs/[jobId]/route.ts`, `app/api/jobs/[jobId]/approve/route.ts`, `app/api/jobs/[jobId]/cancel/route.ts`, `app/api/jobs/[jobId]/accept/route.ts` | Owner read/create/approve/cancel and separate result acceptance. |
| Create `app/api/bridge/jobs/claim/route.ts`, `app/api/bridge/jobs/renew/route.ts`, `app/api/bridge/jobs/events/route.ts`, `app/api/bridge/jobs/complete/route.ts`, `app/api/bridge/jobs/reconcile/route.ts` | Scoped executor protocol; no shell payload endpoint. |
| Create `app/api/bridge/evaluations/route.ts` | Owner-mapped evaluation summary ingress with `evaluations:write` scope. |
| Create `components/agents-view.tsx`, `components/job-editor.tsx`, `components/job-detail.tsx`, `components/job-approval.tsx`, `components/evaluation-evidence.tsx`; modify `components/control-center.tsx` | Queue, explicit approval, progress, provenance, result review, narrow-model evaluation evidence. |
| Create `bridge/src/agent-lab.mjs` | Fixed loopback read-only summary adapter; explicit projection removes CSRF token and private provider paths. |
| Create `bridge/executor/cli.mjs`, `bridge/executor/policy.mjs`, `bridge/executor/journal.mjs`, `bridge/executor/lease.mjs`, `bridge/executor/workspace.mjs`, `bridge/executor/runtime.mjs` | Separate opt-in process, local policy, durable attempt journal, lease enforcement, isolated repository workspaces, pinned runtime interface. |
| Create `bridge/executor/adapters/project-inspect.mjs`, `bridge/executor/adapters/project-patch.mjs` | The only initial execution operations. |
| Create `tests/agents-policy.test.ts`, `tests/agents-lifecycle.test.ts`, `tests/agents-leases.test.ts`, `tests/agents-artifacts.test.ts`, `tests/evaluation-import.test.ts` | Owner, policy, lease/race, artifact, and evaluation acceptance tests. |
| Create `tests/e2e/agents.spec.ts`, `lib/agents/export.ts`; register owner tables in `lib/workspace-modules.ts` and export adapter through `lib/workspace-export.ts` | Interactive approval/result acceptance and safe historical export/restore. |
| Create `bridge/test/executor-journal.test.mjs`, `bridge/test/executor-policy.test.mjs`, `bridge/test/executor-cancellation.test.mjs`, `bridge/test/agent-lab.test.mjs` | Fake-process and loopback adapter tests; no model calls. |
| Create `tests/fixtures/agents/lab-summary.json`, `tests/fixtures/agents/lease-recovery.json`, `tests/fixtures/agents/model-identity-mismatch.json` | Sanitized, explicitly synthetic integration fixtures. |
| Create `docs/integrations/agent-executor.md`, `docs/integrations/agent-lab-runtime-handoff.md`, `docs/verification/agent-executor-acceptance.md` | Multi-repository handoff, local enablement, evidence, recovery and rollback. |

## Contracts and authority

These are the initial operations; unknown operation strings are rejected before admission and again on the Windows device. `repositoryKey` resolves to a locally configured repository and fixed allowed paths. The cloud cannot supply an absolute filesystem path, executable, shell command, argument vector, environment variables, provider URL, or credential.

```ts
// lib/agents/contracts.ts
export type AgentOperation = 'project.inspect' | 'project.propose-patch';
export type JobStatus = 'awaiting_approval' | 'queued' | 'leased' | 'running'
  | 'cancelling' | 'succeeded' | 'failed' | 'cancelled' | 'blocked'
  | 'reconcile_required' | 'rejected';
export interface JobSpecV1 {
  schemaVersion: 1;
  operation: AgentOperation;
  projectId: string;
  taskId: string;
  baseWorkspaceRevision: number;      // provenance; owner command checks expectedRevision
  taskSnapshotSha256: string;         // immutable task intent; no invented task row revision
  repositoryKey: string;
  baseCommit: string;                 // exact locally resolvable commit
  inputArtifactIds: string[];         // owner-scoped immutable prompt/evidence
  requestedModel: string;             // exact enabled local model ID
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  timeoutSeconds: number;             // integer 30..600
  outputBytesLimit: number;           // at most 2 MiB across stdout/stderr
  dependsOnJobIds: string[];          // bounded acyclic same-owner dependencies
}
export interface JobLeaseV1 {
  jobId: string; attemptId: string; epoch: number;
  deviceId: string; leaseToken: string; expiresAt: string;
  spec: JobSpecV1; specSha256: string; approvalId: string;
}
export interface JobEventV1 {
  schemaVersion: 1; attemptId: string; epoch: number; sequence: number;
  kind: 'accepted' | 'started' | 'progress' | 'cancel_acknowledged'
    | 'process_exit' | 'artifact_ready' | 'completed' | 'blocked';
  observedAt: string; diagnostic: string;
  details: Record<string, string | number | boolean | null>;
}
export interface JobResultV1 {
  attemptId: string; epoch: number;
  disposition: 'succeeded' | 'failed' | 'cancelled' | 'blocked';
  requestedModel: string; observedModel: string | null;
  modelVerified: boolean; terminalProtocolObserved: boolean;
  processExitConfirmed: boolean; terminationUnconfirmed: boolean;
  artifactIds: string[]; usage: Record<string, number> | null;
  diagnostic: string;
}
```

Validation is closed-schema, not `Record<string,unknown>` passthrough: event `details` is further discriminated by `kind`; no free-form sensitive telemetry is accepted. IDs and exact-model strings have bounded syntax; SHA256 is 64 lowercase hex; base commit is a full Git object ID supported by the local repository. Cap input artifacts at eight, dependencies at eight, pending jobs at twelve per owner, input prompt text at 32 KiB, event batches at fifty/64 KiB, and progress events at one per second. Each execution approval authorizes one immutable spec on one configured device, one attempt, and its fixed bounds; editing any spec field invalidates the approval.

`job_approvals` contains owner, approver, job/spec digest, capability manifest digest, device ID, budget reservation, approval time, expiry, and revocation. Approval expires after twenty-four hours if the job has not launched; a running attempt remains constrained by its shorter wall-clock deadline and revocation/cancel rules. Hash canonical JSON with defined stable field ordering; never hash arbitrary object insertion order. `taskSnapshotSha256` covers the current task's projectId, milestoneId, title, notes, status, dependsOn, blocker, source/evidence references and acceptance-linked inputs in a fixed server-defined order; unordered ID sets are sorted. The existing tasks have no numeric row revision, so do not invent one. Unrelated workspace edits may advance the global revision without changing this task snapshot. `agent_jobs` stores owner/project/task, captured workspace revision and task digest separately from execution status. `job_attempts` freezes adapter/runtime version, executable digest/version evidence (no cloud path), requested model, observed identity, tool policy, base commit, input digest, and lease epochs.

Use the foundation's existing `workspace_job_intents`, unique `(user_id,kind,dedupe_key)`, with `kind:'agent.execute'` and a unique `agent_jobs.intent_id` link. Create both the durable intent and immutable job in the same owner transaction; approval gates consumption of that intent. The lease handler consumes this committed intent and updates its lifecycle with the agent row, rather than creating a second independent queue. Internal source/backup/review jobs continue to use their existing handlers and do not become model execution jobs. All new storage owner columns are `user_id`, consistent with the foundation registry. High-frequency lease/event/heartbeat acknowledgements use narrow owner-and-row-version operational CAS transactions and do not advance the editor revision; owner create/approve/cancel/accept/configuration commands do use `executeWorkspaceCommand` and its revision/receipt/audit contract.

Use a mapped device principal from Phase 6. Execution requires both `jobs:poll` and `jobs:report`; a telemetry device cannot receive prompts. `agent_capabilities` is a dated report of locally enabled operations, exact models, permitted repository keys, platform/runtime/tool-policy versions, local slot availability, and resource limits. It is evidence of local configuration, not permission to enable a capability remotely. Stale capability reports block new dispatch after five minutes. Credentials and private artifacts remain owner-scoped, and all foreign keys/queries include owner ID.

Budget rules are deterministic: an approval reserves one job and its full timeout from the owner's configured finite batch budget. Claim atomically checks that reservation, device capability, current task snapshot/spec digest, dependency success, available device slot, and absence of a live attempt. Release unused reservation on pre-launch rejection/cancel; charge actual elapsed runtime after confirmed exit while retaining requested maximum. The local executor enforces its own equal-or-tighter job count, runtime, concurrency, and output caps. Provider token/cost telemetry can be unknown; do not claim a hard token or dollar cap that a subscription CLI cannot enforce. No API-key fallback, credit purchase, quota reset, provider substitution, or automatic retry on authentication/quota/model-identity failure.

## Task 1: Import Agent Lab evaluation evidence without launching work

- [ ] Add `tests/fixtures/agents/lab-summary.json` using the following source-derived, synthetic shape. Include hostile extra fields such as `csrfToken`, a local executable path, and transcript text in the raw test response; assert they are absent from the imported record.

```json
{
  "version":"0.1.0",
  "queue":{"paused":true,"activeId":null},
  "runs":[{"id":"fixture-run-1","taskId":"incident-evidence-v1","taskVersion":1,"fixtureHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","provider":"codex","requestedModel":"gpt-6-luna","observedModel":null,"modelVerified":false,"runtimeVersion":"fixture-runtime","runtimeToolPolicy":"native-sandbox","promptMode":"structured","effort":"medium","status":"blocked","grade":null,"review":{"verdict":"pending","minutes":null,"corrections":null},"usage":null,"createdAt":"2026-10-18T12:00:00Z","finishedAt":"2026-10-18T12:00:01Z"}]
}
```

- [ ] Implement `bridge/src/agent-lab.mjs` with only fixed `GET http://127.0.0.1:4317/api/state` and `/api/report`, the same loopback/no-redirect/deadline/body limits as Phase 6, and a field-by-field normalized projection. A GET state response contains a CSRF token: never log the raw response, retain that field, or forward it. Exclude settings, account attestations, executable paths, final text, error prose, and recommendation prose from automatic import. Fetching the report is optional and uses only its typed cohort counts, not raw Markdown.
- [ ] Implement `lib/agents/evaluation-import.ts` and `/api/bridge/evaluations` with an owner/device/source-instance/run-ID unique key. Preserve the original terminal status, requested and observed model, nullable usage, fixture identity, tool policy, objective grade and independent human verdict. A corrected upstream outcome updates the imported observation history; it does not silently replace provenance. Task-linked evidence includes source instance and observation time.
- [ ] Add `components/evaluation-evidence.tsx`: show fixture/synthetic provenance, cohort conditions, pass/assessable denominator, all attempt statuses, human review, model identity verification, and unknown usage. Never calculate dollars saved or recommend general delegation from one fixture. Missing lab is `unavailable`; empty lab is `no runs`; both differ from success.
- [ ] Run `node --experimental-strip-types --test tests/evaluation-import.test.ts` and `node --test bridge/test/agent-lab.test.mjs`. Expected: no POSTs/model calls, no token/path leakage, no fake pass for blocked runs, no cross-owner attach, and repeated sync is idempotent.

## Task 2: Extract and pin the existing runtime through an Agent Lab handoff

This task is a separate change in `<AGENT_LAB>`, not a request for a Control Room worker to modify a sibling repository. The cloud implementation can complete against a fake `RuntimeAdapter` while the handoff remains unverified. A worker implementing the Agent Lab extraction must use GPT-6.1 Sol per that repository's AGENTS and preserve its standard-library/test constraints.

- [ ] In `docs/integrations/agent-lab-runtime-handoff.md`, request these exact Agent Lab changes: create `packages/subscription-runtime/package.json`, `packages/subscription-runtime/src/index.mjs`, `packages/subscription-runtime/src/providers.mjs`, `packages/subscription-runtime/src/runner.mjs`, `packages/subscription-runtime/src/policy.mjs`, and `test/shared-runtime.test.mjs`. Move existing provider/protocol/process-policy implementations from `src/providers.mjs`, `src/runner.mjs`, and the shared environment/redaction helpers in `src/config.mjs`; leave compatibility re-exports so Lab behavior stays unchanged. Do not move suite materialization, grading, lab settings, storage, or queue authority.
- [ ] Define the exported package API around the existing semantics:

```ts
// A local module API only. These values are built by trusted local configuration.
export interface RuntimeAdapter {
  probe(config: LocalProviderConfig): Promise<ProviderEvidence>;
  execute(request: LocalExecutionRequest): Promise<LocalExecutionResult>;
}
export interface LocalProviderConfig {
  provider: 'codex' | 'claude'; executable: string;
  subscriptionOnly: true; extraUsageOffAttested: boolean;
}
export interface ProviderEvidence {
  ready: boolean; runtimeVersion: string | null;
  issues: string[]; checkedAt: string; toolPolicy: string;
}
export interface LocalExecutionRequest {
  config: LocalProviderConfig; workspace: string; prompt: string;
  requestedModel: string; effort: string; mode: 'response' | 'edit';
  timeoutMs: number; outputBytesLimit: number; signal: AbortSignal;
}
export interface LocalExecutionResult {
  status: 'completed' | 'failed' | 'timed_out' | 'cancelled' | 'blocked' | 'rate_limited';
  finalText: string; stdout: string; stderr: string;
  observedModel: string | null; observedModels: string[];
  completed: boolean; exitCode: number | null; terminationUnconfirmed: boolean;
  usage: Record<string, number> | null; error: string | null;
}
```

- [ ] Require the package tests to preserve exact CLI flags, subscription checks, clean environment, sandbox/tool differences, terminal-event parsing, bounded output, quota/auth/model mismatch stops, and process-tree cancellation semantics. Existing Agent Lab core/runtime/suite tests must still pass; no live evaluation is needed for extraction verification. Pin an immutable package version, source commit, tarball SHA256 and the tested Node/platform matrix in the handoff artifact.
- [ ] Add the package to a separate executor package manifest/lockfile after the handoff is reviewed. Do not import `../agent-lab/src` using a mutable absolute path and do not silently replace the runtime with a custom CLI spawn implementation when the package is unavailable. The coordinator reports the adapter `not_installed`; the fake adapter remains test-only and cannot be selected in production.

## Task 3: Implement admission, approval, and atomic job lifecycle

- [ ] Add the D1 migration, typed schemas, and pure state transition tests before routes. Use the following transitions; invalid edges return 409 and leave history unchanged:

```text
awaiting_approval -> queued | rejected | cancelled
queued           -> leased | blocked | cancelled
leased           -> running | cancelling | reconcile_required | blocked
running          -> succeeded | failed | blocked | cancelling | reconcile_required
cancelling       -> cancelled | succeeded | failed | blocked | reconcile_required
reconcile_required -> succeeded | failed | cancelled | blocked
```

`succeeded` from `cancelling` is allowed only when ordered device evidence proves completion and exit preceded cancellation acknowledgement; show the timing race in the event history. Expired leases never directly requeue. A retry is a new linked job/attempt with new explicit approval after reconciliation; no success-like status represents an unknown process. Terminal results are immutable apart from append-only corrections with provenance.

- [ ] Implement browser job creation through `lib/workspace-transaction.ts`: validate the owner/project/task, captured workspace revision and task snapshot, immutable evidence artifacts, exact repository/model/capability compatibility, and bounded dependency DAG. Persist `awaiting_approval`, canonical spec digest, `workspace_job_intents` row, linked `agent_jobs` row, mutation receipt and event atomically. Same mutation ID + digest returns the original job; same ID + changed spec returns 409.
- [ ] Implement approve/reject/cancel endpoints with same-origin browser protection and owner authentication. Approval UI shows operation, repository alias/base commit, allowed paths and adapter capabilities, exact model/effort, tool access, deadline/output/batch bounds, input artifact titles/digests, and expected result. Local capability manifest changes invalidate an unlaunched approval. A stale task/spec is re-presented for approval, not silently updated.
- [ ] Implement `/api/jobs` and job detail reads with owner-only pagination/events; return explicit unavailable/blocked reasons without sensitive runtime details. Ensure approval, claim, completion, artifact attachment and task acceptance use atomic store boundaries, not in-memory worker locks.
- [ ] Run `node --experimental-strip-types --test tests/agents-policy.test.ts tests/agents-lifecycle.test.ts`. Expected: unauthorized owners/devices cannot approve or inspect jobs, duplicate intent is deduplicated, cycles/foreign task links are rejected, an expired approval never launches, and no job result automatically marks the project task done.

## Task 4: Add fenced leases, reliable event ingestion, and reconciliation

- [ ] Add `tests/agents-leases.test.ts` with two concurrent claims for one job, two jobs for one device slot, duplicate/out-of-order events, expired lease, stale-epoch completion, lost completion response, claim-response loss, revoked device, cancel-before-launch, cancel-versus-completion, and database rollback. Use a fake clock and in-memory D1-compatible test database; no sleep-based timing assertions.
- [ ] Implement claim as a compare-and-set transaction that reserves the configured device slot, inserts one `job_attempts` row, advances the job version, consumes the single-attempt approval reservation, and writes an event. Use durable D1 predicates/constraints so concurrent Workers cannot both win; a JavaScript mutex is insufficient. Confirm the chosen conditional-update and batch transaction behavior with the repository's local D1 test harness and a deployed private test environment before release.
- [ ] Issue a sixty-second lease and renew every fifteen seconds. Lease tokens are random, stored as digests, bound to owner/device/job/attempt/epoch, and absent from logs. Every event, renewal, artifact upload grant, and completion checks that binding. Claim responses are recovered by device/attempt journal identity rather than requesting an unrelated second attempt after a lost response.
- [ ] Persist events under unique `(user_id,attempt_id,epoch,sequence)` with a canonical payload digest. Identical duplicates return the receipt; changed-content duplicates fail. Acknowledgements report highest contiguous sequence; gaps are retried from the local durable journal. The server stores out-of-order events without applying a transition until the required preceding event exists. Client timestamps are evidence; server receipt/order and lease epoch govern authority.
- [ ] On timeout or missing heartbeat, move to `reconcile_required`, retain the device slot reservation, and display **execution state unknown**. Do not reassign the job to another device. Reconcile accepts a journal-backed final result or proof that launch never occurred; if neither is available, retain the block and require local process ownership investigation. Fencing prevents stale cloud writes; it does not itself stop an already-running process.
- [ ] Implement owner cancel as a persisted request returned by renewal and poll. The executor stops only its owned process tree, records cleanup evidence, and sends terminal `cancelled` only after exit confirmation. If offline beyond the local lease deadline, it requests the same bounded stop locally. `terminationUnconfirmed` produces `reconcile_required`, never `cancelled`. Revocation prevents new claims immediately; the active process stops by lease expiry when renewal is denied. Record this delay clearly.
- [ ] Run `node --experimental-strip-types --test tests/agents-leases.test.ts`. Expected: exactly one admitted active attempt, no stale-epoch state changes, no unproven cancellation, duplicate completion yields one result, and uncertainty does not create a second process.

## Task 5: Implement the separate local executor and its durable journal

- [ ] Create executor configuration with `enabled:false`, `maxConcurrent:1`, an empty repository map, empty permitted model list, and zero enabled operations. Telemetry enrollment does not activate it. Enabling a capability requires local repository/model/tool-policy selection, a valid execution-scope enrollment, and explicit owner approval of the first finite job. Store provider authentication only in the existing local provider home; never send it to cloud storage.
- [ ] Implement local repository registration: canonical absolute root, user-chosen opaque key, permitted relative paths, exact runtime/model settings, and permitted operation list. Reject traversal, UNC/network roots unless explicitly supported in a later adapter, symlink/junction escapes, configuration outside the registered root, unknown base commit, and protected credential/config paths. Make a dedicated worktree from the exact local base commit without copying uncommitted changes. Record source commit plus an explicit omitted-local-changes note; do not infer a current dirty checkout from its HEAD.
- [ ] Implement `project.inspect` as read-only workspace analysis returning a report artifact, and `project.propose-patch` as edits only in its isolated registered workspace returning a patch and result report. Inspection acceptance checks require a bounded JSON report with `summary`, `findings:[{path,line,claim,evidenceSha256}]`, and `limitations`; verify cited paths/line ranges within the registered checkout and evidence digests. Patch acceptance additionally checks an actual Git diff exists, every changed path is allowed, the diff applies to the exact base commit, and the original checkout remains unchanged. These are artifact-integrity checks, not proof the model solved the task. The second operation cannot apply/merge into the original checkout. The cloud supplies task content as an immutable input artifact, not shell instructions. Treat imported issues, logs and documents as untrusted input; prompt restrictions supplement the runtime sandbox and local capability checks rather than replacing them.
- [ ] Create `bridge/executor/journal.mjs` with atomic durable records before and after each side effect:

```json
{"schemaVersion":1,"jobId":"fixture-job","attemptId":"fixture-attempt","epoch":1,"specSha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","phase":"launch_intent","workspaceKey":"fixture-worktree","processIdentity":null,"nextEventSequence":2,"leaseDeadlineMonotonicMs":60000}
```

Persist `claimed -> workspace_ready -> launch_intent -> process_started -> process_exited -> result_uploaded -> acknowledged`. Record owned process identity after spawn; PID alone is insufficient. If recovery finds `launch_intent` with no proven process identity, mark uncertain and do not launch again. Pair the launch journal with an owned-process supervisor/Windows job object or equivalent checked identity and kill-on-close behavior. Validate actual Windows lifecycle behavior; existing `taskkill` handling alone is not proof against every executor-crash/PID-reuse interval.
- [ ] Implement lease handling with monotonic local timers derived from a bounded server response duration; wall-clock edits cannot extend execution. Check capability/spec/budget and write launch intent immediately before the shared runtime `execute` call. Stop at the shorter of job deadline and lease deadline. Pause the executor on authentication, quota, observed-model mismatch, policy block, or unconfirmed process termination. Restart defaults to reconcile/review, not resume-and-relaunch.
- [ ] Implement journaled event/result retries separately from Phase 6's lossy telemetry outbox. Never drop a start/exit/terminal event to make room; reaching the execution-journal cap blocks new launches and surfaces action required. Preserve failed upload evidence locally until confirmed cloud receipt; no model rerun to recreate an artifact.
- [ ] Add fake executable tests for lost claim/exit response, crash at every journal phase, parent/child cleanup, PID identity mismatch, cancellation under output, output cap, timeout, quota signal, model mismatch, missing terminal event, and unavailable observed identity. Test path rejection using real temporary symlinks/junctions where platform permits, with explicit platform skips recorded.
- [ ] Run `node --test bridge/test/executor-journal.test.mjs bridge/test/executor-policy.test.mjs bridge/test/executor-cancellation.test.mjs`. Expected: no second launch after uncertain intent, no uncontrolled path or environment field, no auto-resume after runtime blocks, and all cancellation claims require observed owned-process exit.

## Task 6: Store private artifacts and make result review meaningful

- [ ] Implement attempt-scoped artifact grants using the shared private R2 service: owner/device/attempt binding, artifact type allowlist (`text/plain`, `text/markdown`, `text/x-diff`, `application/json`), declared size/hash, maximum two MiB per raw runtime transcript and ten MiB total result package, short grant expiry, and no public object URL. Finalize only after bytes/hash/type match. Readers require the owner session every time; a guessed object key is not authorization.
- [ ] Reject arbitrary HTML/script rendering, path traversal in artifact names, and artifact attachment from another job/owner. Redact runtime secrets locally before upload and scan again server-side with a quarantined rejection reason; do not imply pattern scanning guarantees all private content is absent. Prompt/evidence/report artifacts are private owner data with explicit retention controls. Raw transcripts upload only when selected; automatic summaries contain bounded typed diagnostics.
- [ ] Implement `JobResultV1` checks: `succeeded` requires successful terminal protocol, confirmed exit, successful declared adapter acceptance checks, and a matching requested/observed identity when the runtime emits identity. A missing observed identity stays null/unverified and is disclosed; whether such a result is acceptable is an explicit local policy, never a fabricated verification. An emitted different model blocks the run. A CLI exit code of zero alone is insufficient.
- [ ] Add Agents navigation and job detail UI showing queue/run state, approval bounds, device/lease freshness, last confirmed event, requested/observed model, runtime/tool policy, input/base identity, private report/patch links, independent acceptance checks, recorded usage or unknown, and actionable blocked reasons. Optimistic UI must not display a job as running merely because it was submitted.
- [ ] Add a separate **Accept result** owner action. It attaches immutable result evidence and, only when the owner explicitly chooses and current task snapshot still matches, updates the task through `lib/workspace-transaction.ts` with the current expected workspace revision. Model success does not close a milestone, merge a patch, publish a deployment, or approve trading actions. A changed task keeps the result reviewable but requires a fresh explicit mapping.
- [ ] Register `lib/agents/export.ts` for historical jobs, immutable result references, imported evaluation provenance and disabled capability preferences. Exclude credentials, lease tokens, active process identities, approval grants, reserved budgets and executable/local path configuration. Restored jobs are historical records with no runnable intent; never recreate a queue from an export. Before a workspace restore commits, pause unclaimed execution intents, revoke unlaunched approvals and request cancellation of active attempts. Keep uncertain active attempts in reconciliation until actual exit evidence arrives; restore cannot claim a process has stopped. Test that restore followed by executor reconnect launches zero jobs.
- [ ] Run `node --experimental-strip-types --test tests/agents-artifacts.test.ts tests/agents-lifecycle.test.ts`, `npm run typecheck`, and `npm run test:e2e -- tests/e2e/agents.spec.ts`. Expected: private downloads stay private, malformed/foreign artifacts are rejected, result acceptance is idempotent/revision-aware, restore never dispatches work, and job completion and human task acceptance remain distinct.

## Task 7: Verify cloud behavior, then hand off bounded Windows acceptance

- [ ] Run the scoped tests above followed by the final verification phase's lint/test/typecheck/build and browser scenario gate. The fake adapter must be visibly test-only, unavailable in production builds, and all fixture results marked synthetic. Validate queued, disabled, awaiting approval, expired approval, blocked/quota, offline, running, cancelling, unknown state, completed/unreviewed, rejected, and accepted UI scenarios.
- [ ] Record a cloud verification artifact containing repository commit, migration IDs, package/runtime digest, private ingress evidence, owner/device isolation tests, lease-race fixtures, event ordering, and artifact permission checks. This establishes coordinator behavior, not successful local model execution.
- [ ] Before a real Windows run, the local operator re-reads Agent Lab AGENTS, reviews the runtime handoff/package provenance, confirms existing subscription auth and permitted exact model, enables one operation/repository, and selects one synthetic fixture job with a thirty-second minimum/thirty-to-six-hundred-second bounded timeout and one approved attempt. The first test is `project.inspect`; no production checkout changes, live trading actions, or automatic evaluation batch are part of acceptance.
- [ ] Use the executor's proposed local commands after its implementation and explicit local enablement:

```powershell
node bridge/executor/cli.mjs doctor
node bridge/executor/cli.mjs run --one-approved-job
```

Expected: the named exact model performs the fixture within the configured sandbox/tool policy; the cloud shows the true result and identity evidence, including missing identity as unverified. If a native policy rejects the read, retain `blocked` and its sanitized diagnostic; do not change sandbox or approval policy to manufacture a pass. Subscription authentication/quota failure stops the finite run.
- [ ] Demonstrate cancellation and reconnect using a fake owned child process first; record actual Windows process-tree exit and recovery evidence. Run a separate authorized real-model cancellation trial only if needed to verify the selected provider's behavior and within a newly approved finite budget. Verify an unrelated process continues. Exercise ingress expiry, executor restart, uncertain launch, lost final response, revoked device and local disable. No scenario may trigger a duplicate model launch without new approval after reconciliation.
- [ ] Fill `docs/verification/agent-executor-acceptance.md` with exact source/runtime/package identities, requested/observed model, fixture digest, timestamp, permission policy, attempt ID, outcome, exit confirmation and artifact hashes. Omit credentials/account identifiers. Mark Linux-only/fake results and Windows/model results in separate columns; unperformed checks remain **not run**.
- [ ] Commit Control Room as `feat: coordinate bounded agent jobs` after checks pass. Keep the independent Agent Lab extraction commit/PR and versioned package provenance in the evidence record. Enable production execution only after private ingress renewal, runtime probe, sandbox behavior, lease/cancellation, and owner acceptance are verified on the actual device.

## Completion gate and explicit exclusions

Cloud completion means the coordinator, approval UI, typed lease protocol, owner isolation, evaluation import, private artifact review, fixtures, and disabled executor package pass their checks. Operational completion additionally requires the shared runtime handoff and real Windows model/lifecycle evidence. Neither an Agent Lab pass nor a desktop chat status proves an arbitrary project job can execute.

Initial capabilities are only project inspection and isolated patch proposals. Remote arbitrary shell payloads, direct Codex desktop messaging, automatic provider/model fallback, unlimited loops, retry-after-unknown execution, merge/deploy actions, production service changes, and live order submission are not activated by this plan. A later capability must define its own typed operation, local authority, exact approval content, bounded budget, evidence, and rollback before it can be enabled.
