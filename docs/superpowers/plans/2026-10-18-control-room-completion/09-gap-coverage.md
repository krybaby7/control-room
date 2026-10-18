# Control Room Audit Gap Coverage

This ledger defines what “complete the things it cannot do” means. Every audited limitation has an implementation phase or an explicit evidence/activation boundary. Update the Evidence column with a commit, test result and hosted/device proof as relevant. All rows start **planned**; no implementation is asserted here.

| ID | Audit gap | Delivery phase | Concrete acceptance | Evidence |
|---|---|---|---|---|
| G01 | Fixed project portfolio | 2 | Create, rename, edit goals/repositories, archive/restore; delete only after impact preview and valid dependent-record resolution | Planned |
| G02 | Milestone opens only an editor | 2, 3 | Stable milestone URL opens tasks, criteria, evidence, blockers, decisions and history together | Planned |
| G03 | No milestone archive/delete/reorder | 2 | Reorder survives reload; archive preserves descendants; delete rejects linked tasks and missing recovery protection | Planned |
| G04 | Cannot move tasks between projects | 2 | Dependency-aware move preview preserves IDs, evidence and capture links; invalid completed graph rejected | Planned |
| G05 | No bulk editing | 2 | Preview and apply one validated batch atomically; no partial edits on one invalid member | Planned |
| G06 | Search only within one project's tasks | 2, 3 | Global search covers tasks/milestones/captures/decisions/evidence, scoped to owner and archive preference | Planned |
| G07 | Dependencies confined to one project | 2 | Cross-project edges work inside one workspace; global cycles/foreign-owner/missing references rejected | Planned |
| G08 | No dependency visualization | 2 | Interactive graph/list shows blockers and completed prerequisites with working detail links and accessible equivalent | Planned |
| G09 | Only first three review items visible | 2 | Attention queue enumerates all review items with pagination/filter counts agreeing with stored data | Planned |
| G10 | No unified blocked/overdue/proposed/stale queue | 2, 3, 5 | All categories have actionable reason, relevant evidence and a resolution/detail link; no silent truncation | Planned |
| G11 | No weekly history or review archive | 2, 5 | Past weeks retain commitments/completions/review snapshots without silently renewing commitments | Planned |
| G12 | No recurring tasks | 2, 5 | One proposed unpinned task per occurrence; retries and missed schedules do not create duplicates or invented commitments | Planned |
| G13 | No time/capacity planning | 2 | Optional estimates and weekly capacity show known load and unestimated work separately; over-budget is advisory | Planned |
| G14 | Capture lacks search and richer triage | 2 | Search/filter/edit/file/convert/archive/restore work without losing source or duplicate conversion | Planned |
| G15 | No file attachments | 3 | Private bounded upload/download with digest, owner check, lifecycle cleanup and portable backup manifest | Planned |
| G16 | Evidence is only loose text/links | 3 | Multiple structured evidence versions link to task/milestone/decision, each with provenance/date/basis | Planned |
| G17 | No acceptance completeness policy | 3 | Configurable criteria distinguish missing/stale/conflicting evidence; acceptance records cite exact versions and explicit owner assessment | Planned |
| G18 | Task completion can have no evidence | 3 | Project/task policy can require evidence or recorded justified waiver; legacy completion is preserved and labeled historical | Planned |
| G19 | No searchable decision register | 3 | Decisions have status, rationale, evidence and supersession links; search and milestone backlinks work | Planned |
| G20 | Baselines never update | 4, 5 | New reviewed baseline revision cites fresh observations; old 17 October baseline remains intact and dated | Planned |
| G21 | No automatic GitHub updates | 4 | Real allowed repository refresh retains SHA/check/PR provenance; background run proves access with browser closed | Planned; provider access required |
| G22 | No connected document updates | 4 | Selected real document change appears as a new attributed observation and review proposal | Planned; provider capability required |
| G23 | No automatic conversation ingestion | 4 | Selected conversation export imports idempotently; automatic refresh additionally requires verified supported API and access | Planned; unsupported APIs remain open |
| G24 | Refresh does not refresh external evidence | 4 | Source Refresh invokes its adapter and exposes success/error/freshness independently from plan Refresh | Planned |
| G25 | No AI analysis of project evidence | 5, 7 | Optional exact-provider/model analysis produces validated cited suggestions under an explicit budget; deterministic brief works without AI | Planned; provider configuration required |
| G26 | No changes-since-review view | 3, 5 | Acknowledged snapshot and source watermark produce reproducible changes; newer events remain unread | Planned |
| G27 | No background reviews/alerts | 5 | One real unattended scheduled occurrence, correct next due, quiet unchanged state and deduplicated meaningful notification | Planned; renewable access required |
| G28 | No push synchronization | 5 | Verified same-origin SSE reconnects using cursor; fallback polling labeled correctly and never overwrites dirty edits | Planned; streaming host test required |
| G29 | No durable/offline drafts | 1 | Server draft restore plus explicitly enabled trusted-device offline outbox; logout/account change protects cached private drafts | Planned |
| G30 | Save can wait indefinitely | 1 | Bounded timeout exits busy state; uncertain outcome reconciles by original mutation ID before resubmit | Planned |
| G31 | Single manual recovery snapshot | 1, 5 | Multiple complete backups, version browser, tested restore and an actually executed scheduled backup | Planned; R2/unattended gate |
| G32 | No merge import | 1 | Dry-run record/ID/reference conflict preview, selective merge and atomic application; source provenance preserved | Planned |
| G33 | Archive cannot free capacity | 1, 2 | Explicit dependency-aware purge/cleanup with recovery; read-only/export remain available at the byte limit | Planned |
| G34 | Near-limit legacy migration can block writes/restore | 1 | Regression fixture migrates, exports/restores and permits reducing edits without silently dropping content | Planned |
| G35 | Receipts have no retention strategy | 1 | Bounded receipt payload retention preserves replay tombstones/horizon rejection; pruned old IDs cannot execute again | Planned |
| G36 | Only 100 generic events and no history screen | 3 | Paginated immutable structured history beyond 100 events; filter, actor, entity and field changes visible | Planned |
| G37 | Baseline/restore changes skip ordinary history | 1, 3 | Both operations produce correlated committed history including restore lineage; failure produces no false success event | Planned |
| G38 | No field-level undo | 3 | Inverse action previews current conflicts and records a new event; cannot blindly rewind external effects | Planned |
| G39 | PC collector disconnected | 6 | Real enrolled Windows bridge sends bounded observations, then offline/reconnect/revocation behavior is verified | Planned; local installation required |
| G40 | No current project runtime health | 6 | Adapter maps actual deployment/heartbeat/source timestamps; offline/stale/unknown are distinct from healthy/failed | Planned; real runtime access required |
| G41 | No agent dispatch/model selection | 7 | One configured exact provider/model or authorized CLI runner accepts a bounded project job; no silent fallback | Planned; provider/executor required |
| G42 | No agent ownership/status/cancel/results | 7 | Lease, event history, cancellation/reconciliation, result artifacts and human review survive restarts and duplicate delivery | Planned |
| G43 | No cost/approval scope for execution | 7 | Requested effects, resource allowlist and budget bound each job; changed requests invalidate approval; unknown cost remains explicit | Planned |
| G44 | Agent Lab is not integrated | 7 | Read existing run/evaluation evidence and invoke only its actual supported bounded evaluations; general coding uses a separate adapter | Planned; local lab test required |
| G45 | Release docs are stale | 0, 8 | Current version/source/deployment/test/device facts agree and link to actual evidence; historical reports retained as historical | Planned |
| G46 | No committed automated browser suite/CI proof | 0, 8 | Repeatable isolated browser/failure/migration suite and portable CI script; hosted CI only claimed for a real configured repository/run | Planned |
| G47 | New reliability behavior not proven on phone/tablet | 8 | Current-version viewport, keyboard/accessibility and actual selected-device acceptance results; passkey step completed by owner | Planned; physical device required |

## Boundaries requiring different completion criteria

| ID | Limitation | Planned treatment | Completion criterion |
|---|---|---|---|
| B01 | Previously erased timestamps | Recovery tools search an explicitly supplied trusted backup, retain provenance and allow labeled correction; never infer a historical completion date from current time | Recover from evidence where available; otherwise retain `unknown` with an explanation |
| B02 | Evidence does not prove itself | Store verification method, candidate/version, device/environment, result and explicit owner acceptance; automated checks only cover their named scope | Required real tests are run and cited; uncertain claims remain uncertain |
| B03 | No guaranteed profitability/release readiness | Provide evidence/acceptance workflows and read-only operational metrics | Present scoped outcomes without a guarantee; actual product acceptance is separate work |
| B04 | No work while the Windows PC is off | Cloud planning/briefs continue; Windows jobs wait and show offline device status; optionally use a separately configured cloud executor | Correct queue behavior and truthful availability, never fabricated progress |
| B05 | No live trading actions | Phase 7 defines a typed operational adapter boundary; default unregistered/disabled. Read-only trading status is Phase 6 | Activation requires a specific separately authorized scope and the trading system's own controls; live order placement is not part of default rollout |
| B06 | No arbitrary remote shell | Use enumerated executable tasks and isolated runner scope | Required planned jobs run through constrained adapters; unrestricted shell remains intentionally unavailable |
| B07 | No two-way tracker writes | Read synchronization and plan proposals cover this audit's external-data scope. A future write adapter needs provider consent, target/action preview and idempotent effect reconciliation | Do not label read synchronization as external write support; no unrequested issue/PR changes |
| B08 | No unavailable platform API | Build adapters and import fallback, record discovery results and exact missing connection/API | Only actual enabled integrations marked complete; fixture-only support stays implemented/unverified |

## Acceptance recording rule

For every row record: status, implementation commit, automated tests, local browser proof, hosted/provider/device proof when applicable, remaining external dependency and next action. “Complete” means its stated criterion passed. A missing live provider should block only its own row and dependent enabled feature, not prevent the rest of the cloud implementation from progressing.
