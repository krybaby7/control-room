# Evidence and history implementation checkpoint

Phase 3 is in progress. Current published source remains `ac17e4ba2d5d55b4fe6f0e16c1638ffc78ed6a8f` on the draft implementation PR. That source passed 423 Node tests and all 26 Chromium journeys in cloud run39136249732/job117701249535. It has not been deployed as a new private Sites release.

Uncommitted Phase 3 work adds immutable evidence/decision versions, strict provenance, explicit owner requirements/assessments, staged attachment policy/storage proposals, append-only history paging, guarded ordinary-edit undo, physical multi-table restore adapters, stable imported audit identities, and server-private random namespaces. New migrations preserve legacy IDs, payloads and row revisions. Unknown legacy records remain labelled context and fail closed where typed references are required.

An intermediate integrated run passed **568 Node tests**, zero failures/skips. Focused tests use isolated synthetic SQLite and explicitly injected fake blob stores. Actual private R2, hosted identity, device execution and file recovery have not been proved. Typecheck and production build passed before the latest undo/attachment route integration; full gates are being repeated for the final coherent source slice. Phase 3 browser journeys have not run.

The runtime accepted explicit `gpt-6.1-sol` selection for the integrator and the six recorded workers in progress.json. Reused workers retain that accepted configuration; no prompt-only model claim or substituted implementation model is used.

Current unfinished work: complete protected UI and stable detail links, finish attachment quota/finalization/cleanup integration and file-inclusive recovery, bind whole-command undo preview to its original receipt, assess current acceptance freshness separately from historical records, add integrated browser/failure journeys, and run all release checks. Phases 4–8 follow in dependency order. Paid inference and operational/trading effects remain disabled.

Next command: inspect current git status and the latest full gate results, finish bounded worker integration, then run `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` and `npm run test:fixture`. Preserve every current edit; do not reset to the published Phase 2 checkpoint. The rejected inspection commit remains local and must never become a published ancestor.

## Coherent source gate

Latest source passed **604 Node tests**, zero failures/skips, plus full typecheck, ESLint and production build. All **31** Chromium journeys are discovered; five new evidence/decision journeys await cloud execution. The authenticated evidence/decision workspace, protected editors, history paging and whole-command ordinary-edit undo review are connected. The built-worker fixture is being repeated against this final build before publication.

Independent review found and fixed restore-induced exception-grant resurrection. Restores revoke server-current grants while retaining every decision version and owner record; only a new explicit owner decision can authorize an exception. Two real SQLite regressions cover resurrection and failed-restore rollback. Backup manifests now list excluded ready-file metadata and independently report missing attachment bytes, including legacy empty-manifest compatibility; three real SQLite integration tests prove this without any blob call.

Open boundaries: source object keys remain historical attachment metadata, not target availability; file-inclusive archive/restore needs explicit rekey/byte verification. The cleanup adapter has fake-contract tests but still needs persistent SQL fencing and a concrete registered runner. Requirements/linking, owner assessment and explicit decision-action UI, complete undo families, stable evidence/detail citations and current-assessment freshness remain unfinished. No Phase3 acceptance or new deployment is claimed.

The final built-worker synthetic HTTP GET/POST/replay/CSRF smoke passed. The private Site identity is unchanged and the rejected inspection commit is excluded from implementation ancestry.

Published source: `6e31db7e33e5d0d0876f949958ee25f20536fe73`, exact tree `0d45a996a9e4c9daf9842bcede90a613de5bc554`, on the existing draft PR. Cloud CI39139870503 is in progress; no new browser pass is claimed yet.

## First Phase 3 cloud browser result

CI39139870503/job117711897996 at6e31db7e completed with clean locked install,604 Node tests,typecheck,lint,build and actual HTTP fixture passing. Chromium passed **27/31**, including all five new evidence/decision journeys. The four failures all exercise reviewed planning merges after evidence modules are populated. The shared compiler incorrectly applied full-replacement completeness rules to a merge that preserves current normalized data. A narrow merge-only preservation path now guards the complete16-table rowset; four new actual SQLite tests cover byte-exact module/grant retention, receipt replay, recovery backup and direct row races. The original browser merge journeys remain unchanged for the rerun.

Uncommitted follow-on work also distinguishes current owner-assessment attribution from imported history, adds immutable-record freshness assessments and a bounded read-only owner preview. Additional protected link/criterion/assessment/decision-action UI is in progress. These follow-on changes have not yet been published or accepted by cloud browser tests.

The coherent backend merge fix passes **617 Node tests**, zero failures/skips, typecheck,lint,production build and actual isolated HTTP fixture. Four new SQLite merge regressions retain every normalized row and current owner grant while rejecting direct row-set races. Cloud rerun is pending publication of this patch; protected action UI remains separate work.
