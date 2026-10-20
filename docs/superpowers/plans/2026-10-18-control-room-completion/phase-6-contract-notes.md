# Phase 6 contract preparation

Read-only design preparation after Phase 5 follow-up publication; Phase 6 implementation has not started. The Phase 5 exact-source native gate is still running. The phase plan remains authoritative.

## Shared boundaries to establish before delegation

Keep planning schema 4 unchanged. Register strict portable display aliases, adapter configuration and explicitly selected frozen runtime evidence through existing owner modules/references/recoverability. Credentials, enrollment hashes/secrets, ingress credentials, live generations/sessions/leases, raw process identifiers and local paths stay private. Imported device aliases never enroll a device; imported configuration is disabled and imported observations remain historical.

Use separate private tables for one-use hashed enrollment, hashed scoped credentials, device runtime/epoch, monotonic session generations, heartbeat receipts, allowlisted observations/latest projections, minute aggregates and bounded retention cursors. Every relationship includes the owner. Execution scopes are reserved for Phase 7 and cannot be issued by Phase 6.

A device request requires both a supported private-platform ingress verifier and its own mapped device credential. Default verifier is unavailable; visitor identity, ambient browser cookies, arbitrary Authorization headers and body owner IDs cannot replace it. Browser enrollment/revocation/configuration uses the existing owner command/receipt boundary. Return a new enrollment secret once in a private no-store response; retain only its digest. A lost enrollment response requires a new explicit enrollment, never a second token on replay.

Session registration returns a monotonically increasing generation. Exact boot retries return their original generation; superseded boots never reactivate. Heartbeat identity includes device/boot/sequence and canonical digest. Exact duplicates return the original receipt; changed payloads conflict. Source clocks are nullable and never replaced by ingest clocks.

Add an explicit heartbeat delivery discriminator `live` or `history`: historical outbox replay must not refresh connectivity or latest readings. Retain generation tombstones and compacted sequence floors after seven-day telemetry pruning so removed receipts cannot execute again. Selected evidence copies its frozen sanitized body before raw retention. Minute aggregates retain known counts/gaps instead of turning unavailable readings into zero.

## Delegation after shared contracts and Phase 5 gate

1. Strict runtime validation/freshness and synthetic fixtures.
2. Device authentication/enrollment/session stores with SQLite and actual D1 races.
3. Telemetry ingestion/latest/aggregates/retention with compound authority CAS.
4. Node 24 bridge fixed numeric-loopback reads, sanitizer, bounded atomic outbox and private-ingress transport adapter.
5. Durable owner UI/routes and native browser scenarios.
6. Portable adapters/references/recovery and Windows DPAPI/current-user task packaging.

The integrator owns schema/migrations, shared command/control integration, privacy boundaries and release packaging. Windows scripts are packaged and tested structurally in cloud; do not run them here. Never start PC Command Center, a model, an execution runtime or trading process. Real Windows and private-ingress acquisition/refresh remain separately recorded acceptance actions.

## Historical retry identity detail

Resolve delivery classification without changing heartbeat identity: keep the canonical heartbeat payload/boot/sequence unchanged and put live/history classification in a strict transport envelope or header. The digest and receipt key bind the heartbeat payload; an exact duplicate returns its original receipt regardless of delivery classification and never promotes a historical receipt to live. Reconnection sends a newly sampled live sequence before replaying old payloads as history. A failed live upload must not become a later fresh sample merely because its first successful delivery occurs later. Preserve/report transport age and original sample clocks, and use conservative freshness when delay or source clock is unknown. Tests must include an old previously-unreceived payload delivered after reconnect, not only a duplicate of a previously accepted heartbeat.

A delivery flag alone does not prove the age of a previously unreceived payload. Establish a private, server-issued 30-second live window for an exact current device/epoch/boot/generation/sequence **before sampling**. Exact retries return the original window and never extend it; an old sequence cannot obtain a replacement clock. One outstanding window/device and the ten-second rate limit bound issuance. A live window never itself updates connectivity. Add a bounded `/api/bridge/live-window` route and private window records, with monotonic sequence floors retained after pruning.

The strict transport envelope carries delivery classification, original window identity or null, and the unchanged canonical heartbeat. New expired-window or history deliveries remain history; they cannot advance last-live/latest state. Consume a valid window, receipt and projection atomically. Same heartbeat identity/digest always returns the original receipt and cannot be promoted by changing its envelope. Current credential revocation/epoch boundaries still apply to replay.

Compute transport-age upper bound from server receive time minus server window issue time, which precedes sampling. Preserve original source age/time separately. Require a known effective ingest age upper bound at most ten seconds for initially fresh PC state, then original source age plus that server delay bound plus elapsed server time at most forty-five seconds; excessive source clock skew suppresses freshness. Missing age/window remains unknown. Fake HTTP/D1 tests must cover first delivery after expiry, a new window attempted for an old sequence, changed envelopes on exact duplicate, generation/epoch fences and atomic window/receipt/projection rollback. This is protocol design only until Phase 6 implementation and validation.
