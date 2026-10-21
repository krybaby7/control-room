# Recent Project Chat Context Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development. The integrator owns shared contracts, input wiring, packaging and release; GPT-6.1 Sol workers own bounded collector and UI tasks.

**Goal:** Include a small verified recent Codex/Claude project conversation in the existing onboarding call by default.

**Architecture:** A dependency-free local collector reads bounded metadata and selected transcript tails. It returns untrusted text in memory plus helper-generated coverage/digests. The existing Codex request receives this text alongside current source excerpts; immutable hosted evidence stores provenance but no transcripts.

**Tech Stack:** Node 24 standard library and read-only node:sqlite, existing Codex CLI, shared JSON validators and React UI; no migration or new dependency.

## Task 1 — Contract and collector

- [x] Extend shared report validation with optional strict `chatContext` while preserving legacy bytes. Add malformed/oversize/provenance tests before implementing the extension.
- [x] Implement `collectProjectChats(root, {signal, snapshotSha256})` in focused `companion/chat-context.mjs` and provider readers. Return `{context, provenance}`. Policy: at most one main conversation/provider, six user/final-assistant messages/provider, 2,000 characters/provider, 4,000 total, bounded byte/tail/discovery limits.
- [x] Use synthetic Codex SQLite/rollout and Claude JSONL fixtures to test exact cwd matching, verified remote+known-commit moved identity, safe newest selection, no unrelated data, secret/tool/reasoning exclusions, link/change refusal, partial tails, missing formats and cancellation. Run `node --test tests/local-chat-context.test.mjs` and confirm failure before production implementation.

## Task 2 — Single-call integration and coverage

- [x] After the source snapshot, collect recent project chat context under the same run deadline; cancellation remains effective. Pass `{context, provenance}` to the existing analyzer without adding an inference call or resuming a previous session.
- [x] Add historical context to the bounded model prompt, preserve existing source citation validation, instruct current-source precedence, append trusted provenance only after validating model output. Test actual fake-provider input and generated report metadata.
- [x] Add the collector's reviewed files to `COMPANION_SOURCE_PATHS`, update deterministic ZIP tests and documentation. Keep raw chats and owner paths outside Git.

## Task 3 — Display and compatibility

- [x] Explain default bounded chat inclusion in helper local page and hosted setup. Saved reports show included source/date/count and unavailable sources/cloud; old reports explicitly have no recorded chat coverage.
- [x] Run contract/helper/package/client/storage tests, typecheck, lint and supported build. Independent workers review relevance, privacy, bounds and v1 compatibility.

## Task 4 — Installed acceptance and release

- [x] Retain the current private revision6 export and source fingerprints; source/package with native Sites identity and owner-only audience unchanged.
- [x] Install the reviewed helper version, inspect real collector coverage without printing text, perform one real refresh for the selected repository, then owner-import it as a new immutable report version. Verify readback and unchanged code/planning.
- [x] Synchronize exact source bytes to the public audit clone, push the existing draft PR without merging, publish the existing Site, and record current verification/remaining cloud boundary in private evidence and progress/gap checkpoints.

Installed acceptance used the same finite inference call with a bounded matching local Codex excerpt. Owner import saved evidence version 2, preserved the original version exactly, and survived reload. Planning, all old module records, source snapshot, Git status and tracked diff were unchanged. No matching local Claude conversation was found; cloud histories remain disconnected. Full-account history coverage and unrelated canonical release gates are not claimed.
