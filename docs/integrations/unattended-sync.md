# Unattended source synchronization

The source job store extends the foundation `workspace_job_intents` queue through a unique `intent_id`. `integration_jobs` holds linked operational metadata and `integration_job_attempts` holds attempts; neither is an independently populated second queue. A saved request or job is not proof that a scheduler or provider read has run.

## Authority before a claim

A claim must resolve the exact owner, selected source and connection, configuration hash, execution epoch, source operational revision, job revision, access mode and principal. Claims have bounded leases and renewal checks. Configuration, pause, cancellation, expiry, revocation, resource scope and current epoch are checked again when work commits. An expired lease does not authorize a stale worker to write.

Interactive reads require the current authenticated owner and a verified request-scoped provider principal. Manual imports use the authenticated owner's explicitly selected manual resource and do not establish connected or unattended provider access. Unattended reads require a separately registered renewable service principal with the exact `source:read` scope, an owner/resource/mode-bound private grant and unexpired verification. A portable source selection, authoring credential or service ingress bearer is insufficient.

The current access and job-store interfaces are infrastructure contracts. They do not prove that a real private runner, eligible hosted connector, GitHub App installation, credential renewal path or scheduler is provisioned. Never report a scheduled source as live merely because configuration or intent rows exist.

## Bounded work and honest freshness

The current source bounds are 2 MiB per provider page, 100 observations per page, five pages/250 observations per run and a 20-second provider-call budget. Observation payloads are capped at 64 KiB; document/file excerpts are capped at 8,000 characters. Continuation state is bounded to 16,000 bytes and belongs to the selected resource, configuration, facet and pinned representation. Conditional reads and ETags must preserve those boundaries; an unchanged repository facet does not prove independent PR/check facets are unchanged.

Each page advances its saved cursor only with the immutable observations, deduplicated pending proposals and operational history committed under the same claim guard. A dropped page-success response can be reconciled with its existing page receipt; retries must not duplicate observations or suggestions. Finishing a run updates outcome and releases its lease under the current claim. Partial work retains a continuation and does not advance the last-success timestamp or last successful source revision. Failed/cancelled attempts retain the last good content as well. Retry timing remains operational metadata.

Freshness distinguishes paused, disconnected, needs-connection, syncing, unsupported, failed, stale and fresh states, with a separate partial flag and last successful context. Staleness is measured against the selected threshold; missing capability, a future/inconsistent clock or an incomplete attempt cannot establish fresh access. A cached source may remain readable as historical context while the latest refresh is unavailable.

## Two revision domains

Source refresh observations, page/run history, cursors, leases and pending suggestions use operational revisions and the source history stream. They do not increment the planning editor revision, accept proposals, create owner evidence or complete work. Owner source configuration and proposal decisions use the normal editor command, audit and durable receipt boundary. An explicit accepted planning delta is therefore distinguishable from a background observation.

Portable modules include source selections, immutable observations, proposals and sanitized run/history records. Private grants, secrets, active cursors/leases, runnable intents and service-principal authority are excluded. Imported history remains data. Recovery pauses integrations, clears cursors/ETags, removes source access grants and uses the foundation's new execution epoch so old claims cannot resume. Revalidate current access and obtain an explicit owner resume after restore; renewing a lease from an earlier epoch cannot reactivate work.

## Retained input remains an explicit owner workflow

A manual `contentAttachmentId` references a file the owner has already reserved, staged and explicitly finalized; source refresh does not silently upload or finalize full content. The HTTP path checks exact submitted input bytes against owner-ready attachment metadata and verified private physical ledger state. Atomic page guards preserve the exact ready generation, SHA-256 and byte length and reject purged/fenced or changed state. The immutable observation records `contentAttachmentRef` plus payload `contentRetention`; source revision stays unchanged when this new representation is added.

Document retention is exact submitted UTF-8 content. Conversation retention is canonical submitted conversation JSON filtered to the explicitly selected messages, not a claim that the original export file was retained. Default excerpts remain bounded reading projections; document payloads without explicit retention continue to report `fullContentRetained: false`. Complete native archives can include referenced ready attachments after actual byte verification, while JSON exports carry metadata only. Restoring a source reference does not restore access grants or prove object availability. Actual private hosted R2 activation remains a separate unverified gate.

## Acceptance still required

Before declaring a provider live, verify one selected real resource against its provider and retain the exact returned SHA/version and limitations. Before declaring unattended sync live, repeat from a freshly authenticated renewable runner without browser cookies, verify private ingress and owner scoping, and demonstrate renewal, expiry/revocation, partial continuation and lost-response recovery. Document manual-only and unsupported surfaces explicitly when these gates cannot be met.

Source readers establish software reading/transport observations. They provide no PC/device telemetry, physical test or physical-acceptance proof, and they dispatch no paid inference, trading or agent effects. Those remain separate authorized and independently verified capabilities.

Implementation anchors: `lib/background/job-contract.ts`, `job-store.ts`; `lib/sources/store.ts`, `run-store.ts`, `freshness.ts`, `runtime-access.ts`, `transaction-controls.ts`, and the Phase 4 plan. Synthetic job-store/source-store/run-store tests verify local invariants; hosted and provider acceptance remains a separate checkpoint.
