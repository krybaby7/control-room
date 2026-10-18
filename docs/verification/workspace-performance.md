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
