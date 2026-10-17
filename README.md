# Control Room

A private planning home for TAMENNI and Trade Graph, built for PC, phone and tablet. Both products have equal priority. The online plan continues to work while the PC is off.

## What works in the first release

- Today: equally visible projects, explained next-action suggestions, weekly focus and review items.
- Projects: editable goals, milestone acceptance criteria, task planning, dates, priority, Now/Next/Later, dependency links and explicit blockers.
- Capture: save an idea, proposed task or decision with an optional source. Convert a capture into a task once, preserving its text and source.
- Reversible archive, owner-recorded completion, dated activity and JSON export.
- Online D1 persistence scoped to the signed-in user; optimistic revision checks protect edits made from different devices.

The starting content is editable. User goals are confirmed; task suggestions and acceptance wording are proposed. Source links refer to the inspection on **17 October 2026**. They are not a live GitHub or runtime feed. No deadlines, weekly commitments or completion claims are invented.

## Current integration boundary

Automated GitHub/document synchronization and the PC collector are not connected in this release. Existing sources are remote links and saved excerpts. Agent coordination and trading operations are separate later work. No trading service, credentials, paid model calls or live orders are controlled by this application.

## Local development

Node 22.13+ and npm are required (Node 24 is used for the built-in SQLite tests). Install with `npm ci` after cloning. PowerShell users can invoke `npm.cmd` if execution policy blocks `npm.ps1`.

```text
npm run db:generate
npm run build
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_old_peter_parker.sql
npm run dev
```

Apply each migration once. Production migrations are applied by Sites during publication. Preview and production databases are separate.

The portable starter defaults to port 5173. Use its printed URL. Loopback development simulates sign-in at `/signin-with-chatgpt?return_to=/`; hosted sign-in and private access are provided by Sites. The mock identity is not included in production builds. Never add authentication headers or tokens to browser code.

```text
npm test
npm run typecheck
npm run build
```

## Source map

`lib/types.ts` defines the domain contract. `lib/planning.ts` applies validated commands and computes recommendations. `lib/seed.ts` contains editable initial content. `lib/workspace-store.ts` stores owner-scoped documents using compare-and-swap updates. `app/api/workspace/route.ts` authorizes and validates requests. `components/` contains focused views and editors. `db/schema.ts` and `drizzle/` own schema migrations.

The private Site identity is tracked in `.openai/hosting.json`. Source publication uses the installed Sites workflow with temporary credentials supplied only through stdin. Runtime data, preview state, credentials, logs, screenshots and build artifacts remain ignored.

## Data behavior

The first visit initializes a workspace once. Changing seed code never resets an existing plan. A stale save receives HTTP 409; the interface refreshes the latest state while retaining the editor draft for review and retry. Network or storage failures show an error and do not claim the change was saved. Reload or refresh on another device loads the latest saved revision.

Dependencies must be within one project and acyclic. Blocked tasks cannot be completed, and reopening a predecessor cannot invalidate an already-completed dependent. Achieved milestones require acceptance evidence. Completion is an owner-recorded fact, not automatic verification of release readiness or profitability.

Use Sources → Export to download a portable JSON snapshot. Export is a user backup, not an automated restore or disaster-recovery service. The personal workspace currently bounds tasks, captures, milestones and saved text; it is intended for this small project portfolio.

The approved scope and implementation checklist are under `docs/superpowers/`.
