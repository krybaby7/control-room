# Simple folders implementation plan

**Goal:** Make project folder ownership and PC folder actions understandable without technical knowledge.

**Scope:** Execute the owner's detailed task on `feat/simple-folders`, starting at `23e9ed3`. Work stays in this checkout. No push, merge, deployment, companion changes, migrations or briefing/personal-channel contract changes.

**Architecture:** Keep ownership changes on the existing `project.edit` command and keep briefing framing and folder-list projection on the server. Share a small pure disabled-reason helper. Preserve request recovery and bounded, abortable reads. Projects and Repositories remain deferred; the project folder component loads the dashboard feed dynamically.

- [x] Read repository instructions, provenance and the requested verification records; inspect existing command, request and recovery contracts. Node is 24.14.1; the branch is clean at the starting head.
- [x] Establish and unit-test shared disabled reasons before dependent UI uses them.
- [x] Integrator: implement project folder removal, existing-folder selection, browse/recovery/difference handling, minimal briefing requests and Today navigation/reasons. Keep central wiring under one owner.
- [x] Leaf worker: simplify Repositories, default to This PC, move technical analysis and recovery into a closed fold, and defer saved-report loading until it opens.
- [x] Browser-test worker: retain framing, ownership, archived guidance, lost-response and reload protections, and cover the add/remove/reassign flow and visible offline reasons.
- [x] Review integrated changes for specification compliance and code quality with explicitly selected GPT-6.1 Sol workers. Correct findings and run affected checks.
- [x] Record exact check results and limitations in `docs/superpowers/verification/2026-10-27-simple-folders.md`; update the progress checkpoint and gap ledger. Commit attempts were blocked by the backing Git-index permission boundary; leave commits and PR creation to the integrator.

## Worker configuration

The supported runtime accepted explicit `model: gpt-6.1-sol` selections and returned `/root/folders_integrator`, `/root/repositories_ui` and `/root/owner_flow_tests`. These are bounded workers with separate production/test file ownership. The root coordinator handles repository checks and documentation. Separate resolved-model telemetry is not exposed or required.

## Evidence boundaries

All test state must be synthetic. No owner briefing, external inference or production data mutation is used for verification. The current session supplies original owner text without original message timestamps, so no verbatim handoff turn can be recorded without inventing a timestamp. That missing evidence will be disclosed in verification notes.

Initial environment checks: `npm run install:ci` fails with `spawn EPERM` in the installer child process; `npm run build` fails with the same restriction while Vite resolves its configuration; the default Node test runner cannot spawn its file workers. Initial `npm run typecheck` passes against the existing dependency tree. These are preliminary environment observations, not final implementation verification.
