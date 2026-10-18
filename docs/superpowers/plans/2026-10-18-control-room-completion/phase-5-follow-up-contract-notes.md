# Phase 5 remaining implementation contracts

This is an implementation checkpoint, not a completion claim. Publish and validate the review/notification/scheduled-review core before changing its shared schema further. Remain in Phase 5 until the following feasible work is finished and tested.

## G20 owner-reviewed baseline revisions

Keep the bundled `2026-10-17` baseline, its package hash, `baseline.apply` and existing materialized source evidence unchanged. Add immutable owner-scoped `project_baseline_revisions` containing the project, exact bundled/revision parent identity and hash, recorded/reviewed dates, prose accomplishments/blockers/unknowns, owner reason, exact observation/evidence/decision references and source watermark. A private active-head selection supplies current owner authority; imported historical revisions cannot create that selection. Restore clears the private head/grant while preserving revision IDs and history.

The explicit owner command records a reviewed revision without changing project goals/status, tasks, completion, milestone acceptance or weekly commitments. Its preview and durable editor show the old context, proposed prose, unknowns and exact selected citations. Actual source freshness requires current private configuration/state and successful native read provenance; an imported timestamp does not establish freshness. Bind selected module rows, private source revisions, execution epoch and preview editor/stream boundaries atomically. Missing proof remains dated historical context, with no invented reobservation date.

Register strict export/reference/projection adapters and a migration after 0019. Test parent/digest/citation rejection, immutable original baseline and source versions, replay, private imported authority exclusion, source/epoch races, full reviewed restore and bytewise unchanged planning.

## Concrete scheduled D1 metadata backups

The existing D1 fallback is implementable independently of real R2 or hosted wakeup access. Extend the same foundation queue with `workspace_backup` plus existing `integration_jobs.job_subject_kind='backup'`, deterministic backup ID and occurrence metadata. No second queue or fake source target is permitted.

Use `prepareWorkspaceBackup(..., 'scheduled', ...)` and its real complete-metadata serializer/hash, 1.8 MB fallback, ten-snapshot and 20 MB owner quotas. The terminal batch must bind current private principal/capability/configuration/epoch/lease, the full editor/stream/module boundary and current quota. Insert a verified READY backup and terminal occurrence, complete the same intent/attempt and update last success atomically. Reconcile lost responses by deterministic backup ID/hash/occurrence. Preserve all earlier/manual/pinned generations; never evict a backup to fit the new one. Capacity failure uses the private pause path even when portable history cannot grow.

Label this a metadata backup. Its manifest must retain all missing attachment IDs. A bound R2 attachment store does not prove object-backed workspace backup support. Test actual D1, overlapping admissions, restart/lost response, quota races, injected terminal rollback, revocation/configuration/epoch/lease races, and unchanged owner/editor state.

Source-refresh schedule execution additionally needs its separate source-read grant and selected-resource capability; automation authority alone is insufficient. Complete any feasible adapter wiring with isolated fixtures while keeping unavailable real provider activation explicit.

## Release-scale recovery

G48 growth guards are implemented for current portable writers. Existing already-oversized owners still require a compatible segmented/chunked and/or object-backed recovery path in Phase 8. Do not describe the guard as repairing those owners, raise limits without matching restore, prune records automatically or reset data.

Real renewable private-host ingress/wakeup, live provider consent/read/write access, full-file scheduled storage, optional exact paid provider/budget consent, physical Windows and selected-device acceptance remain separate gates. None is proven by the synthetic service-token fixtures or passing build.
