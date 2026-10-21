# GitHub Cloud Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Add a subscription-only GitHub/Codex Cloud handoff and validated report import alongside existing PC analysis.

**Architecture:** Separate cloud provenance from the existing local report contract. Reuse report content and owner evidence transactions; atomically register a project/repository with its imported report. The cloud job is manually launched in Codex Cloud and manually returned, so no hosted inference credentials or billing are needed.

**Tech Stack:** Existing React/TypeScript/Vinext, dependency-free shared JavaScript, Zod, owner-scoped D1 evidence transactions and Node 24 tests.

## Approved scope and worker selection

Owner selected the subscription-only handoff and both execution choices. Existing Site ID and private audience are preserved. Source baseline is `2e49a1b5f67d8279fc0758afb5c9601fad57dba7`; implementation branch is `feature/github-cloud-onboarding`. Exact `gpt-6.1-sol` was explicitly selected successfully for workers `/root/cloud_contract`, `/root/cloud_persistence` and `/root/cloud_ui`. No worker inferred its model identity. Integration and independent review remain separate responsibilities.

### Task 1: Shared handoff/report contract

Files: `shared/github-analysis.mjs`, `shared/github-analysis.d.mts`, `tests/github-analysis-contract.test.mjs`.

- [x] Write failing behavioral tests for URL normalization, strict cloud envelope, UTF-8/size bounds, manifest and citation identity.
- [x] Implement the agreed API:

```ts
parseGithubRepository(input: string): {fullName: string; url: string};
validateGithubAnalysis(value: unknown): GithubAnalysisReport;
parseImportedGithubReport(bytes: Uint8Array): GithubAnalysisReport;
buildGithubCloudHandoff(input: {repository: string; requestId: string; createdAt: string}): {
  requestId: string; repository: {fullName: string; url: string}; prompt: string;
};
```

- [x] Generate a practical read-only prompt containing the exact schema, request identity, pinned commit requirements and downloadable artifact instructions.
- [x] Run `node --test tests/github-analysis-contract.test.mjs` red then green. Preserve local contract behavior.

### Task 2: Atomic owner persistence

Files: `lib/github-analysis-handler.ts`, `lib/github-analysis-store.ts`, `app/api/github-analysis/route.ts`, minimal registration in `lib/workspace-handlers.ts`, `tests/github-analysis.test.ts`.

- [x] Write SQLite tests for real transaction outcomes before implementation.
- [x] Register `github-analysis.save`. Accept either an existing `projectId` or a new `projectName`, a validated report and optional refresh evidence identity/version.
- [x] Canonically match active repository identities. Build project creation/repository linking and immutable evidence writes in one mutation plan. Preserve existing project data. Reject foreign/archived/conflicting identities before commit.
- [x] Store marker `control-room-github-analysis-v1`, full source SHA and explicit imported/unverified cloud provenance.
- [x] Expose bounded authenticated GET `/api/github-analysis?projectId=...` with private/no-store responses.
- [x] Run `node --experimental-strip-types --test tests/github-analysis.test.ts` and confirm failure rollback, replay, export and refresh behavior.

### Task 3: Two-mode owner UI

Files: `components/repository-onboarding.tsx`, `components/github-repository-onboarding.tsx`, `lib/github-analysis-client.ts`, `tests/github-analysis-client.test.ts`, minimal deferred import/render integration in `components/control-center.tsx`.

- [x] Test bounded client loading, cancellation and auth/timeout/error classifications.
- [x] Reuse the existing local props and callback contracts; retain the `local-analysis` route. Offer Cloud/PC choices with dirty/busy mode-change guards.
- [x] Prepare copyable/downloadable prompt from a canonical repository URL; link to the ordinary Codex Cloud page. Describe GitHub connection and task launch there accurately.
- [x] Import/preview the report with request/repository matching where a prepared request exists. Retain reports across failed saves. Submit one atomic cloud command after review.
- [x] Recover duplicate/imported saved outcomes without rerunning inference or creating another project. Expose safe pinned source citations and explicitly reviewed task suggestions.
- [x] Read saved reports after reload; preserve separate session/load failure states and local helper behavior.

### Task 4: Integrate, review, verify and publish

- [x] Run focused cloud tests and existing local companion/storage regressions.
- [x] Run typecheck/lint/build and the repository Node suite on coherent source. Run relevant isolated browser journeys, adding failure regressions only for observed concerns.
- [x] Have an explicitly selected `gpt-6.1-sol` reviewer inspect spec compliance and code quality. Resolve material findings and rerun affected checks.
- [x] Update the progress checkpoint/gap ledger with exact evidence and the remaining real cloud task boundary. Commit reviewable source; create/attach a draft public-source PR when write access is available.
- [ ] Execute the private publication operation after this frozen source checkpoint. Retain the terminal deployment receipt separately and check hosted UI without altering owner project data or claiming unobserved cloud execution.

## Verification evidence

Record actual commands/results in the feature verification document. Synthetic report fixtures establish import/storage behavior; they do not establish a real Codex Cloud model run. No API provider or paid inference is activated by this feature.

Verification: [source checks and exact limits](../verification/2026-10-21-github-cloud-onboarding.md). The bounded full suite has seven remaining unchanged Windows platform failures after environment corrections; no full-green claim.
