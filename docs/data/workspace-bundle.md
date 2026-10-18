# Workspace bundle and quarantine contract

Reconciled against the foundation implementation on 18 October 2026.

## Bundle schema

A bundle has exactly `format: 'control-room'`, `bundleVersion: 1`, `exportedAt`, `source`, `planning`, `modules`, `attachments` and `completeness`. Bundle, planning and module versions are independent. Planning v1/v2 imports migrate through the deterministic v3 chain, preserving existing identities and available saved-time history. Unsupported future versions and unknown modules fail closed.

`source` contains exactly `workspaceRevision`, `planningSchemaVersion`, `moduleWatermarks` and `sourceHashes`. Map entries use only `planning` or included module names and lowercase SHA-256 digests. Empty maps remain supported for legacy metadata-only previews. Source hashes are provenance, not authorization. Each module wrapper contains exactly `schemaVersion` and `records`. Normalized owner rows contain exactly `id`, `rowRevision`, `contentHash` and `value`; IDs are 1–128 characters, revisions are positive integers, hashes are lowercase SHA-256 digests, and values pass portable JSON and feature-schema validation. Unknown metadata and authority/credential fields are rejected. Import commit recomputes normalized value digests before preparing replacement writes.

Bounds are 8,000,000 serialized UTF-8 bytes, 10,000 records per module and 40 levels of portable JSON nesting. The closed server registry determines SQL identifiers and owner predicates. The default registry exports planning plus `audit_events` v1. Feature modules require explicit schema/reference adapters. A populated owner table without an adapter blocks export rather than disappearing; arbitrary configuration or provider credentials are not implicitly exported.

## Snapshot consistency and completeness

Export reads owner revision/planning, scans each registered module in pages of at most 200, repeats those module scans, then rereads owner revision/planning. A changed revision or module row snapshot retries, at most three attempts. Normalized snapshots include row versions and hashes, independently detecting mutable module changes. Audit scans include owner-command and operational events. Content-hash watermarks describe observed module snapshots; they do not imply a single global operational sequence or prevent changes after the final observation.

The attachment manifest is currently empty and completeness is `metadata-only`. This can cover every current structured record while containing no attachment bytes. It must never be called an attachment backup. Nonempty manifests are rejected until verified attachment storage/recovery is implemented. Attachment-bearing destructive recovery must retain actual bytes or verified immutable object pins; metadata alone is insufficient.

Audit import is append-only historical provenance. Namespaced imported records preserve source claims while retaining the target ledger. Portable audit actor metadata is recursively pseudonymized to `owner`; internal authenticated actor metadata stays in the ledger. Historical completion, acceptance, weekly and actor claims do not become present-day owner decisions. Credentials, authentication/device keys, receipts, executable approvals and job authority are not importable modules.

## Durable quarantine and repair

`ImportQuarantine` is the process-local parser/review core. `import-staging` persists owner-scoped metadata and immutable raw-byte chunks separately from active planning. Durable limits are eight stages and 20,000,000 raw-content bytes per owner, 8,000,000 bytes per input, 256 KiB raw chunks and one-hour stage expiry. Reads verify chunk order, length and exact raw SHA-256 before reparsing with fatal UTF-8 decoding. Invalid bytes remain downloadable while the stage is available. Expired stages are unavailable and cleanup may remove their records.

Repair creates a new child stage with parent ID/hash and a bounded report chain, retaining the source unchanged until its own expiry or explicit discard. Report chains allow at most eight reports and 1,500,000 serialized report bytes. The source must still exist with its expected hash when the child is staged. Supported explicit operations are migration, project-reference mapping, broken-dependency removal, exact duplicate-occurrence rename and selected-record exclusion. Excluded records remain in the report. Ambiguous references are rejected instead of guessed, and unknown modules are preserved for diagnostics. A repair can remain invalid and requires a new preview; it never accepts evidence, invents completion dates or automatically commits planning.

Preview reports counts, added/deleted/changed identities, module versions, target revision, backup availability and attachment completeness. The final owner command binds the server-held staged bytes/hash and target revision; a client-edited summary is not restore authority. Replace derives module writes from validated server content; planning merge requires explicit selection and records source lifecycle claims as provenance. Unsupported normalized merge fails closed. All active changes use the shared command transaction, retaining a pre-change recovery bundle, preserving receipts, appending historical claims and advancing execution invalidation state where required. Running external work still requires actual outcome reconciliation; a restored document cannot prove a process stopped.

## Recovery storage and replay protection

D1 fallback recovery contains the complete registered structured bundle, with at most ten snapshots and 20,000,000 bytes per owner. Each fallback bundle is limited to 1,800,000 bytes; chunked backup storage is not implemented. Full quotas reject a new protected operation and retain existing manual/pinned snapshots. Reads verify byte count, digest, schema and source revision. Explicit removal requires another verified ready newer recovery point. The earlier single recovery row remains preserved and is not a substitute for a complete normalized recovery bundle.

Legacy receipt IDs are retained permanently. New IDs use a server-issued mutation epoch. Retiring an epoch first persists its permanent rejecting tombstone; delayed requests from it cannot execute, even after detailed receipts are compacted or an older workspace is restored. Explicit internal compaction requires an existing retired tombstone, rejects unexpired server drafts referencing that epoch, blocks malformed drafts and rechecks the draft row set atomically. There is no automatic retirement/compaction or client maintenance endpoint. Browser-only drafts cannot be enumerated by the server; a retired epoch still rejects their delayed requests.

Local tests do not establish hosted gateway authorization, live provider/device behavior, attachment recovery or an unattended R2 scheduler. See [recovery operations](../operations/recovery.md) and [draft privacy](../operations/privacy.md) for exact activation and privacy boundaries.
