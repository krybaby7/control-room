# Concise User Chat Selection Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development. GPT-6.1 Sol implementers own isolated selection files; the integrator owns shared contracts, UI, packaging and publication.

**Goal:** Prefer concise user intent over long pasted-looking prompts and assistant replies before the existing one model call.

**Architecture:** A pure deterministic selector consumes already sanitized message candidates from the existing bounded collectors. Optional trusted report metadata identifies the new selection policy, while old report serialization is unchanged.

**Tech Stack:** Node 24 standard library, existing JSON validators and React UI; no dependency or database migration.

## Task 1: Selection (worker)

- [x] Add synthetic tests through `sanitizeChatSource` that fail under the current policy: standalone user input excludes long answers; long templates defer behind concise intent; context-dependent short responses retain preceding safe answer; latest long-user fallback keeps its beginning/end; no user input defers assistant-only history; complete user messages retain chronology and budget; filtering precedes selection.
- [x] Run `node --test tests/local-chat-selection.test.mjs` and retain expected red assertions before implementation.
- [x] Implement pure `selectChatMessages` in `companion/chat-selection.mjs`, integrate after whole-message sanitization in `companion/chat-context.mjs`, and add optional `selection: concise-user-first-v1` provenance. Preserve all existing source matching and history-reading limits. Update only obsolete prior-policy assertions in `tests/local-chat-context.test.mjs`.
- [x] Run both chat-selection and collector tests, review counts and digests, and freeze worker files for independent review.

## Task 2: Contract, copy and package (integrator)

- [x] Add failing contract tests for optional selection provenance, deferred status, malformed flags and unchanged legacy reports. Extend `shared/local-analysis.mjs` and `.d.mts` with only known optional selection and deferred status.
- [x] Update prompt instructions, helper setup copy, hosted new-report coverage and companion README. Describe length/format as a heuristic; preserve legacy report labels.
- [x] Add the pure selector module to the explicit companion archive allowlist and include new tests in `test:companion`. Verify package and helper integration still perform only one inference call.
- [x] Run companion, storage/client, typecheck, lint and supported build checks. Two independent review passes cover approved intent and code quality/security boundaries.

## Task 3: Installed acceptance and release (integrator)

- [ ] Retain a fresh private revision7 bundle and source fingerprints. Package the exact reviewed source through native Sites tooling with existing project identity and owner-only audience.
- [ ] Install the exact reviewed helper payload, update the stable launcher, and perform one finite refresh for the registered repository. Inspect aggregate coverage only and owner-import as the next immutable report version.
- [ ] Reload and verify new selection coverage; export revision8 and compare unchanged planning, all old immutable versions and all old module rows. Compare selected repository fingerprints/status/diff.
- [ ] Push exact source bytes to the existing public draft PR, retain CI results without claiming unrelated broad-suite success, publish existing private Site, and save private completion evidence plus screenshot.
