# Controlled workspace performance benchmark

Status: prepared; no timings or successful execution are claimed here.

Run with Node 24 and the locked dependencies:

```sh
npm run install:ci
node --experimental-strip-types scripts/benchmark-workspace.mjs
```

The dedicated `Control Room controlled workspace benchmark` workflow records its
exact checked-out source SHA and uploads `synthetic-workspace-performance`.
The report is `benchmark-results/workspace.json`; it contains measured samples,
fixture counts and hashes, byte limits, runtime/CPU information and explicit
failures. It does not contain raw owner records, namespaces or credentials.

## Actual fixture and operations

The runner applies the real migration files to an in-memory Node SQLite adapter
and actual isolated Miniflare D1. It uses real workspace reads, owner-scoped indexed
pages, structured evidence reads, module export, strict bundle parse, quarantine
and the central reviewed import command. Synthetic metadata is inserted only
during setup through actual typed module projections and immutable content hashes.
No fake database or mocked timing adapter is used.

The case starts at 90% of the supported task and capture counts, trying 85% and
80% only if the real valid export cannot fit the declared default recovery byte
target. It refuses to silently reduce the case below that range. There are 256
typed evidence heads and immutable version pairs. A bounded ASCII statement is
calibrated outside timing so the actual metadata bundle is between 75% and 82%
of the current 1.8 MB D1 recovery bound. The report records the actual chosen
counts, ratios and bytes. Independent row, planning-content and recovery-byte
limits are not assumed simultaneously attainable.

Each operation has one unmeasured warmup and five measured samples.
The nearest-rank p50 and p95 use every measured sample; with five samples p95 is
the largest observed sample. These are coarse regression indicators, not stable
tail estimates. Positive elapsed times come from the real monotonic host clock.
Logical fixture timestamps are fixed for deterministic metadata and TTL guards;
elapsed timings are never fabricated or clock-mocked.

The reviewed restore measurement includes real staging, receipt ID issuance,
recovery snapshot generation, guarded transaction and verification of unchanged
planning. Six real restores retain six recovery snapshots; the benchmark neither
evicts backups nor resets usage between samples. This stays within the actual
eight-stage and ten-snapshot limits. Evidence IDs and version content must survive.

## Declared regression budgets

Budgets are milliseconds for the measured p95. They are intentionally generous
shared-runner regression gates, not production latency promises.

| Operation | SQLite | Miniflare D1 |
| --- | ---: | ---: |
| Planning owner read | 2,500 | 7,500 |
| Complete evidence read | 5,000 | 20,000 |
| Indexed owner page and foreign-owner absence | 250 | 2,500 |
| Full structured export | 10,000 | 30,000 |
| JSON parse | 500 | 500 |
| Strict bundle parse | 5,000 | 5,000 |
| Canonical JSON and SHA256 | 3,000 | 3,000 |
| Staged reviewed restore | 30,000 | 60,000 |

Setup and migration time are excluded and are not presented as operation latency.
JSON and hashing run in Node in both cases; database operations include the
actual binding round trips. The report includes Node process memory snapshots,
which do not claim to include all Miniflare child-process memory.

An operation error or exceeded budget fails the workflow. Errors are retained,
never replaced with zero timings or a passing mock. Both database engines are
attempted when setup permits. A terminal successful workflow plus its exact
report identity is required before recording G47 performance acceptance.

This fixture does not measure private hosted network latency, gateway/passkey
behavior, actual R2 transfer, screen rendering, concurrent real owners, Windows
hardware, a provider or model. Production baselines and load/soak acceptance remain
separate and must use owner-authorized environments.


## Concurrent identity and browser extensions

The database runner additionally creates one positive selected source connection/target and one device/configuration identity after the immutable restore measurements. Both owner-scoped read models are measured with the 1.5 s p95 engineering target. The device is deliberately never enrolled and has no observation; assertions require that absence rather than inventing a fresh collector. A separate synthetic owner must see neither identity.

Five real concurrent waves each retain twenty independent central command envelopes: ten contend on one revision of the near-bound owner and ten target distinct small synthetic owners. Each wave must commit exactly eleven changes and reject nine stale revisions. All 100 read/save durations are retained, including conflicts. Actual original-command replay must leave audit count unchanged; receipt counts and final content/revisions are checked for every owner. SQLite has a synchronous native binding and therefore does not establish twenty operating-system connections. Miniflare uses its actual local D1 binding. Neither is a hosted-network load claim or a job-delivery test. Concurrent reads use 1.5 s p95 and saves 2 s p95 gates; full-wave bounds remain explicitly separate from per-session latency.

The dedicated `Control Room controlled browser performance` workflow builds the real isolated Worker and runs `playwright.performance.config.ts`. Its first test creates five fresh Chromium mobile contexts with uncached assets and actually applies CDP latency 150 ms, download 200,000 bytes/s (1.6 Mbps), upload 93,750 bytes/s (750 kbps), and 4x CPU slowdown. First usable requires the saved workspace and enabled Capture control. The p95 gate is 3 s. Normal navigation through Agents, Runtime, Sources and Today records actual PerformanceObserver long tasks and navigation timings; any observed interactive task above 200 ms fails. No observed long tasks is recorded as count zero and maximum null, rather than a fabricated zero-duration measurement. These are cold browser contexts against an already started local Worker, not hosted Worker cold starts or physical-phone results.

Its second test uses twenty actual isolated Chromium cookie jars and HTTP requests to the built Worker/D1, split across the harness's two synthetic owners. Ten sessions per owner submit against the same revision. Exactly two commits and eighteen conflicts are required, original replay cannot increment either revision, committed/not-found outcomes must match each original mutation ID, and content cannot cross owners. The measured save p95 gate is 2 s on unthrottled loopback; it is not mislabeled as the mobile-network profile. Commands are ordinary central capture updates, never a provider call, job approval, task completion, or production-owner write.

Artifacts preserve exact source, network profile, raw durations, counts, and limitations in `benchmark-results/browser.json` and `browser-concurrency.json`. Existing near-bound export/restore samples and their original budgets remain unchanged. Actual Actions results are required before reporting any new target as passed. Job delivery, deployment resource budgets, hosted cold starts, physical devices, real provider costs and worst-case module maxima remain separate acceptance work.


## Opt-in command-phase profiling

Run `CONTROL_ROOM_PROFILE_COMMANDS=1 node --experimental-strip-types scripts/benchmark-workspace.mjs` only in this isolated fixture runner. The engineering budgets, data and correctness checks are unchanged. Profiling adds measurement overhead and is diagnostic evidence rather than a claim of uninstrumented production latency.

One database wrapper is retained for the entire SQLite or Miniflare engine, including warmups. This preserves DB-object-keyed schema/contract caches. Node AsyncLocalStorage attributes overlapping command calls without creating a new wrapper or mutating a shared current-owner variable. Each of the 100 timed central commands records a numerical wave/session, coarse owner class (contended near-bound versus independent small), result status, elapsed wall time, actual first/all/run/batch RPC and statement counts, and bounded fixed query-family categories. SQL text, parameters, owner IDs, command bodies and result rows are never printed or retained by the profiler.

The profiler retains at most 1,024 binding-await intervals per command. It reports both summed wait and the union of overlapping intervals. Wall time outside that union includes admission waiting, JavaScript, hashing/validation and other unobserved asynchronous work; it must not be described as CPU time. Truncated interval sets are marked and union/residual values become null. Per-group summaries preserve committed versus conflict outcomes and both owner classes; no unfavorable samples are dropped. Raw observations and summary groups are included in the existing controlled artifact, and bounded JSON diagnostics are printed for terminal-log inspection. No deployment/provider operation or production query/index change is introduced by profiling.
