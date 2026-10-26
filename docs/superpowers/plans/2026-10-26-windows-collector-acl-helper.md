# Windows collector permission helper implementation plan

> **For agentic workers:** Use test-driven implementation and independent review. The owner approved this repair on 26 October 2026; continue through verification and the existing private release workflow if green.

**Goal:** Complete the existing 251-message Windows integration test within its unchanged 120-second deadline while preserving every private-path check.

**Architecture:** A collector run owns one lazy native Windows PowerShell child running a fixed script. Bounded JSON lines carry individual literal paths and matched replies. Check each path at the same point as today, without caching permission results. Async run-local context shares the checker across spool/checkpoint/credential operations; unrelated and concurrent runs remain isolated. Outside a run scope, a check gets a short-lived owned helper. Non-Windows behavior remains unchanged.

**Tech stack:** Existing dependency-free Node 24 collector, Windows PowerShell 5.1, native ACL checks, Node test runner.

## Approved requirements

- Keep current-user ownership, non-reparse paths, and rejection of allow rules for other identities. Preserve existing file identity, link, digest, and bounded-read checks.
- Isolate the child's module path to native Windows PowerShell modules. Preserve the previously verified Windows named-pipe namespace correction and synthetic fixture ACL setup.
- Execute a fixed script only. Requests contain data, never PowerShell code. Bound input/output, serialize requests with exact reply identity, and reject malformed, extra, oversized, failed, timed-out, or prematurely closed replies.
- Retain the existing five-second check deadline. Close/reap the child in a run's finally path, including cancellation, startup failure and early operation failure. Do not leave child processes or unbounded queues.
- Do not cache ACL decisions, relax permissions, raise integration deadlines, change Windows policy/system files, add dependencies, or read owner data in tests.
- Include new source files in the existing collector package allowlist. Preserve Site identity, access, bindings, owner records, rollback version 24 and verified recovery ZIP.

## Task 1: Helper and protocol

**Files:** new focused collector JavaScript/helper-script modules, existing native guard if needed, and focused synthetic/native helper tests.

- [ ] Add a failing test proving several path checks use one owned process, and that a permissions change between checks is detected.
- [ ] Add failure-path tests for reply identity/shape/size, EOF, child failure, timeout, cancellation, and cleanup; keep production limits finite.
- [ ] Implement the fixed-script protocol while reusing the existing ACL policy, with no command interpolation.
- [ ] Run focused helper tests and retain evidence of expected RED and final GREEN results.

## Task 2: Run lifetime and packaging

**Files:** `collector/src/cli.mjs`, `collector/src/spool.mjs`, `scripts/package-history-collector.mjs`, and existing integration tests.

- [ ] Bind helper lifetime to the complete awaited collector operation, including final status and all cleanup. Reuse nested scope without sharing authority between unrelated runs.
- [ ] Preserve one-off direct private-path checks for callers outside a run.
- [ ] Add the helper files to the closed package inventory and verify exact-source packaging after commit.
- [ ] Rerun `node --experimental-strip-types --test --test-timeout=120000 tests/history-collector-integration.test.ts` with its existing per-test deadlines unchanged. Stop on any unexpected real failure.

## Task 3: Review and release

- [ ] Independently review the protocol, policy equivalence, scope isolation and child cleanup.
- [ ] Run typecheck, lint, companion tests, focused briefing regressions and the supported Sites build on the final source.
- [ ] Scan source/history before every GitHub or Sites push; commit and push the reviewed repair to main without force.
- [ ] Use the existing supported private Sites workflow from the pushed source, preserve version 24 and the recovery ZIP, then install the verified package downloaded from the published Site.
- [ ] Verify the new companion process, PC online/both assistants ready, one requested Claude Code Trade Graph briefing, saved card counts and persistence after reload.

## Diagnosis supporting this plan

One-message first/repeat scans took 46.64/45.82 seconds and 44/46 PowerShell invocations. Four messages took 78.15 seconds and 77 invocations. Over 99% of each duration was child-process time. A single process executing 20 exact guard checks took 1.228 seconds; subsequent checks took 1.27–2.25 milliseconds. The approximately 86-minute projection for the large test was source-derived, not a completed longer test run.
