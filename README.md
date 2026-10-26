# Control Room

GitHub onboarding now has a subscription-only **Codex Cloud** handoff alongside **This PC** analysis. Prepare a read-only prompt, run it against the selected GitHub repository in Codex Cloud, then import and review its JSON report. See [GitHub cloud analysis](docs/operations/github-cloud-analysis.md) for setup, save recovery and the manual integration boundary. This does not activate a separately billed API provider.

A private planning home for TAMENNI and Trade Graph, built for PC, phone and tablet. Both products have equal priority. The online plan continues to work while the PC is off.

## Cloud implementation program

The [completion plan](docs/superpowers/plans/2026-10-18-control-room-completion/00-master-plan.md) covers 48 audited gaps across setup and eight implementation phases. Start with [CLOUD-START.md](docs/superpowers/plans/2026-10-18-control-room-completion/CLOUD-START.md) and root [AGENTS.md](AGENTS.md). Implementation and review workers must use `gpt-6.1-sol`; the launch must verify model selection. [Import provenance](docs/source-import.json) records the audited source baseline. The plan is not a claim that its features are implemented.

This repository's source is public with the owner's approval. Hosted access, workspace records, connected accounts and credentials remain private.

## Imported first release

- Today (mission control): a status strip for the enrolled PC, the personal PC app and its Codex/Claude readiness, agent activity and items that need you; project tiles with an owner briefing (your current aim and where we left off in business terms, a map of the project's areas and how far each is proven, the ledger of your own intentions with what became of each and where the plan bent, what needs you and what is still open; written on your PC by Codex or Claude Code from your own messages in local and repository-recorded cloud chats, recent local and GitHub work, and the previous briefing; measured against your verbatim project framing, with a short account of how the current aim fits the bigger picture or has drifted; task plans are included only when you opt in; refreshed on request or kept current automatically per project), milestone/task meters, the live agent job (stage, progress, elapsed time against its budget), the latest saved technical analysis with recent-chat coverage, recent activity and the next action; live operations with recent runs and recorded token usage; explained next-action suggestions, weekly focus and a mission log. Feeds are read-only and refresh every 10 seconds while an agent is working, otherwise every 45 seconds.
- Projects: an owner-written framing document (up to 2,500 characters) describing what the project is, why it matters and standing rules for briefings; a default-off task-plan inclusion switch; editable goals, milestone acceptance criteria, task planning, dates, priority, Now/Next/Later, dependency links and explicit blockers. Registered PC folders can create and map a project before you write its framing or explicitly request its first briefing.
- Capture: save an idea, proposed task or decision with an optional source. Convert a capture into a task once, preserving its text and source.
- Reversible archive with completion history, Cairo calendar-week commitments, dated activity and JSON export/validated restore.
- Online D1 persistence scoped to the signed-in user; revision checks protect cross-device edits and durable mutation receipts make unchanged retries safe.
- Dated project baselines with source evidence and an additive application of five proposed tasks plus one saved context per project.

The starting content is editable. User goals are confirmed; task suggestions and acceptance wording are proposed. Source links refer to the inspection on **17 October 2026**. They are not a live GitHub or runtime feed. No deadlines, weekly commitments or completion claims are invented.

## Completion candidate

The implementation branch adds reviewed planning/evidence/history workflows, bounded source adapters, reviews and automation, the installable Windows bridge, guarded agent coordination, and complete recovery tooling. [Progress and checkpoints](docs/superpowers/plans/2026-10-18-control-room-completion/progress.json) and the [gap ledger](docs/superpowers/plans/2026-10-18-control-room-completion/09-gap-coverage.md) distinguish implemented source, exact automated evidence and external acceptance.

The private hosted version 24 (25 October 2026) is published from this branch; `main` is the source of what runs, and anything published must be on GitHub first. The finite manual Sites service adapter and private runtime/Windows invocation integration are implemented with default-disabled configuration. Native private ingress, provider connections, actual Windows installation, physical-device/passkey acceptance and hosted scheduling require their own observed checks; unattended renewal remains unsupported. Paid inference and operational/trading effects remain disabled. A fixture or saved schedule does not prove external execution. See the [release runbook](docs/operations/release.md).

## Local development

Use Node 24 and install the locked dependencies with `npm run install:ci` after cloning. PowerShell users can invoke `npm.cmd` if execution policy blocks `npm.ps1`.

```text
npm run db:generate
npm run build
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_old_peter_parker.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0001_clear_greymalkin.sql
npm run dev
```

The commands above show the original two migrations. For the completion branch, also apply every later `drizzle/*.sql` in filename order once to the isolated local database; never edit an already applied migration. Production migrations are applied by Sites during publication. Preview and production databases are separate.

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

The first visit initializes a workspace once. Changing seed code never resets an existing plan. A stale save receives HTTP 409; the interface refreshes the latest state while retaining the editor draft for review and explicit retry. An unchanged uncertain retry keeps its mutation ID, including after revision refresh, so an already-committed submission is not executed twice. Failed refresh retains the last saved workspace with a stale indication; session expiry hides protected state and offers sign-in. Server drafts are separate from the authoritative plan. Browser device drafts are off by default and require explicit trust and unlock; their recovery never submits automatically.

On the completion branch, dependencies can cross projects within one authenticated workspace and must remain globally acyclic. Blocked tasks cannot be completed, and reopening a predecessor cannot invalidate an already-completed dependent. Achieved milestones require acceptance evidence. Completion is an owner-recorded fact, not automatic verification of release readiness or profitability.

Use Sources → Export to download a portable JSON snapshot. Restore validates the schema, references and storage limits, previews counts, requires a final action and protects the current revision. The previous workspace is retained atomically and can be downloaded after restore. This remains a user-managed backup flow. Archive retains stored records and does not free capacity.

Legacy migration preserves the available history and anchors existing weekly pins to their saved Cairo week. If an older version already erased a completion timestamp while archiving, migration cannot reconstruct that lost fact. It does not invent one. Week rollover never silently renews a commitment.

The 17 October baseline is a snapshot, not live monitoring. It matches verified repository identities, preserves all existing project/task/milestone edits and adds proposed records only. Source implementation, historical test reports, current runtime acceptance and profitability are separate claims. The baseline grants no installation, trading, paid-call or deployment approval.

The approved scope and implementation checklist are under `docs/superpowers/`. The [reliability and baseline verification record](docs/superpowers/verification/2026-10-17-reliability-baseline.md) separates completed local checks from remaining publication and hosted verification.

## Completion implementation status

Cloud implementation is in progress on the completion branch. The existing deployed version has not been replaced by this checkpoint. See [progress](docs/superpowers/plans/2026-10-18-control-room-completion/progress.json) and the [cloud verification checkpoint](docs/superpowers/verification/2026-10-18-cloud-foundation.md) for implemented slices, exact checks and remaining acceptance gates.

## Planning completion branch

This source branch adds editable portfolio identities,archive/restore,milestone ordering and workspaces,safe final-clone task moves/bulk changes,full capture triage,copyable search and complete attention queues. Archived project/milestone descendants retain their IDs and history. Removing an archived record requires a revision-bound impact review and a verified recovery point; nothing cascades silently.

Weekly plans use Cairo Monday weeks with optional capacity and task estimates. Unknown estimates remain unknown; over-capacity is advisory. Carry/remove and frozen review corrections are explicit owner commands. The review editor retains recoverable prose; later task changes do not rewrite frozen snapshots. Recurrence is manual proposal generation with stable occurrence identities,empty evidence and no weekly pin. Removed occurrences retain their disposition and cannot regenerate. No unattended scheduler is activated.

Search query,filters and page can be copied in the URL; treat such links as private workspace context. Attention explains planning findings and links old commitments to their source week for explicit review. Missing external providers do not imply fresh sources. Today retains a six-item preview and an explicit complete ready-work queue.

Run the full regression gate with `npm test`,`npm run typecheck`,`npm run lint`,`npm run build`,`npm run test:fixture` and `npm run test:e2e`. The latter two use an isolated synthetic worker/database; they do not prove hosted identity,physical devices,provider execution or deployment. See [planning verification](docs/verification/planning-workflows.md) for the actual source version and cloud results.

The completion branch also contains structured evidence and decision history, explicit owner assessments, subject review context, private staged attachments, and reviewed native ZIP recovery. File availability is verified through the private server adapter; imported metadata and model/provider text do not establish acceptance. Private R2 provisioning, hosted owner-session checks and background-runner activation remain release gates. See `docs/verification/evidence-history.md` and the completion plan's `progress.json` for exact source and CI evidence. The existing private Site has not been redeployed from this branch.
