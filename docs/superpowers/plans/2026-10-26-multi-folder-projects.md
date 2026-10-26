# Multi-folder projects implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development for bounded implementation and independent review. The owner's attached brief supplies the approved design and release gate.

**Goal:** One project owns up to four PC repository folders and receives one framing-based briefing across them.

**Architecture:** Normalize older singular workspace associations into bounded lists. Admit one immutable project job containing server-projected folders and framing. Collect each folder with existing bounded readers, merge and trim globally, and save one project ledger. Project report version 4 adds explicit identities, coverage and optional folder attribution while frozen older schemas project purely on read.

**Tech stack:** Node 24, TypeScript, React, existing SQLite/D1 transaction boundaries and read-only Node companion. Preserve dependencies, hosting identity and private owner data.

## Foundation (integrator)

- [x] Fetch main at `f43db3a`; create and push `feat/multi-folder-projects` before implementation in an isolated checkout.
- [x] Install with `npm run install:ci` on Node 24.
- [x] Write and observe failing workspace-list and v4 projection/reference tests.
- [x] Normalize legacy `personalRepositoryKey` into `personalRepositoryKeys`, reject duplicates and more than four folders, preserve native export/restore and exact compact measurement parity.
- [x] Freeze v3 schemas, add v4 identities and per-folder coverage, preserve v1/v2/v3 reads and bounded previous ledgers.

## Server and persistence (server_projects worker)

- [x] Add failing admission tests: folder list and framing are server projections; another project's folder cannot be admitted.
- [x] Update shared personal state/jobs/policies with project folder lists; bind returned coverage to admitted identities; preserve legacy completed jobs and acknowledgment digests.
- [x] Keep policy and automatic due checks per project. Retain revision fencing.
- [x] Save one active briefing per project, refreshing historical folder-specific evidence safely and accepting its previous ledger.

## Companion (evidence_research worker)

- [x] Add synthetic two-folder coverage, global ordering/trimming and combined-fingerprint tests.
- [x] Keep per-folder read limits. Merge named sections and owner sessions before global newest/since-previous selection; discard oldest retained material across folders.
- [x] Validate all registered roots before one model call. Bind backup retries to immutable folder list/framing; carry latest ledger per project with historical fallback.
- [x] Explain whole-project framing, cross-folder map and spanning intentions in the prompt.

## Screens (folder_ui worker and integrator)

- [x] Replace single-folder chooser with project folder list and add action; allow linking an unowned registered folder to an existing project.
- [x] Put optional framing first in both creation dialogs.
- [x] Show area folder tags, per-folder coverage and named changed-folder notice.
- [x] Connect central project workflow callbacks; preserve retained command and request recovery.

## Verification and delivery (integrator and independent workers)

- [x] Run `npm run test:companion`, focused briefing/workspace/dashboard tests, typecheck, lint and build; inspect a synthetic browser flow.
- [x] Independently review requirements then code correctness, fix findings and rerun affected checks.
- [x] Update README, verification record, current checkpoint and gap ledger. Commit and push reviewable changes; create and attach PR against main.
- [ ] Inspect full Linux PR gates. If the controlled benchmark alone fails by a few milliseconds without save-path changes, rerun once and disclose it; keep its budget unchanged.
- [ ] Tell the owner when green and wait for their merge. Deployment uses merged main, preserves previous version/recovery ZIP, updates/reinstalls companion and verifies online/both assistants ready. No project briefing is authorized.

## Coordination evidence

Explicit runtime `model: gpt-6.1-sol` selection was accepted for `/root/evidence_research`, `/root/server_projects` and `/root/folder_ui`. Workers have non-overlapping files; integrator owns workspace foundation, report contract and central UI wiring. Synthetic tests do not contact inference providers or modify owner state.
