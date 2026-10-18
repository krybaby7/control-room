# Recovery and scheduled backup boundaries

Implemented core and isolated-fixture checks: 18 October 2026. This document distinguishes recovery code from externally activated backup service operation. No real unattended service principal, closed-browser scheduled run, private R2 binding or physical-device recovery has been verified by these core tests.

## Recoverable data and safe review

Download a fresh workspace bundle before substantial changes. Bundles contain planning and every registered normalized module, immutable audit provenance and explicit attachment completeness. Populated normalized owner tables without an adapter block export instead of disappearing. Audit actor metadata uses the semantic pseudonym `owner`; authenticated owner IDs stay in the internal ledger. Treat exported bundles as private user data. User-authored notes may themselves contain sensitive text. Credential/approval/receipt/job authority is never portable import authority.

The current attachment manifest is empty and completeness is `metadata-only`. An empty manifest permits complete recovery of current structured records; it does not establish a backup of attachment bytes. Once attachment records exist, destructive recovery must pin verified immutable bytes or reject the operation. D1 fallback rejects attachment-bearing recovery until that adapter exists.

Imports remain quarantined until explicit owner review and commit. Invalid UTF-8/JSON, unsupported module versions, malformed metadata and broken references stay separate from active planning. Preview content hash and target revision bind the review; a changed workspace requires a fresh preview. Download or cancel quarantined content as needed. Never reconstruct a restore from a client-edited summary. Restore integrations must use the sole command transaction executor, retain a complete pre-change recovery point, preserve existing receipts, append imported audit source claims and invalidate execution authority as required by the recovery transaction.

Server draft retention and optional trusted-device storage are described in [privacy.md](privacy.md). Memory-only drafts disappear with the page; explicit device persistence is subject to browser profile access and eviction. Reconnection does not automatically replay uncertain commands.

## Snapshot limits and removal

D1 structured fallback retains at most ten snapshots and 20,000,000 total bytes per owner. Each bundle is bounded to 1,800,000 bytes for this implementation; chunked backup storage has not been added. A full quota blocks a new protected operation and preserves existing snapshots. Manual and pinned snapshots are never silently removed. The legacy single `workspace_recovery` row remains preserved during rollout; its existence is not evidence that growing normalized modules or attachment bytes are recoverable from that historical row.

Snapshot reads verify exact UTF-8 byte count, SHA-256, bundle schema and source revision before recovery use. A corrupt, missing, incomplete or unsupported snapshot is unavailable, even if its database status says ready. Explicit snapshot removal requires another independently verified ready recovery point with a newer source revision, or a later creation timestamp at the same revision. The command compiler must reassert those conditions atomically. Removing a backup does not create a recursive backup of that backup.

## Scheduled policy core

`createBackupPolicy` defaults to disabled. Policy uses `Africa/Cairo`, local `03:00` daily, Monday weekly retention, fourteen daily points and eight weekly points. `nextBackupDue` uses the runtime IANA timezone data through `Intl`, including Cairo midnight daylight-saving transitions; it never assumes a permanent UTC offset. It returns the next occurrence strictly after the supplied clock. A delayed runner may process an older admitted occurrence; it does not infer successful runs for missed dates.

Enabling requires both a renewable authenticated runner with a registered owner mapping and backup scope, and verified complete private object storage. Capability flags must be derived from actual integration evidence, never a browser request or the presence of an untested binding. This core has no production policy API, scheduler registration, autonomous timer or independently populated queue.

`runBackupJob` consumes only an existing policy-admitted intent through the shared job-intent/lease adapter. It resolves the actual registered service principal and requires its owner mapping and `backups:write` scope. An anonymous endpoint or a submitted owner ID cannot authorize it. The dedupe key hashes owner plus scheduled occurrence, so redelivery with another delivery ID refers to the same intent.

The adapter must atomically enforce existing intent admission, lease/claim ownership, policy state, execution epoch and owner scope. Before storage writes, the attempt stores an immutable preparing manifest under its claim. The consistent export adapter must call the complete module registry snapshot implementation. Object bytes, length, digest, bundle schema and source metadata are verified before the ready manifest and last success/next due are committed. `commitReady` must atomically assert the expected workspace revision, claim, quota and current enabled policy; a failed assertion leaves no success record. Failure handling must CAS its attempt state/backoff and preserve preparing references for reconciliation.

A crash after upload may leave a preparing object. Redelivery reconciles the exact immutable object and digest before attempting the ready commit. A changed source or a corrupt/missing ready object fails visibly. A source conflict requires the shared job adapter to retire/reconcile the failed attempt before admitting a fresh preparation; do not overwrite an immutable key or falsely claim the old snapshot protects a newer revision. Orphans may be collected only after the configured recovery grace period and an authoritative reference check coordinated against manifest commits.

`retentionPlan` produces candidate IDs only after a newly verified ready recovery point exists. It preserves manual/pinned points, the new point, fourteen daily dates and eight Monday dates, and never offers a point without a newer verified recovery point. It performs no deletion. The integration must reverify candidates, ready objects and newer protections immediately before atomic removal; deletion must not race a manifest reference or remove the sole usable recovery point.

## Activation and acceptance still required

1. Provision the intended private R2 binding without changing hosted audience or Site identity; verify an isolated put/get/head/delete round trip and deliberate missing/corrupt object failure.
2. Register a renewable service principal mapped to the correct owner with narrowly scoped backup access. Verify actual private ingress and application authorization; signed-in browser access alone is insufficient.
3. Implement the shared durable intent, claim, staging and ready-commit adapters with atomic revision/quota checks and persisted failure/backoff state. Wire policy changes through the owner command boundary and register a supported scheduler.
4. Exercise a real closed-browser scheduled run, duplicate delivery, delayed occurrence, lease expiry, partial upload, source conflict and runner restart. Confirm the exact resulting object and ready manifest independently.
5. Rehearse recovery against isolated synthetic data, including all registered modules and available immutable attachment bytes, before describing scheduled protection as healthy.

Until these steps pass, present scheduled backup as unavailable or disabled. Injected fake storage and CAS tests prove core behavior only; they are not hosted storage, authentication or scheduler acceptance evidence.

## Receipt maintenance

Legacy receipt IDs remain permanent. New mutation epochs also retain permanent retired-epoch tombstones; restoring a workspace cannot reactivate an epoch. Detailed receipts may be compacted only through explicit internal maintenance after retirement. The implementation first checks unexpired server drafts for references to that epoch, blocks malformed drafts, and atomically reasserts the exact draft row set and retired tombstone before deletion. An added or changed draft blocks compaction. There is no automatic compaction, automatic retirement or public maintenance endpoint. Browser-only copies cannot be enumerated by this server check; their retired IDs still receive a rejecting outcome and must never be silently replaced with fresh commands.
