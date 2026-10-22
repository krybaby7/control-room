# Continuing Project Understanding Implementation Plan

> **For agentic workers:** Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement these checkboxes. Record focused checks and commits in `progress.json`.

**Goal:** Turn all available retained conversations into one continuing, cited story per project area, retaining unfinished work across chats without inventing acceptance.

**Architecture:** Read immutable Chapter 1 history records at a pinned watermark. Associate sources, extract claims, reconcile persistent work items, verify citations and publish immutable `AreaStory` projections through the shared operational job/CAS boundary. Owner commands alone accept proposals, classification overrides or completion.

**Tech Stack:** Existing TypeScript, strict Zod, D1/Drizzle, Node 24 and synthetic SQLite fixtures; optional configured server-side semantic analysis.

## Preconditions and ownership

Read Chapters 0–3, current `lib/types.ts`, `lib/planning.ts`, `lib/workspace-store.ts`, `lib/workspace-validation.ts` and the older evidence/reviews plans. F3 contracts and F4 storage must be locked before integration; U1–U4 can start against synthetic normalized fixtures. Shared files, schema/migrations and command registration belong to the integrator. This chapter does not require the older full reviews, telemetry or agent-execution phases.

Keep `ConversationRecord`, `MessageRevision`, `Citation`, `AreaStory`, `WorkType` and `ProjectArea` exactly as Chapter 1 defines them. The following are proposed **additions** for integrator review in `lib/history/contracts.ts`, with strict codecs in `lib/history/validation.ts`; freeze them during S1 before parallel implementation, and do not create incompatible private copies.

```ts
export interface SourceContext {
  sourceId: string;
  conversationId: string;
  messageRevisionId: string;
  repositoryIdentity: string | null;
  branch: string | null;
  commit: string | null;
  basis: 'provider_metadata' | 'cited_text' | 'owner_override';
}
export interface HistoryClaim {
  id: string;
  projectId: string;
  areaId: string | null;
  kind: 'intent' | 'implementation' | 'verification' | 'release' |
    'decision' | 'cancellation' | 'supersession';
  text: string;
  basis: 'observed' | 'inferred';
  citations: Citation[];
  supportingEvidence: Array<{ kind: 'repository'; snapshotId: string; digest: string }>;
  context: SourceContext;
  supersedesClaimId: string | null;
  extractorVersion: string;
}
export interface HistoryWorkItem {
  id: string;
  projectId: string;
  areaId: string | null;
  workType: WorkType;
  title: string;
  state: 'open' | 'observed_finished' | 'cancelled' | 'superseded';
  disposition: 'requested' | 'idea' | 'proposal';
  taskId: string | null;
  claimIds: string[];
  supersededById: string | null;
  rowRevision: number;
}
export interface AreaProgress {
  projectId: string;
  areaId: string;
  planningRevision: number;
  sourceWatermark: string;
  observedFinishedWorkItemIds: string[];
  acceptedTaskIds: string[];
  openWorkItemIds: string[];
  roadmap: {
    scopeId: string;
    scopeRevision: number;
    agreed: boolean;
    defined: number;
    ownerAccepted: number;
    checkpoints: Array<{
      id: string;
      mandatory: boolean;
      observedStage: 'unknown' | 'planned' | 'in_progress' |
        'implemented' | 'verified' | 'released';
      claimIds: string[];
      ownerAccepted: boolean;
      acceptanceRef: string | null;
    }>;
  } | null;
  coverageComplete: boolean;
  unknowns: string[];
}
```

`observed_finished` is an evidence-backed inference, never a new `TaskStatus` or accepted completion. `acceptedTaskIds` derives only from explicit owner planning commands and their audit provenance; migrated done records retain their historical label. Roadmap counts require a defined owner-authored checkpoint set and explicit acceptance records; otherwise `roadmap` is null. Each checkpoint has its own evidence-backed stage and acceptance. Stage ordering is a display convention, not proof that release implies every physical/software criterion. Do not derive an overall percentage from message volume, extracted items, model confidence, completed code changes or a changing inferred denominator.

## Task U1 — Resolve stable product/area identity

**Create:** `lib/history/association.ts`, `lib/history/association-store.ts`, `tests/history-association.test.ts`, `tests/fixtures/history/association.ts`. **Integrator modifies:** shared contracts/codecs, command handlers, `db/schema.ts` and the next migration for owner-scoped association rules/overrides.

- [ ] Write fixtures where TAMENNI application and map-lab repositories map to one project but separate stable areas, an identical folder/title belongs to another project, and two providers reuse a native thread ID.
- [ ] Run `node --experimental-strip-types --test tests/history-association.test.ts`; expect failing behavior assertions before implementation.
- [ ] Implement precedence: explicit owner override → verified provider/repository identity rule → cited alias suggestion → unresolved. Canonicalize repository host/owner/name using documented provider rules; retain original identity. Do not merge repos by basename, chats by title, or products by branch name. Same native ID under different source identities remains distinct.
- [ ] Persist owner rules with scope (conversation, repository or selected messages), row revision, reason and provenance. Rule changes are receipt-backed owner commands; reprocessing emits a new projection while preserving old attribution/history. An area rename retains its ID; archived areas remain resolvable. Ambiguous records stay unassigned with a reviewable suggestion; ingestion cannot invent areas or rewrite owner task classification.
- [ ] Keep null-area claims/items in the project's Unclassified queue and retain wholly unassigned conversation evidence in the association queue. Do not synthesize a fictitious area ID or omit those records from processing/coverage. One conversation may supply claims to several areas. Area stories are published only for a stable area after association.
- [ ] Preserve branch/commit context per claim, including mid-chat repository/branch switches. Provider metadata and cited tool output may conflict: retain both and surface a conflict. A successful check on commit A/branch X cannot verify commit B/branch Y; null commit remains unknown.
- [ ] Rerun the focused command and `npm run typecheck`; expect pass. Commit `feat: resolve history to stable project areas`.

## Task U2 — Verify immutable citations before accepting extracted claims

**Create:** `lib/history/citations.ts`, `lib/history/claims.ts`, `app/api/history/claims/[claimId]/route.ts`, `tests/history-citations.test.ts`, `tests/history-claims.test.ts`.

- [ ] Write failing tests for Arabic/emoji offsets, wrong digest, foreign-owner message, modified source, out-of-range span, missing segment, invented claim ID and a passing test statement contradicted by the cited tool result.
- [ ] Run `node --experimental-strip-types --test tests/history-citations.test.ts tests/history-claims.test.ts`; expect failure before implementation.
- [ ] Resolve each `Citation` against the retained immutable normalized text and normalization version. Verify owner, message revision, digest and half-open Unicode code-point range using `Array.from(text)`; require a nonempty relevant span. A valid offset alone does not establish that a claim is supported. Store source bytes and redacted analysis text separately; use an explicit immutable span map if analysis text differs.
- [ ] Validate claim schema and citation membership in the job input. Preserve assistant assertions as documented statements unless verified tool/artifact evidence supports the stronger claim. Distinguish requested work, reported implementation, observed verification and release evidence. Rejected claims retain bounded diagnostics and never enter Finished.
- [ ] Validate every supportingEvidence reference against an immutable owner-scoped U6 snapshot and its digest/candidate/environment. Persist those links with claims, expose them through authenticated claim detail, and export them with the exact snapshot versions. A repository check cannot strengthen a claim without a retained supporting reference. Original chat citations remain attached when the claim originated in conversation.
- [ ] Treat imported user/system/tool text as data: embedded instructions cannot modify policies, approve their own claims or execute commands. Do not render source HTML. Preserve unknown observation date/environment/candidate instead of inventing them.
- [ ] Rerun focused tests; expect pass. Commit `feat: validate cited history claims against immutable sources`.

## Task U3 — Reconcile continuing work across conversations

**Create:** `lib/history/work-items.ts`, `lib/history/reconcile.ts`, `tests/history-work-items.test.ts`, `tests/fixtures/history/cross-chat.ts`. **Integrator modifies:** F4 claim/work-item/event storage codecs and indexes.

- [ ] Add a scenario: chat A requests Android acceptance planning; chat B implements a harness; chat C resumes A and cancels one device case; chat D reports a failed physical check. Assert one continuing request, distinct implementation/physical claims, a retained open acceptance loop and cited cancellation.
- [ ] Add scenarios for duplicate imported chats, subagent findings requoted by their parent, repeated reminders, an unrelated similarly worded task, an idea never requested, a rejected proposal, superseding requirements, an explicit reopen and contradictory branch-specific results.
- [ ] Run `node --experimental-strip-types --test tests/history-work-items.test.ts`; expect failure before implementation.
- [ ] Use stable work-item IDs plus append-only events with operation/input identity. Resolve explicit references and provider continuation relationships first; use semantic matches only as cited candidate links. Do not globally collapse similar titles. Ambiguity preserves separate items and a conflict for review.
- [ ] Keep requested unresolved work until cited resolution, cancellation or supersession; it must survive a new chat, a shorter summary, compaction, and absence from the latest batch. Ideas/proposals remain visible as suggestions rather than accepted work. Cancellation is not completion; supersession links the replacement and retains the original. Retain conflicting claims; do not choose truth merely by newest ingestion time.
- [ ] A passing implementation/test result may move an inferred item to `observed_finished` for its exact scope; it does not close physical/release/owner acceptance requirements. Owner task completion/acceptance uses existing explicit commands with stable item/claim references. Creating a planning task from a proposal requires an owner command, records linkage and is idempotent; extraction cannot silently create tasks or commitments.
- [ ] Reconcile under F4 operational CAS at an exact input watermark; append claims/events and publish the new head atomically. Test two reconcilers and lost response/replay: no duplicate items/events or partial head update. Owner overrides and task edits racing reconciliation force a rebase/retry against the new planning revision.
- [ ] Rerun focused tests and existing planning tests; expect pass. Commit `feat: retain continuing work and resolutions across chats`.

## Task U4 — Full-history semantic extraction with incremental catch-up

**Create:** `lib/history/analysis-policy.ts`, `lib/history/analysis-adapter.ts`, `lib/history/extract.ts`, `tests/history-analysis.test.ts`, `tests/history-catchup.test.ts`.

- [ ] Write failing tests for an old unresolved request outside the recent window, late arrival of an earlier segment, resumed old chat, edited message revision, extractor-version change, missing attachment, budget exhaustion and invalid model citations.
- [ ] Run `node --experimental-strip-types --test tests/history-analysis.test.ts tests/history-catchup.test.ts`; expect failure before implementation.
- [ ] Process all available retained selected history through bounded deterministic chunks with exact message/segment identities, inherited ranges and extraction checkpoints. Never replace this with prompt/title indexes or a recent-message-only scan. Chunk summaries retain unresolved item IDs, source citations and coverage; they are derived caches, not substitute primary evidence.
- [ ] Track processed input digests, normalization/extractor version, source watermark and affected areas. A resumed conversation, changed revision, late segment or resolved gap schedules affected reconciliation and dependent snapshots. Initial import is bounded/resumable; catch-up reaches the same result as a full rebuild from the same retained input. Retry preserves job/input identity and does not repeat successful paid calls blindly after uncertain outcomes.
- [ ] Use a provider-neutral adapter accepting bounded immutable inputs, selected existing item context, timeout/cancellation and a strict cited output schema. Implement a deterministic fixture adapter for tests. Runtime model analysis stays disabled until actual provider, exact model, privacy scope, renewable access and budget are configured and authorized. Required `gpt-6.1-sol` implementation/review workers do not configure the product's inference provider or grant paid runtime access. Never silently substitute a model/provider.
- [ ] Record actual provider/model, input digest, usage, known/unknown cost and validated result/diagnostics. Surface `not_configured`, `budget_exhausted`, `unavailable`, `cancelled`, `invalid_result` and successful states. Without semantic runtime access, deterministic owner/source facts remain useful while semantic understanding is explicitly pending.
- [ ] Retain Chapter 1 coverage gaps throughout extraction: complete processing of available text does not mean complete source history. Missing segments, inaccessible clouds, attachments, truncation and failed analysis appear in story unknowns; analysis completion cannot set source inventory/content complete.
- [ ] Rerun focused commands; expect pass without real provider credentials or spending. Commit `feat: add bounded history analysis and incremental catch-up`.

## Task U5 — Publish cited area stories and honest progress

**Create:** `lib/history/area-story.ts`, `lib/history/progress.ts`, `lib/history/story-store.ts`, `app/api/history/areas/[areaId]/route.ts`, `tests/area-story.test.ts`, `tests/area-progress.test.ts`. **Integrator registers:** read route ownership, export adapters and additive `AreaProgress` contract; Chapter 5 owns UI.

- [ ] Write fixtures proving separate Finished, Still open and Next output across four chats, a retained cancelled/superseded history, no fact without a verified citation, stale source gaps, task edits after snapshot generation and an undefined roadmap denominator.
- [ ] Run `node --experimental-strip-types --test tests/area-story.test.ts tests/area-progress.test.ts`; expect failure before implementation.
- [ ] Produce Chapter 1 `AreaStory` exactly: `finished` distinguishes observed/inferred/accepted; `open` references persistent work-item IDs; `next` has a real task ID only when a task exists. Preserve cancelled/superseded context in detail/history without treating it as finished output. Accepted entries resolve explicit owner acceptance provenance; no extraction output can claim that basis.
- [ ] Resolve `AreaStory.finished[].acceptanceRef` against F6 or the existing equivalent owner audit/acceptance record. Non-accepted entries use null and require verified citations or claimIds resolving supported immutable snapshots. Populate claimIds for inferred/observed facts so the UI can inspect repository evidence as well as chat passages. Read roadmap scope/assessment state from F6; do not create a second checkpoint store inside the projection.
- [ ] Publish immutable snapshots keyed by planning revision, exact source watermark, association/extractor versions and input digest. Persist the selected head under operational CAS. Changed inputs mark earlier snapshots stale and schedule recomputation; an area read cannot silently serve stale as current. A stale candidate rejected by CAS leaves the previous valid head intact.
- [ ] Expose `AreaProgress` counts with coverage and provenance. Distinguish observed finished from owner accepted; show checkpoint counts only for their named scope/revision. Empty/unagreed scope displays `Scope not set`; mixed checkpoint states stay mixed. A single advanced task cannot establish the area's stage. An optional area aggregate requires the whole agreed mandatory checkpoint set to satisfy that stage's scope-specific evidence, with unresolved contradictions visible. Return null/unknown when completeness or denominator is absent, never an invented zero or percentage. Equal project priority remains unchanged. Chapter 5 owns its `AreaLaneSummary` UI adapter over this projection.
- [ ] Test owner-scoped pagination/detail resolution, old immutable citations after revisions, owner override replay, source removal tombstones and recovery round trip. Register claims/items/events/snapshots/progress derivations with F5 export rules; never export credentials or active jobs.
- [ ] Run the focused command plus `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`; expect all passing. Commit `feat: publish cited area stories and observed progress`.

## Task U6 — Verify linked repository evidence without overstating it

**Create:** `lib/history/repository-evidence.ts`, `tests/history-repository-evidence.test.ts`. **Reuse:** `lib/connectors.ts` and the actual supported GitHub read interface; `lib/history/object-store.ts` for immutable supporting snapshots. Add required strict codecs/export records through the integrator.

Freeze this additive contract in S1 and store immutable rows in `history_repository_evidence`; owner scope is server-injected:

```ts
export interface RepositoryEvidenceSnapshot {
  id: string;
  repositoryIdentity: string;
  kind: 'commit' | 'pull_request' | 'check' | 'deployment';
  sourceUrl: string;
  nativeRecordId: string;
  candidate: string | null;
  environment: string | null;
  conclusion: string | null;
  observedAt: string;
  contentDigest: string;
  bodyObjectKey: string;
  availability: Availability;
}
```

`supportingEvidence[].digest` must match the snapshot contentDigest. A refreshed external record creates a new snapshot; it never replaces bytes behind an old reference. Link conflicts/supersession between snapshots and recompute affected projections. Include rows, private body objects and references in F5's manifest/restore validation; missing objects remain explicit unavailable evidence and cannot support promotion.

- [ ] Test a chat claiming tests passed on SHA A while the linked PR head is SHA B, an inaccessible check run, a merged PR without deployment evidence, and a local dirty working tree with an old HEAD. All must preserve their distinct scope and unknowns.
- [ ] Resolve explicit commit/PR/check/deployment references only through supported read access. Retain repository, immutable candidate SHA, check identity/conclusion, environment, source URL and observed time in an owner-scoped evidence snapshot. Paginate check results and record omitted/unavailable artifacts. Never run build commands taken from transcript text.
- [ ] A documented assistant claim stays reported/inferred until supporting evidence is available. A merged PR proves merge, a successful software check proves that check on its candidate, and neither proves physical testing or release acceptance. Local changes require their own candidate/snapshot identity; do not label them as the clean HEAD version.
- [ ] Refresh referenced evidence when relevant source/PR state changes and invalidate dependent stronger claims after conflict or revocation. Network/access failures retain the last known dated result with stale/unknown state; they do not invent failure or success.
- [ ] Run `node --experimental-strip-types --test tests/history-repository-evidence.test.ts`; expect the four scope-mismatch scenarios to stay qualified. Commit `feat: verify linked repository evidence at its actual scope`.

## Acceptance and live gates

- [ ] A synthetic cross-chat walkthrough proves initial request → partial implementation → later cancellation/supersession → resumed work → verification, with stable project/area IDs and persistent open loops. A rebuild and incremental catch-up agree at the same watermark.
- [ ] A reviewer verifies no silent task creation/completion, acceptance, commitments or priority changes; no branch/commit mismatch promoted to verification; and no citation invented by extraction.
- [ ] Record evidence under `docs/implementation/project-lanes-history/understanding-verification.md` and update `progress.json` with implemented, verified-local, unattended and hosted statuses separately.
- [ ] With authorized real retained sources, verify one continuing area across more than one chat/provider, then a resumed old conversation and later update. Keep private transcript content out of public test artifacts. Missing cloud/Windows access leaves those exact rows open; fixtures are implementation proof only.
- [ ] If runtime inference is enabled, verify one bounded authorized run with actual identity, citations and budget behavior. Otherwise record the provider gate and do not claim semantic live synthesis complete. No source chat is edited, resumed or messaged by this chapter.
