# Project lanes/history acceptance

This ledger concerns the new lanes/history program. The older program's phase statuses remain unchanged. The review branch is [draft PR #5](https://github.com/krybaby7/control-room/pull/5); there has been no merge or Site deployment.

## Source-specific automated evidence

| Candidate | Checks | Result |
| --- | --- | --- |
| S1 local `bc57d07`, public `5a9368917b78ab6682efd75d005fca93f40d9323`, tree `474329ec7580f8a2a8e0f2647dd6e05e2670b4da` | Node24 full suite, typecheck, lint, build | 2037/2037 tests; all four commands pass; lint12 warnings |
| Intermediate local `ba6bc0d3c6572293cd5f27482542739d1fed2b50` | Node24 full suite | 2221 total,2219 pass,2 collector lock failures,0 cancellation/skip; original archive terminal-epoch race passed |
| Same intermediate | Typecheck; lint | Typecheck failed missing extractionDigest return field; corrected at `b31d964`. Lint passed0errors15warnings |
| Collector lock `aeae8a6` | Parallel collector transport/local reader/real CLI→HTTP→SQLite regressions | 52/52 pass. Kernel local endpoint replaces collision-prone TCP lock; no assertion/timeout changes. Windows endpoint remains device-unverified |
| Full native flow `ef1db43` | Isolated D1 and same-owner SQLite restore macro | Native ingestion/duplicate retry→analysis→explicit owner scope/agreement/assessment→metadata export plus verified selected-body package→reviewed restore→exact retained Unicode citation. All30 migrations, max57bindings/51517argument bytes; original IDs retained; restored source paused/new epoch; native grants and consent absent |
| Public `ce9f3233002a357acb3fe4165a82e0bd8547798c` / local `64036d1`, tree `c641bbb0f0b9b6110eebab1757906c4f3ec56dfe` | Full Node24, typecheck/lint/build, collector/bridge/companion/GitHub | 2265/2265 Node; typecheck/lint/build pass, lint15warnings; collector52/52; bridge210pass9Windows skips; companion105pass2Windows skips; GitHub20/20 |
| Same public candidate | GitHub controlled save benchmark | **Failed** D1 savep952032.553716ms/100samples vs unchanged2000ms; SQLite passes. Run39859390790/job120105857996 |
| Same public candidate | Browser performance,3-engine acceptance, Windows companion | **Failed** obsolete default/secondary navigation assumptions plus serious lanes contrast;105/107 Windows companion. Corrections committed `dd9c069` and `4b3d67d`; exact reruns pending |
| Public `3dfaa32ab46b29db79fc58b85105e508e0fbc226` | Controlled benchmark39863238611; browser performance39863238589; Windows/Linux companion; native Windows owned process | D1 save100samples p951216.943472ms vs unchanged2000 passes;12 synthetic reviewed restores. Browser2/2 passes; both OS companion/native Windows pass. Earlier same-head202ms browser failure retained. Accessibility still fails Today `.mc-brief-hint`; corrected8a7830d, not yet browser-verified |
| Isolated `a8c0e7f` | Canonical no-profile benchmark after reviewed preflight/hash overlap and grouped closed reads | D1 save100samples p951961.683327ms passes;12 reviewed restores; all other budgets pass. Prior corrected072/grouped331/active-owner4 failures retained. Report source label local-source-not-recorded; committed worktree and log identify source. Changes integrated through302969f; final combined source requires own run |
| Native integration through `f74e021` | Sweep/HTTP/job/overview actual SQLite regression suite |33/33 passes: nonempty proposed postimages, explicit empty EOF, resumed multi-page progress, same-batch receipts, JSON/foreign/generation rejection, metadata/object races and commit/mint expiry. No live source/provider/device proof |
| Integrated final candidate | Node/typecheck/lint/build/collector/bridge/companion/GitHub/D1/R2/HTTP/browser/performance/archive integrity | Pending freeze after substantive review corrections; no final-green claim |

Browser specs cover default lanes, finished/open/next, task area/work-type labels, observed versus accepted evidence, preserved pending requests, explicit partial source coverage, citation pagination, dirty draft/back navigation and synthetic responsive screenshots. Initial browser execution found obsolete navigation assumptions and a real small-text contrast failure; `dd9c069` corrects both while retaining the initial lanes axe scan and all timing budgets. Final execution and screenshot inspection remain pending. Display fixtures do not prove actual provider execution or retained owner history.

The standalone history package in the full-flow macro contains one selected available synthetic body. Standard workspace export is metadata-only. Neither result proves a complete private backup or full provider inventory. Actual Windows execution, connected-account inventory/content, renewable unattended access and paid inference are separate live gates.

## Integrated review

Accepted supported worker selection: `model=gpt-6.1-sol`, `fork_turns=none`, reviewer `/root/lanes_objects`. Runtime selection evidence for all workers is in the plan checkpoint. Review baseline is the separately preserved briefings import (`17f7103` public / `b75e2c` local); review continues through the final candidate.

Findings retained for correction and regression:

- Recovery freeze accepted an unsettled physical history PUT and then blocked its settlement; reproduced with actual isolated SQLite and deferred synthetic bucket.
- Analysis reused its start clock across provider awaits; expiry must be checked at current authority boundaries and immediately before publication.
- The no-chunk path reported completion after a failed final job CAS.
- A source removed immediately after cross-epoch restore retained its old execution epoch, preventing current-epoch metadata cleanup.

All four findings are corrected through `64036d1`;41 focused review regressions pass. The original deferred physical PUT reproduction now rejects freeze, lets the PUT settle, and leaves a ready ledger with no pending token. Independent review found no further blocker in this bounded delta. Later browser/Windows/performance changes require their own exact candidate checks.

## Live gates and precise handoff

| Gate | Status | Required action/evidence |
| --- | --- | --- |
| G-local-codex | Not verified | On the enrolled owner machine, select read-only roots; enumerate retained/archived/compressed/segmented scope; compare known old/new threads; import a later change to an old thread |
| G-local-claude | Not verified | Select actual project/subagent roots; account for compaction/index-only missing transcripts; read and later update retained content |
| G-cloud-codex | Not verified | Register a supported account-scoped read-only inventory/content adapter and renewable unattended principal; prove pagination, archives/backend classes and later change capture |
| G-cloud-claude | Not verified | Establish supported Claude Code web/cloud inventory/content and renewable unattended read; manual import or teleport cannot satisfy this gate |
| G-unattended | Not verified | Install packaged collector on the owner machine with protected credential, start scheduled service, close browser/terminal, observe later activity, restart/offline catch-up and revocation; independently register hosted scheduler |
| G-story-runtime | Not verified | Configure exact provider/model, scope/privacy consent and spending budget; inspect cited multi-chat finished/open/next against real retained source; inference remains disabled until then |
| G-private-hosted | Not verified | Complete verified private metadata AND byte backup first; deploy through existing private Site's supported workflow, retain identity/access, check actual version/owner records and unrelated-identity denial |
| G-owner-workflow | Not verified | Owner reviews overview→area briefing→citation→explicit owner action→source coverage using real workspace |
| G-physical-acceptance | Not verified | Record real device/project operational evidence separately; no Control Room test may accept these checkpoints |

All four source capabilities remain unverified. Successful fixtures, empty CLI lists, manual imports, saved schedules and passing builds cannot close these gates. Paid inference, trading/operational effects and external alerts remain disabled.

## Native reader activation seam

`HistorySyncHttpServices.createSweepVerifier(authority,claim)` supplies a registered native reader. It receives only the genuine ingestion postimage witness; native EOF, exact inventory membership, finalized owner-scoped bytes, parser lineage and current authority are required. Private progress, terminal page and receipt share one CAS/recovery-capacity batch. Missing proof keeps coverage unverified.

`nativeHistoryCoverageServices({db,now,resolveReadOnlyReader})` discovers bounded retained completed jobs and validates native receipt plus branded retained coverage. Its registered reader and factory share the same DB identity. GET verifies retained DB/private bytes only; it does not call source inventory/conversation APIs. Configure the actual private server binding separately; production routes remain closed/unverified without that binding.
