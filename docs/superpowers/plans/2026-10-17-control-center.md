# Project Control Center Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development to implement the bounded tasks below. The owner approved execution; routine implementation choices and private publication are authorized.

**Goal:** Deliver a private mobile-ready planner for TAMENNI and Trade Graph with durable multi-device data.

**Architecture:** React client UI calls authenticated JSON command handlers. A pure domain module validates commands and dependencies; D1 persists an owner-scoped document with a revision check. Hosted authentication and private access use the Sites platform.

**Tech Stack:** Vinext, React, TypeScript, Cloudflare D1, Drizzle migrations, Node test runner, browser QA.

## Task 1 — Domain contract and behavior

Files: `lib/types.ts`, `lib/planning.ts`, `lib/seed.ts`, `tests/planning.test.ts`.

- [x] Define typed projects, milestones, tasks, captures, dated activity and commands.
- [x] Write behavioral tests before runtime implementation: cyclic dependencies, invalid cross-project milestone, blocked completion, capture conversion idempotency, archived dependency behavior, fair ranking across unequal task counts, invalid dates, unsafe URLs and evidence requirements.
- [x] Run `node --experimental-strip-types --test tests/planning.test.ts` to observe the missing behaviors, implement and rerun to passing.
- [x] Seed only confirmed goals and explicitly proposed tasks; date source evidence 2026-10-17 and use remote GitHub URLs.

## Task 2 — Authenticated persistence

Files: `db/schema.ts`, `lib/workspace-store.ts`, `app/api/workspace/route.ts`, `drizzle/`, `.openai/hosting.json`.

- [x] Define workspace table with `user_id` primary key, JSON `content`, integer `revision` and `updated_at`.
- [x] GET initializes a new user's seed once and returns `{workspace,revision,updatedAt}`. Never overwrite an existing workspace during initialization.
- [x] POST accepts `{revision,command}` and rejects missing identity, cross-origin writes, invalid JSON and oversized payloads. Apply the pure command then atomically update where both owner and revision match; return HTTP 409 for stale edits.
- [x] Generate a schema-only migration with `npm run db:generate`; enable only the `DB` binding.
- [x] Verify separate users, persistence after reload and stale-write rejection against local D1.

## Task 3 — Responsive planning interface

Files: `app/page.tsx`, `app/layout.tsx`, `app/globals.css`, `components/control-center.tsx`, supporting focused component files, `public/favicon.svg`.

- [x] Implement Today, Projects, Capture/Inbox and Sources navigation with desktop sidebar and phone navigation.
- [x] Today has two equally weighted project cards, an explained action list, weekly focus and owner review items. Empty states invite a real next action.
- [x] Projects has editable goals, milestone acceptance and a filtered task board; all tasks open a full edit sheet with dates, horizon, priority, blockers, dependencies, evidence and source.
- [x] Support creating/editing milestones and tasks, changing status and weekly focus, archiving/restoring, capture conversion and JSON export.
- [x] Save through the server; preserve failed/conflicting form drafts and provide retry. Refresh on focus and through a manual control.
- [x] Make source freshness explicit; integration cards say not connected.

## Task 4 — Review, browser QA and publish

Files: `README.md`, `docs/verification.md`, relevant repaired sources and deployment archive in ignored `outputs/`.

- [x] Run meaningful domain tests and `tsc --noEmit`, then the Sites build helper.
- [x] Apply migration to local preview; sign in using the starter loopback-only mock identity.
- [x] Verify real CRUD, dependency blocking, capture conversion, persistence, two-tab conflict, unauthorized API behavior, export and narrow-screen overflow.
- [x] Obtain independent spec and quality reviews and resolve actionable findings.
Publication follows this verified source state: package with the Sites source helper, keep credentials in memory/stdin only, and privately deploy its exact pushed commit and archive.
The native Sites saved-version and deployment records are authoritative for publication completion; handoff requires a successful result and its returned URL.
