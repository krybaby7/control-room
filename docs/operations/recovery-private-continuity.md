# Privileged recovery continuity component

This component captures and validates private anti-resurrection data. It does not install a database, freeze a source, grant execution, restore a credential, or authorize a Sites binding cutover. A matching digest proves the trusted package identity; package contents never become authority.

The APIs are:

- captureRecoveryPrivateContinuity(db, owner, {manifestSha256, ownerContextHash, sourceContext}, now): privileged read-only capture against authenticated injected D1 bindings.
- validateRecoveryPrivateContinuity(raw, {sha256, manifestSha256, ownerContextHash, sourceContext, ownerId}): strict closed schema, source identity, root digest and cross-reference validation.
- assessPrivateRecoveryContinuity(value): sanitized, explicitly non-installable assessment.
- capturePrivateRecoveryInspection({...bindings, writePrivatePackage}) from scripts/inspect-recovery-private.mjs: writes only through an injected controlled private package writer.

sourceContext contains the frozen workspace revision, execution epoch and complete operational watermark vector. All expected identities must come from the authenticated operator's trusted source header, not from the package being inspected. Capture clones those expectations before awaits. It verifies the source context and namespaces before/after, rereads every captured row, rejects unknown physical columns, and checks original deletion rows again. Equal scans detect observed drift; they do not prove a source remained frozen after the scan.

The closed package retains exact attachment cleanup fences, physical object identities (including purged generations), unsettled upload attempts, namespace provenance, archive cleanup claims, mutation epochs and legacy receipts, original owner task/capture deletion events, queue intents, agent state, approval history, attempt journals, immutable event receipts, device slots, finite budget counters and artifact identities. Credentials, enrollment secrets, cursor secrets, capabilities, access/owner acceptance grants, source/schedule authority and arbitrary private tables are rejected. Original private IDs, dates, event payloads, hashes and unresolved records remain intact; no row is silently dropped or repaired.

All data is bounded to 100,000 rows and 64 MiB. Pages are deliberately small because individual journal/event JSON fields may be large. An unsupported schema or larger package fails explicitly. No schema or production registry is changed.

The validator checks exact physical key identities, mutation retirement state, native deletion provenance, journal/spec/binding identities, consumed approval reservations, event digests and original receipts, occupied unknown-attempt slots, and finite reservation lower bounds. A historical imported deletion claim cannot become a private removal fence. Approval bodies are retained only as private history; the component has no API to install them as live grants.

## Inspect an existing controlled package

Use Node 24 and the locked dependencies:

    node --experimental-strip-types scripts/inspect-recovery-private.mjs --package /controlled/private-continuity.json --sha256 EXPECTED_PRIVATE_SHA --manifest EXPECTED_MANIFEST_SHA --owner-context EXPECTED_OWNER_CONTEXT_SHA --source-context '{"workspaceRevision":1,"executionEpoch":0,"operationalWatermarks":{"sources":0}}' --owner-id AUTHENTICATED_OWNER_ID

The command opens a bounded regular file without following its final symlink, requires all independent trusted expected identities, and emits only digests/counts/blocking codes. It exits 2 for a structurally valid inspection that cannot install, and 1 for rejected input. Neither is a successful restore. Do not commit the private input, original owner IDs, journal/token hashes or raw audit evidence to the release ledger.

## Required integration before an inactive replacement installer

A privileged source-freeze adapter still must provide a durable, independently checked freeze receipt. Triggers or another proven database barrier must cover every user-owned write table and all old/new owner identities, not only portable module rows. Existing R2 write/delete grants must settle before locking; ambiguous writes cannot be marked settled from elapsed time. Source freeze must prevent new grants throughout capture, byte verification and the eventual reviewed handoff.

The private package is intended to feed a separately reviewed target transformer: fresh empty inactive D1/R2 only; retire all prior mutation epochs; preserve legacy replay tombstones and baseline removals; bump the workspace execution epoch; cancel unattempted pending queues; retain active/unknown attempts, journals, event receipts, occupied slots and budget reservations as reconcile_required; revoke approvals and disable all execution/configuration authority; never restore credentials/capabilities/access grants or automatically resume schedules. Exact-key blob fences and trusted purged identities must remain rejecting. Verified live attachment bytes need a reviewed fresh-namespace/quota handoff bound to the same manifest and private root.

This component deliberately does not emit that transformer as an installable SQL plan before the freeze, private namespace/quota, empty-target and one-use cutover protocols are implemented and exercised on actual D1/R2. Current blocker codes include source_freeze_unverified, inactive_target_and_cutover_authority_unimplemented, unsettled_upload_attempts, physical_namespace_handoff_unsupported and purged_identity_unverified. G48 is not closed by an inspection pass or a synthetic fixture.
