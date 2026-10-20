# Backup and restore

A backup is usable only within its declared completeness and after verification. Metadata JSON does not contain file bytes. Scheduled code and isolated fixtures do not establish an active hosted backup schedule or a measured production recovery objective.

## Keep and verify a recovery point

Use the owner backup browser (`GET /api/workspace/backups`) to inspect source revision, creation time, reason, digest, status and file completeness. D1 metadata snapshots are bounded to ten snapshots and 20,000,000 bytes per owner, with 1,800,000 bytes per metadata bundle. File archives share that backup quota; retained unpurged generations remain charged. There is no automatic eviction.

For an independent private copy, use structured JSON export (`GET /api/workspace/export`) or the native file-inclusive ZIP (`GET /api/workspace/export/archive`). Keep the original download in owner-controlled private storage. The native ZIP must contain the advertised ready files and validate its manifest, lengths, SHA-256 and ZIP integrity. A missing, fenced or corrupt file blocks complete export; metadata is not replacement proof of its bytes.

A stored ready file backup can be downloaded through `GET /api/workspace/backups/<id>/archive`. Verify the actual downloaded bytes before relying on it. Preparing, failed, retired or unresolved physical writes must not be relabelled ready. An unknown PUT keeps its nonexpiring pending token until definitive settlement; time passing does not settle it.

## Review a restore

1. Retain the current export and the original recovery input.
2. Upload through Sources import review. JSON and native ZIP have separate bounded staging routes; staging is not an active workspace mutation.
3. Review exact input hash, completeness, references and target revision. Explicit repair creates a child preview and preserves the parent; an archive cannot be repaired as ordinary JSON without losing its verified archive binding.
4. Explicitly approve the reviewed replacement. A conflict requires a fresh preview. An uncertain commit first reconciles the original mutation ID, never a second restore identity.
5. Verify the resulting saved records, history and actual private file downloads. Logical IDs remain stable; restored physical files receive fresh keys. Imported provenance remains historical/proposal data rather than native owner or execution authority.

A restore creates its protected pre-restore recovery point and rotates operational execution authority. Unknown attempts retain reconciliation state, slots and reservations. It does not silently resume schedules or reset mutation-receipt history.

## Removal, scheduling and larger recovery

Protected removal requires a newer independently verified recovery point with the needed completeness. Use the explicit guarded owner actions; never delete bucket keys or metadata rows directly. Retired/retained file cleanup is reviewed through `/api/workspace/backups/retired-files`; retired-epoch reauthorization requires a verified newer complete archive. Permanent cleanup claims remain rejecting after deletion.

Metadata and file-inclusive scheduled backup implementations require current registered authority, actual storage services and terminal verification. No real hosted unattended occurrence or restore has been accepted for this candidate. Do not advertise a 24-hour loss or 60-minute restore guarantee without measured evidence.

For a larger owner, follow [recovery maintenance](recovery-maintenance.md), [private continuity](recovery-private-continuity.md) and [release verification](release-verification.md). The implemented bounded operator path freezes the actual source, installs into a fresh inactive target, preserves private uncertainty and independently verifies rows and bytes. It does not switch Sites bindings. The owner/operator must supply trusted original and replacement D1/R2 access, retain rollback state and perform a separately reviewed manual handoff. Stop on any missing original, incompatible schema, foreign-owner inventory or failed seal.
