# Cloud chat intentions implementation plan

> For agentic workers: use subagent-driven development, test the missing behaviour first, and verify the final changes. The owner's task is the approved specification.

**Goal:** Bring bounded cloud owner turns into project briefings with honest provenance and visible coverage.

**Architecture:** No complete documented cloud transcript route was found in installed Claude Code 2.1.302 or Codex CLI 0.125.0. Read Markdown handoffs from the checkout and fetched origin branches without executing repository code. Feed these through the existing owner-turn filtering and selection. Add optional provider and coverage fields so existing version 2 and version 1 reports still validate.

**Tech stack:** Node 24, Git plumbing, existing companion modules, TypeScript dashboard and node:test.

## Tasks

- [x] Reader and convention: add `companion/cloud-owner-turns.mjs`, synthetic reader tests, `docs/operations/cloud-owner-turns.md`, and the AGENTS.md handoff instruction. Verify local checkout, fetched cloud-only branch, credential filtering, forbidden paths/links, deduplication, cancellation, newest-first limits and malformed files.
- [x] Evidence and prompt: add explicit cloud file/session bounds; preserve provider, title and `origin: repository-handoff`; select with local turns; count retained cloud sessions and turns per provider after trimming. Test previous-horizon ordering, bundle/prompt budgets and a cloud-only intention entering the prompt. Package the new reader.
- [x] Contract and card: add optional `cloudProvider` to intentions and optional `cloudTurns` evidence coverage with provider/status/sessions/turns. Keep old reports unchanged and reject invalid coverage/provenance. Show assistant names and explicit absence of cloud turns. Test contract, dashboard and rendered card.
- [x] Run `npm run test:companion`, `npm run typecheck`, `npm run lint`, `npm run build`, and briefing app tests. Review the diff for privacy and correctness; retain package-lock.json unchanged.
- [x] Prepare Trade Graph handoffs from the pinned original source, obtain the owner's yes for the corrected exact 24 files, and commit/push them on its existing non-main branch. Install the verified published companion and run one real subscription-backed Claude Code briefing. The saved card shows cloud intentions and explicit retained cloud counts after reload. Announced each operation touching Trade Graph; no evidence was fabricated.
- [x] Record verified and unverified results in `docs/superpowers/verification/2026-10-25-cloud-chat-intentions.md`; commit, push and create/attach a draft PR against `claude/wizardly-hawking-4ez6q8`. Do not merge. The owner subsequently authorized deployment to the existing private Site from pushed source, followed by companion installation and one real Claude Code briefing.

## Worker configuration

Explicit model selection `gpt-6.1-sol` was accepted for `/root/cloud_route_audit`. Implementation/review workers use the same supported explicit model parameter; their IDs and outcomes will be recorded in verification.

## Current checkpoint

Draft PR #7 remains open against the requested base. The owner approved the corrected files, and all 24 exact blobs are committed and pushed on Trade Graph's existing non-main branch as `c9d3bcaec3b3879495b5dae4dba6784d0fa42d93`. No owner message was removed: 146 source headings reconcile to 129 owner entries, 14 retained internal headings and three excluded assistant replies. Only two session-specific coverage sections exist. The byte-exact source is retained, and unrelated work is preserved.

Companion 144/144, briefing app 50/50, typecheck and lint (0 errors, 17 existing warnings) pass; independent extension review 25/25 passes. The fresh Sites helper build from pushed commit `112c0b71fb083d3addd5c09f448e6b51a4f0c043` passed and was deployed successfully as private Site version 24. Version 23 and the recovery ZIP remain retained. The published workspace loads with the existing companion online and both assistants ready.

The owner resolved the blocked browser download by downloading the published ZIP normally. Its SHA-256, all 32 entries and whole deterministic archive matched the approved source. Installed the new versioned companion with all nine existing private state files unchanged, retained the old release/backups, and verified the new process plus PC online/both assistants ready. One real Claude Code briefing completed and delivered: eight cloud-sourced intentions; the saved card and evidence fold survived reload and state 89 owner turns across 17 Claude Code cloud sessions. Codex cloud coverage is explicitly unavailable. No trading code was run, no paid API inference was enabled, and no merge occurred. Complete acceptance evidence is in the verification note; the deployed source remains `112c0b7` while later commits only document outcomes.
