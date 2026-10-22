# Personal Repository Connection Implementation Plan

> **For agentic workers:** Use subagent-driven development with explicit GPT-6.1 Sol workers. Independent workers own backend channel, desktop adapter and Claude adapter. The integrator owns contracts, central registration, UI, deployment and acceptance.

**Goal:** Browse a folder, choose Codex or Claude Code, analyze and save, with a durable personal PC connection and simple refresh controls.

**Architecture:** A narrow owner-scoped outbound queue and DPAPI-protected local connector bridge the existing private Site and installed subscriptions. Results return to the owner's normal evidence save command; no automatic execution retry or task acceptance.

**Tech Stack:** Existing Node 24, PowerShell 7, React, Cloudflare D1, shared JSON validators and installed provider CLIs. No new inference API or public audience.

## Foundation and implementation

- [x] Preserve the unrelated dirty checkout; open native Sites source in a clean checkout and retain owner-private identity. Record current workspace/source fingerprints privately.
- [x] Backend worker adds strict shared queue contract, additive migration, owner/device HTTP/store handlers, export/reference adapters and synthetic authorization/replay/cancel/restore tests.
- [x] Provider worker adds Claude subscription readiness, fixed no-tool CLI arguments, finite process ownership and validated structured-output parsing with synthetic tests.
- [x] Desktop worker adds explicit native folder picker, DPAPI configuration, outbound durable delivery/claim handling, startup/URI launcher and synthetic lifecycle tests.
- [x] Integrator adds backward-compatible provider/source provenance, a shared analysis runner, readiness caching and companion CLI/package wiring. Retain exact Codex model and concise-user selection.
- [x] Integrator registers the new owner module in schema/export/reference/capacity registries and migration journal. Preserve all existing records and disabled execution boundaries.
- [x] Replace routine pairing UI with PC/provider readiness, Choose folder, project/provider selection, Analyze, progress/recovery and repository refresh cards. Simplify primary navigation; retain advanced surfaces under More.

## Verification and release

- [x] Run targeted provider/connector/picker/contract/store/export/client tests, typecheck, lint and supported Sites build/package. Independent review checks approved scope and code/data boundaries.
- [x] Provision only the selected owner's personal endpoint and this PC using existing supported Sites service access plus a separate scoped key; retain secrets in private runtime configuration and DPAPI only.
- [x] Install and start the reviewed background app and per-user startup entry, preserving current registered repositories and saved reports.
- [x] Publish the existing private Site, verify readiness and automatic report saving/refresh in the owner UI, and compare source/planning/old immutable records before and after.
- [x] Push reviewable public source to a draft PR without merging; save exact release/verification limitations and a useful screenshot privately.

Release evidence and remaining physical-device/full-suite limits are recorded in [the verification note](../verification/2026-10-21-personal-repository-connection.md). These completed incremental checks do not waive the separate whole-product release gates.
