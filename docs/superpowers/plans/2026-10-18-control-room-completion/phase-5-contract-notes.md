# Phase 5 contract preparation

This records architecture review while the Phase 4 cloud acceptance rerun is pending. It is not implementation or activation evidence.

## Frozen review meaning

A review snapshot captures the editor revision, operational watermark vector and observation time coherently. Persist selected planning entity payloads inside the immutable snapshot. A planning citation identifies entity kind/ID, captured editor revision and canonical entity hash; it resolves against that frozen payload, never a current mutable row. Evidence citations use exact versions; source citations use immutable IDs and payload digests.

Audit citations distinguish editor positions `(workspaceRevision, ordinal)` from operational positions `(streamId, sequence)` and retain exact canonical event hashes and frozen citation bodies. Imported audit claims remain historical context. Facts without supported provenance become unknowns. A recorded owner completion is described as an owner record, not as independent device, operational or profitability proof.

Acknowledgements are explicit owner commands referencing exact snapshot/hash and scope. Private owner provenance must validate the acknowledgement; portable imported acknowledgements and notification read claims do not consume unread state. Restore clears this authority. Coverage includes project set, filter digest and completeness. An acknowledgement for project A cannot consume project B events. Truncated snapshots acknowledge explicit included fact/event identities, not an entire high-watermark range containing omitted records.

## One queue, typed job extensions

Keep `workspace_job_intents.status` authoritative. Generalize the existing `integration_jobs` metadata with a subject discriminator and ID; source rows retain their actual source ID. Non-source jobs have no source ID and use separate strict guards. Preserve all existing IDs, attempts, configuration hashes, revisions and leases during migration. Existing source guards retain their owner/resource grant checks and add discriminator checks.

Relaxing SQLite's `integration_jobs.source_id` requires a populated-table migration rehearsal, including attempts referencing its composite key. Do not rename an old parent such that child foreign keys silently retarget it. Exercise the actual D1-supported deferred foreign-key migration path, rollback and `foreign_key_check`; migration must not reactivate work.

Automation authority requires a separately registered, owner-bound, unexpired renewable principal with exact `automation:run` scope. It grants no provider access. Source execution retains its separate `source:read` principal and resource grants; backup execution retains complete private-storage verification. Default adapters, schedules and paid analysis remain inactive without their real capability gates.

Schedule admission maps one unique `(owner, schedule, dueAt)` occurrence to one existing intent. It does not create another queue status. Private runtime state owns next due, lease, attempts and captured configuration/epoch. Portable occurrence history includes outcomes only and never reconstructs executable work. Missed periods use bounded `latest_only`, never a backlog burst.

## Portable modules and independent verification

Proposed portable modules are review snapshots, acknowledgements, schedule definitions, occurrence history and notification events, with strict preference/policy records where needed. Operational heads include reviews and notifications. Exclude live principals, grants, leases and executable payloads. Restored schedules remain paused until explicit verified owner resume.

Deterministic briefs remain useful without AI. Optional analysis requires an exact configured provider/model, explicit budget, bounded frozen inputs and strict citation membership. No provider substitution, automatic acceptance, weekly commitment, operational execution or external message delivery is permitted. Real unattended execution and streaming remain independent hosted acceptance gates; saved configuration and fixture success cannot prove either.

Suggested first-slice limits:500 facts/snapshot,50 unique citations of each type/fact,1000 frozen planning rows,100 streams,8000 characters/fact,100 unknowns of1000 characters,2MiB canonical snapshot and bounded10000-row/8MiB assembly input. Exceeding a bound must report explicit remaining/truncated coverage; do not silently drop provenance or mark omitted facts read. Fact observation dates may be null; generatedAt is a separate server clock and never fills unknown source dates. Reuse existing evidence requirement/freshness helpers, history validation, operational watermark reading and Cairo calendar logic.

Capacity follow-up for the shared operational writer: source row-count limits alone do not guarantee the complete bundle stays below the existing8,000,000-byte export/import bound, especially after adding review/notification history. Before claiming release-scale acceptance, add a coherent owner metadata-byte budget or a separately validated segmented archive protocol. Do not silently truncate historical observations/events, prune owner records, or raise only the download bound while restore still rejects the same artifact. Keep read/export and reducing owner actions available at capacity; exercise operational growth and recovery with isolated synthetic data.
