# Privileged recovery continuity component

This component captures and validates private anti-resurrection data. It does not install a database, freeze a source, grant execution, restore a credential, or authorize a Sites binding cutover. A matching digest proves the trusted package identity; package contents never become authority.

The APIs are:

- captureRecoveryPrivateContinuity(db, owner, {manifestSha256, ownerContextHash, sourceContext}, now): privileged read-only capture against authenticated injected D1 bindings.
- validateRecoveryPrivateContinuity(raw, {sha256, manifestSha256, ownerContextHash, sourceContext, ownerId}): strict closed schema, source identity, root digest and cross-reference validation.
- assessPrivateRecoveryContinuity(value): sanitized, explicitly non-installable assessment.
- capturePrivateRecoveryInspection({...bindings, writePrivatePackage}) from scripts/inspect-recovery-private.mjs: writes only through an injected controlled private package writer.

sourceContext contains the frozen workspace revision, execution epoch and complete operational watermark vector. All expected identities must come from the authenticated operator's trusted source header, not from the package being inspected. Capture clones those expectations before awaits. It verifies the source context and namespaces before/after, rereads every captured row, rejects unknown physical columns, and checks original deletion rows again. Equal scans detect observed drift; they do not prove a source remained frozen after the scan.

The closed package retains exact attachment cleanup fences, physical object identities (including purged generations), unsettled upload attempts, namespace provenance, archive cleanup claims, mutation epochs and legacy receipts, original owner task/capture deletion events, queue intents, agent state, approval history, attempt journals, immutable event receipts, device slots, finite budget counters and artifact identities. Credentials, enrollment secrets, cursor secrets, capabilities, access/owner acceptance grants, source/schedule authority and arbitrary private tables are rejected. Original private IDs, dates, event payloads, hashes and unresolved records remain intact; no row is silently dropped or repaired.

The private profile is bounded to 200,000 rows globally, 100,000 per private table and 64 MiB. Pages are deliberately small because individual journal/event JSON fields may be large. An unsupported schema or larger package fails explicitly. No schema or production registry is changed.

The validator checks exact physical key identities, mutation retirement state, native deletion provenance, journal/spec/binding identities, consumed approval reservations, event digests and original receipts, occupied unknown-attempt slots, and finite reservation lower bounds. A historical imported deletion claim cannot become a private removal fence. Approval bodies are retained only as private history; the component has no API to install them as live grants.

## Inspect an existing controlled package

Use Node 24 and the locked dependencies:

    node --experimental-strip-types scripts/inspect-recovery-private.mjs --package /controlled/private-continuity.json --sha256 EXPECTED_PRIVATE_SHA --manifest EXPECTED_MANIFEST_SHA --owner-context EXPECTED_OWNER_CONTEXT_SHA --source-context '{"workspaceRevision":1,"executionEpoch":0,"operationalWatermarks":{"sources":0}}' --owner-id AUTHENTICATED_OWNER_ID

The command opens a bounded regular file without following its final symlink, requires all independent trusted expected identities, and emits only digests/counts/blocking codes. It exits 2 for a structurally valid inspection that cannot install, and 1 for rejected input. Neither is a successful restore. Do not commit the private input, original owner IDs, journal/token hashes or raw audit evidence to the release ledger.

## Separate privileged installer boundary

The implemented [operator-only recovery maintenance protocol](recovery-maintenance.md) provides database-wide source fencing, authenticated maintenance receipts and inactive-target writes. Its triggers cover the closed application schema, not only portable module rows. Existing unsettled PUTs block the freeze; ambiguous writes cannot be marked settled from elapsed time. Exact old cleanup keys remain excluded from fresh byte copies. A source package or inspection result cannot replace these actual database-bound proofs.

The separate privileged [`installRecoveryPrivateContinuity`](../../lib/recovery-install.ts) and `installRecoveryIntentRoots` helpers accept actual source/target maintenance receipts and independently recapture the frozen private root. Their closed target transformation requires fresh empty inactive D1/R2. It retires prior mutation epochs, preserves legacy replay tombstones and baseline removals, bumps the workspace execution epoch and cancels unattempted pending queues. It retains active/unknown attempts, journals, event receipts, occupied slots and budget reservations as reconcile_required, revokes approvals and disables execution/configuration authority. It never restores credentials/capabilities/access grants or automatically resumes schedules. Exact-key blob fences and trusted purged identities must remain rejecting. Verified live attachment bytes need a reviewed fresh-namespace/quota handoff bound to the same manifest and private root.

The inspection API remains deliberately non-installable and emits no SQL plan or execution authority. Its conservative blocker codes, including source_freeze_unverified, inactive_target_and_cutover_authority_unimplemented and physical_namespace_handoff_unsupported, describe proofs that the inspection-only component cannot provide; they do not mean the separate fenced installer is absent. The maintenance and segmented D1/R2 rehearsals exercise those privileged helpers with synthetic disposable bindings. A deployed Sites D1/R2 cutover, private physical access and reviewed manual binding/unfence handoff remain separate operator requirements. G48 is not closed by an inspection pass or a synthetic fixture.
