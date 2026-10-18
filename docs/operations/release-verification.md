# Release evidence and blocked replacement recovery

Release checks describe one exact source artifact. A passing fixture, build, ZIP, YAML file, or local protocol test is not proof of private hosted authentication, a physical Windows installation, source-provider permission, paid model identity, or complete owner recovery.

## Portable verification

From a clean checkout with the locked dependencies and Node 24 in the configured Unix cloud runtime:

    npm run install:ci
    node scripts/verify-release.mjs --target local-fixture

The runner executes the existing Node/bridge tests, typecheck, lint, build, actual isolated D1/R2 fixtures, and Chromium journeys sequentially. It stops at the first error, signal, or timeout, kills its own process group, and retains a partial sanitized report under release/verification/FULLSHA.json. It accepts no production URL, owner, database identifier, arbitrary command, or skip flag. Install the pinned Chromium dependency through the existing supported Playwright CI setup before running browser checks. Performance and external acceptance are separate gates, not implied passes. The runner does not modify package scripts or pretend an absent migration/performance runner exists; current migration assertions run within the Node suite and dedicated D1 checks.

Build output is not yet a packaged candidate. The report intentionally has artifactSha256=null. Package and upload the exact application candidate separately, with the artifact name control-room-candidate-FULLSHA and GitHub artifact v4's authoritative SHA-256 digest. An unrelated bridge ZIP is not the application artifact.

## Strict evidence recorder

The authoritative validator is lib/release-verification.ts; docs/releases/release-status.schema.json also provides a structural JSON schema. Structural validity alone is not verified provenance. The recorder uses the fixed GitHub API repository and a read-scoped GH_TOKEN/GITHUB_TOKEN; it does not print tokens, response bodies, owner content, or arbitrary remote URLs.

    node --experimental-strip-types scripts/record-release-check.mjs init --candidate control-room-reviewed-candidate
    node --experimental-strip-types scripts/record-release-check.mjs bind --candidate control-room-reviewed-candidate --run RUN_ID --artifact ARTIFACT_ID
    node --experimental-strip-types scripts/record-release-check.mjs record --candidate control-room-reviewed-candidate --check node-tests --status passed --run RUN_ID --job JOB_ID --artifact ARTIFACT_ID --step STEP_NUMBER
    node --experimental-strip-types scripts/record-release-check.mjs verify --candidate control-room-reviewed-candidate

Use actual numeric IDs, not these placeholders. Init never overwrites existing evidence. Bind requires the exact current Git commit, a completed successful real run, a nonexpired artifact with the exact candidate name/source SHA/run identity, and an actual API digest. A bound candidate cannot be rebound; a new source/artifact needs a new candidate identity. Passed gates require the actual successful completed run/job/step, exact source SHA and repository, exact current attempt job membership, matching closed command, original completion timestamp, and a nonexpired real artifact. Artifact identity binds its run/source; GitHub's artifact API does not report an attempt, so no artifact attempt is invented. Verify re-fetches candidate and every passing gate's API provenance; expired, missing, failed, forged, old-attempt, or mismatched evidence blocks verification.

The workflow "Record release gate evidence (not release acceptance)" accepts explicit real source-run identifiers and records one gate. Its final acceptance step deliberately fails while required gates are missing; uploading a partial ledger never means release acceptance. The current source candidate record remains not-run/null until an actual matching artifact exists. If recording into a new disposable workflow checkout, use a new candidate name because the checked-in initial record must not be overwritten.

No required gate is currently waivable as not-applicable. Unobserved owner/hosted/device checks remain owner-dependent or unavailable with a concrete limitation. The CI recorder cannot mark external procedures passed. A future observer adapter must verify actual external evidence before extending that contract. The independent implementation, localVerification, and hostedAcceptance fields prevent local CI from implying deployment acceptance. The initial candidate document is deliberately blocked, not a fabricated summary of prior historical runs.

To record a real limitation without a success claim:

    node --experimental-strip-types scripts/record-release-check.mjs record --candidate control-room-reviewed-candidate --check hosted-private-acceptance --status owner-dependent --reason "Requires owner gateway authentication against the exact published artifact."

## Why G48 remains blocked

The segmented metadata integrity codec and isolated D1/R2 replacement rehearsal do not define a safe general production installer. Portable modules intentionally exclude private execution and anti-resurrection authority. A general tool cannot infer these from imported history or accept a client JSON assertion that a target is safe.

| Continuity domain | Required reviewed treatment before production cutover |
| --- | --- |
| Blob fences and generations | Preserve every exact-key permanent fence, purged generation's verified digest/bytes, cleanup ownership and unsettled upload attempt; ensure no old key can become readable/writable again. Verify all advertised file bytes and bind fresh destination keys to the reviewed handoff. |
| Mutation and import tombstones | Preserve retired epochs and retained replay outcomes or provide a proven replacement namespace barrier. Old requests must never become new effects after rebinding. |
| Deletion lineage | Preserve private baseline-removal and other owner deletion semantics through a typed reviewed policy. Historical imported entity.delete text is not a current owner command. |
| Jobs, devices and grants | Fence the old execution epoch, pause every destination runtime, retain terminal/unknown outcomes and cancellation boundaries, invalidate old device/session/window authority, and require new explicit grants/credentials. Never requeue an uncertain old effect. |
| Source and operational history | Retain exact logical/source identities and frozen dates, but initialize sources stale/paused and preserve monotonic stream/history semantics. Imported enabled flags, last-success text and audit namespaces confer no runtime authority. |
| Target and cutover | Establish an authenticated fresh D1 plus private R2 target identity and prove all application/private tables and new namespace empty. Stage inactive, compare full coherent inventories, then use an expiring one-use server-held cutover token bound to source header, private continuity package, target identity and verified inventory. The owner explicitly performs the reviewed Sites D1/R2 binding handoff. |

The source must be coherently paused/fenced before capturing the final metadata/private vector. A portable client token is not this server-held authority. The current module registry has no supported exporter/importer for that complete private continuity package, and the Sites binding cutover is not implemented by these scripts. The precise blocking condition is private_continuity_package_unsupported; the 64 MiB metadata profile is an additional bounded-format limit. Keep ordinary v1 byte/row admission guards and unsupported oversized-restore messaging until the matching production path is accepted.

The isolated script only operates on disposable synthetic Miniflare state. It never installs to existing D1, changes a hosted binding, resumes an active job, restores credentials, or proves a real Windows installation. Its manual-only handoff marker must not be used as production activation authority.
