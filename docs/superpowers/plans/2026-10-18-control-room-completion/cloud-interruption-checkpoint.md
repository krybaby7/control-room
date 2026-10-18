# Cloud implementation checkpoint

Parent source commit: 3b28d890638ff7d007bb893352f404d8ec4ae7db. Resolve the branch head for this checkpoint's own commit.

Exact model selection: accepted `gpt-6.1-sol` runtime parameter for the integrator and workers `/root/codec`, `/root/drafts`, `/root/export_registry`, `/root/foundation_review`, `/root/runtime_probe`, and `/root/save_client`. Follow-up tasks retain their selected model.

GitHub source APIs and actual GitHub Actions Node 24 cloud runners. Supported workspace execution remains unavailable.

18e443: 103 agent tests, native agents D1, runtime D1, maintenance and streaming passed. Chromium, Firefox and WebKit acceptance passed. Mobile readiness and long-task gates passed; concurrent HTTP save p95 4864.82 ms failed the unchanged 2000 ms gate.

## Included changes awaiting validation

46-table original-history recovery, staged-file proof, paid journal guards, bounded per-owner admission, artifact SQL-depth correction, and atomic cleanup-race injection fixtures. Existing private hosting identity and audience remain unchanged. No new deployment, paid inference or operational effects.

## Known failures and unfinished work

- Artifact upload: actual D1 expression depth exceeded 100 with 96 bindings. A second materialized authority proof is included; exact rerun pending.
- Concurrent save latency remains above budget. Bounded per-owner admission is included; coherent snapshot and growth-metadata optimizations are under review.
- Five cleanup race tests failed because their injection hook missed the new atomic batch. The hook is corrected without changing security assertions; exact rerun pending.
- Full Node run was superseded before completion. No final complete source/package validation is claimed.
- New 46-table recovery, staged-file proof and paid-history guards require actual regression execution.
- Real provider/runtime/device/hosted acceptance and supported Sites helper execution remain external.

Next command: Inspect this branch head's Actions; resolve genuine regressions, integrate reviewed performance improvements, then hold one source revision for every acceptance and package gate.
