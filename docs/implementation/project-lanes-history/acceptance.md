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
| Integrated final candidate | Node/typecheck/lint/build/collector/bridge/companion/GitHub/D1/R2/HTTP/browser/performance/archive integrity | Pending freeze after substantive review corrections; no final-green claim |

Browser specs cover default lanes, finished/open/next, task area/work-type labels, observed versus accepted evidence, preserved pending requests, explicit partial source coverage, citation pagination, dirty draft/back navigation and synthetic responsive screenshots. These specs currently parse; execution and visual inspection remain pending. Display fixtures do not prove actual provider execution or retained owner history.

The standalone history package in the full-flow macro contains one selected available synthetic body. Standard workspace export is metadata-only. Neither result proves a complete private backup or full provider inventory. Actual Windows execution, connected-account inventory/content, renewable unattended access and paid inference are separate live gates.

## Integrated review

Accepted supported worker selection: `model=gpt-6.1-sol`, `fork_turns=none`, reviewer `/root/lanes_objects`. Runtime selection evidence for all workers is in the plan checkpoint. Review baseline is the separately preserved briefings import (`17f7103` public / `b75e2c` local); review continues through the final candidate.

Findings retained for correction and regression:

- Recovery freeze accepted an unsettled physical history PUT and then blocked its settlement; reproduced with actual isolated SQLite and deferred synthetic bucket.
- Analysis reused its start clock across provider awaits; expiry must be checked at current authority boundaries and immediately before publication.
- The no-chunk path reported completion after a failed final job CAS.
- A source removed immediately after cross-epoch restore retained its old execution epoch, preventing current-epoch metadata cleanup.

Final disposition and exact regression results will be added after fixes are committed and the frozen candidate is checked.

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
