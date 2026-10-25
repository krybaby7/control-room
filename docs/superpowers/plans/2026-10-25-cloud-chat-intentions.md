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
- [ ] Prepare the first Trade Graph handoff from original messages only. Announce every command touching that repository and obtain the owner's yes for the exact file before committing there. Run one real subscription-backed briefing with the new companion and inspect the card for a cloud intention. Stop if original messages or required approval are unavailable; do not fabricate evidence.
- [ ] Record verified and unverified results in `docs/superpowers/verification/2026-10-25-cloud-chat-intentions.md`; commit, push and create/attach a draft PR against `claude/wizardly-hawking-4ez6q8`. Do not merge. The owner subsequently authorized deployment to the existing private Site from pushed source, followed by companion installation and one real Claude Code briefing.

## Worker configuration

Explicit model selection `gpt-6.1-sol` was accepted for `/root/cloud_route_audit`. Implementation/review workers use the same supported explicit model parameter; their IDs and outcomes will be recorded in verification.

## Current checkpoint

Repository-only author identity is configured exactly as the owner supplied. Source is committed in two reviewable changes, ending at `5111d4a403a2e92d7273b10979be33b90188eac9`; verification/checkpoint commit, push and draft PR follow. Synthetic checks remain companion133/133, briefing app50/50, typecheck, lint(0 errors,17 existing warnings), build; fresh reader12/12 and prompt/runner6/6 also pass. The owner identifies a23-session original export, but no accessible attachment/file was delivered; its local path was requested. Trade Graph file conversion, list/example review and explicit yes remain required before committing/pushing handoffs. No command has touched Trade Graph; no publication or companion replacement has occurred.
