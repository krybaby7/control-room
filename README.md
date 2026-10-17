# Control Room

A private planning home for TAMENNI and Trade Graph, built for PC, phone and tablet. Both products have equal priority. The online plan continues to work while the PC is off.

## What works in the first release

- Today: equally visible projects, explained next-action suggestions, weekly focus and review items.
- Projects: editable goals, milestone acceptance criteria, task planning, dates, priority, Now/Next/Later, dependency links and explicit blockers.
- Capture: save an idea, proposed task or decision with an optional source. Convert a capture into a task once, preserving its text and source.
- Reversible archive with completion history, Cairo calendar-week commitments, dated activity and JSON export/validated restore.
- Online D1 persistence scoped to the signed-in user; revision checks protect cross-device edits and durable mutation receipts make unchanged retries safe.
- Dated project baselines with source evidence and an additive application of five proposed tasks plus one saved context per project.

The starting content is editable. User goals are confirmed; task suggestions and acceptance wording are proposed. Source links refer to the inspection on **17 October 2026**. They are not a live GitHub or runtime feed. No deadlines, weekly commitments or completion claims are invented.

## Current integration boundary

Automated GitHub/document synchronization and the PC collector are not connected in this release. Existing sources are remote links and saved excerpts. Agent coordination and trading operations are separate later work. No trading service, credentials, paid model calls or live orders are controlled by this application.

## Local development

Node 22.13+ and npm are required (Node 24 is used for the built-in SQLite tests). Install with `npm ci` after cloning. PowerShell users can invoke `npm.cmd` if execution policy blocks `npm.ps1`.

```text
npm run db:generate
npm run build
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_old_peter_parker.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0001_clear_greymalkin.sql
npm run dev
```

Apply each migration once. Production migrations are applied by Sites during publication. Preview and production databases are separate.

The portable starter defaults to port 5173. Use its printed URL. Loopback development simulates sign-in at `/signin-with-chatgpt?return_to=/`; hosted sign-in and private access are provided by Sites. The mock identity is not included in production builds. Never add authentication headers or tokens to browser code.

```text
npm test
npm run typecheck
npm run lint
npm run build
```

## Source map

`lib/types.ts` defines the domain contract. `lib/planning.ts` applies validated commands and computes recommendations. `lib/calendar.ts` and `lib/workspace-validation.ts` own calendar and versioned import/migration rules. `lib/project-baselines.ts` contains reviewed dated evidence and additive application helpers. `lib/seed.ts` contains editable initial content. `lib/workspace-store.ts` stores owner-scoped documents, atomic mutation receipts and pre-restore snapshots. `app/api/workspace/route.ts` authorizes and validates requests. `components/` contains focused views and editors. `db/schema.ts` and `drizzle/` own schema migrations.

The private Site identity is tracked in `.openai/hosting.json`. Source publication uses the installed Sites workflow with temporary credentials supplied only through stdin. Runtime data, preview state, credentials, logs, screenshots and build artifacts remain ignored.

## Data behavior

The first visit initializes a workspace once. Changing seed code never resets an existing plan. A stale save receives HTTP 409; the interface refreshes the latest state while retaining the editor draft for review and explicit retry. An unchanged uncertain retry keeps its mutation ID, including after revision refresh, so an already-committed submission is not executed twice. Failed refresh retains the last saved workspace with a stale indication; session expiry hides protected state and offers sign-in. Drafts are not persisted to browser storage.

Dependencies must be within one project and acyclic. Blocked tasks cannot be completed, and reopening a predecessor cannot invalidate an already-completed dependent. Achieved milestones require acceptance evidence. Completion is an owner-recorded fact, not automatic verification of release readiness or profitability.

Use Sources → Export to download a portable JSON snapshot. Restore validates the schema, references and storage limits, previews counts, requires a final action and protects the current revision. The previous workspace is retained atomically and can be downloaded after restore. This remains a user-managed backup flow. Archive retains stored records and does not free capacity.

Legacy migration preserves the available history and anchors existing weekly pins to their saved Cairo week. If an older version already erased a completion timestamp while archiving, migration cannot reconstruct that lost fact. It does not invent one. Week rollover never silently renews a commitment.

The 17 October baseline is a snapshot, not live monitoring. It matches verified repository identities, preserves all existing project/task/milestone edits and adds proposed records only. Source implementation, historical test reports, current runtime acceptance and profitability are separate claims. The baseline grants no installation, trading, paid-call or deployment approval.

The approved scope and implementation checklist are under `docs/superpowers/`. The [reliability and baseline verification record](docs/superpowers/verification/2026-10-17-reliability-baseline.md) separates completed local checks from remaining publication and hosted verification.
