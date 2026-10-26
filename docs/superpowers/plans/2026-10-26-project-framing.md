# Project Framing Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for bounded implementation and review. The owner's attached implementation brief supplies the design and acceptance criteria.

**Goal:** Measure owner intentions against a short owner-written project framing, with task plans opt-in.

**Architecture:** Keep workspace revision admission and the private PC channel. Project framing is projected by the server, strictly validated at every existing boundary, and excluded from owner job lists. Version 3 briefings add fit-or-drift prose while version 1 and 2 reports remain readable through pure projections. Folder-to-project creation saves its mapping in the same atomic workspace command.

**Tech Stack:** Node 24, TypeScript/React, shared JavaScript contracts, existing workspace/D1 storage and PC companion.

## Foundation and compatibility

- [x] Fetch GitHub main (`bdd4ac97325d71e7daeebc8f798d81f2c192bdd0`), create and push `feat/project-framing` before implementation.
- [x] Read AGENTS.md and the three requested verification notes. Install with `npm run install:ci`, keeping package-lock.json.
- [x] Test then implement optional stored Project fields `framing`, `includeTaskPlanInBriefings`, and `personalRepositoryKey`, normalized to empty/false/null on read. Preserve framing verbatim; reject over 2500 characters and control characters. Preserve checksum/measurement compatibility by omitting generated defaults in compact storage.
- [ ] Verify workspace codec, export/restore, command, validation and measurement parity.

## Bounded workers

Explicit runtime model selection accepted `gpt-6.1-sol` for `/root/contract_design`, `/root/server_design`, and `/root/ui_design`. The integrator owns shared workspace types/validation, integration, documentation, commits, and release gates.

- [ ] Contract worker: `shared/project-briefing.*`, briefing prompt/run/evidence, contract and companion tests and synthetic fixtures. Implement strict ProjectFraming projection, V3 `fitOrDrift`, frozen V1/V2 validation and pure V3 projections. Framing is untrusted reference data, never intention evidence; empty framing cannot be invented.
- [ ] Server worker: personal state/store/connector and focused tests. Require server-projected framing for new jobs, reject client injection and project mismatches, hide payload, preserve legacy job reads without checksum mutation, terminate legacy active briefs before execution, respect durable folder associations.
- [ ] UI worker: project editor, dashboard/card, PC repository create-only flow and request recovery, plus render/model/flow tests. Save project and mapping together, offer briefing only as a separate explicit action, preserve ambiguous-save protection.

## Verification and delivery

- [ ] Run `npm run test:companion`, `npm run typecheck`, `npm run lint`, `npm run build`, and focused briefing/workspace/render tests on Windows Node 24.
- [ ] Independently review specification compliance, then code quality; repair findings and rerun affected checks.
- [ ] Update README and `docs/superpowers/verification/2026-10-26-project-framing.md` with exact evidence and limitations.
- [ ] Commit reviewable changes, push and open a pull request against main. Observe Linux checks; the full suite remains Linux-gated.
- [ ] Stop for the owner's merge. After merged main is verified, follow the existing private Sites release process, retain version 25/recovery ZIP, update from published companion ZIP, and verify PC and both assistants ready. Do not request any project briefing.
