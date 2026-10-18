# Cloud implementation checkpoint

Parent source: 2c5a4c37d7ff0b3a278ddbbb43d14cd20a9ad42b. Resolve the branch head for this checkpoint's own commit.

GitHub source APIs and actual GitHub Actions Node 24 cloud runners. Supported workspace execution remains unavailable.

Accepted runtime model: `gpt-6.1-sol` for the integrator and six worker IDs recorded in progress.json. No model substitution.

2c5a: agent tests, global typecheck/lint, runtime/agents D1, maintenance, streaming and three-browser acceptance passed. Mobile readiness/long tasks passed. Near-bound concurrent save p95 SQLite2008.26ms/D111451.22ms exceeded2000ms. HTTP20-session test encountered an empty response; no valid p95 was obtained.

## Known failures and unfinished tasks

- Artifact PUT still exceeded D1 depth100 after dual CTEs. Exact balanced authority predicates are included here; actual rerun pending.
- Queued work is changed to resume in its original request context, with a native Miniflare cross-request regression. Actual HTTP rerun pending.
- Near-bound concurrent save latency remains above2000ms; no threshold was raised. Batched coherent reads are being reviewed.
- Full source suite and 46-table segmented rehearsal remain unfinished; no final package or new deployment is claimed.
- Hosted/provider/runtime/owner-device acceptance and supported Sites helper execution remain external.

This revision adds request-local admission continuation, a cheap stale-revision check after epoch/replay handling, balanced artifact authority SQL, and focused cloud regression selection. Existing private Site, owner data and access remain unchanged. Paid inference and operational effects remain disabled.

Next command: Read exact-head focused and full Actions logs; resolve remaining native/performance/recovery failures, then hold a final revision for all gates and candidate packaging.
