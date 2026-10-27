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

No required gate is currently waivable as not-applicable. Unobserved owner/hosted/device checks remain owner-dependent or unavailable with a concrete limitation. GitHub CI evidence cannot mark hosted/device procedures passed. Those two gates use the separate, explicitly owner/operator-authored observed-attestation record described below; it is a reviewed observation, not automated proof of physical behavior. The independent implementation, localVerification, and hostedAcceptance fields prevent local CI from implying deployment acceptance. The initial candidate document is deliberately blocked, not a fabricated summary of prior historical runs.

To record a real limitation without a success claim:

    node --experimental-strip-types scripts/record-release-check.mjs record --candidate control-room-reviewed-candidate --check hosted-private-acceptance --status owner-dependent --reason "Requires owner gateway authentication against the exact published artifact."

## Bounded private recovery and reviewed cutover

The source implements a privileged 46-table continuity profile in addition to ordinary portable modules. This is an operator-only inactive replacement path, not an HTTP restore permission or an automatic production binding switch.

The source database must be globally frozen through the actual trusted database handle before capture. Unknown populated tables, foreign-owner records, unsettled physical writes, incompatible columns/defaults and unsupported workspace configuration fail closed. No imported JSON can assert that a source or target is safe.

The profile preserves original native audit and record IDs, replay/retirement boundaries, private owner attribution, drafts, physical fences and retained generations, source/automation/job histories, dated telemetry, raw import chunks, archive stages and unknown paid-analysis charges. Destination runtimes remain paused, devices and sessions lose authority, leases are cleared, and unresolved effects retain their uncertainty and reservations. New explicit credentials and owner approval are required before execution.

Complete current attachments and ready backup chunks require actual byte, length, signature and digest verification. Fresh destination keys receive write-ahead physical accounting; permanent source fences and generations remain preserved. Original staged files are copied to explicitly supplied private operator artifacts with a verified manifest and receipt. Incomplete stages are labelled inspection-only; these artifacts do not silently become portable imports or accepted proposals.

An independent seal compares the actual frozen source and inert target rows. Additional fresh physical rows are allowed only through the exact server-held byte-verification mapping. Reconstructed intent roots are installed before dependent job rows. Ordinary application quota guards remain enabled; this bounded profile does not promise unlimited history or evict originals to fit.

The synthetic segmented D1/R2 rehearsal exercises this path on disposable data. Its result proves only its recorded source version and fixture. A production migration still requires a compatible exact-owner inventory, trusted operator access to the existing and inactive replacement D1/R2, preserved rollback state, and an explicit reviewed Sites binding handoff. These scripts never reset existing owner data, resume jobs, restore credentials or automatically switch hosted bindings. See [recovery maintenance](recovery-maintenance.md) and [private continuity](recovery-private-continuity.md).

## Explicit hosted/device observation record

Only after a real observation, author a bounded JSON record under
`docs/releases/CANDIDATE/observations/NAME.json`. The closed format is
`control-room-observed-release-attestation`, version 1. It contains exact
`candidate`, `sourceCommit`, the complete bound `artifact` descriptor,
`checkId` (`hosted-private-acceptance` or `owner-device-acceptance`),
the gate's exact `environment` and `procedure`, `result: "passed"`,
actual `observedAt`, `observerRole` (`owner` or `authorized-operator`)
and 1–32 bounded plain-text `observations`. Copy procedure/environment
from the closed gate contract; do not invent a shorter substitute.
Record only sanitized device/browser/procedure results, not credentials,
private account identifiers, paths or content. Do not create a record merely
to clear a blocked gate.

Review the record separately and retain its SHA-256 over canonical JSON
(`lib/canonical-json.ts`). Then explicitly record that reviewed digest:

    node --experimental-strip-types scripts/record-release-check.mjs observe --candidate CANDIDATE --attestation docs/releases/CANDIDATE/observations/NAME.json --sha256 EXPECTED_CANONICAL_SHA

The command requires the exact already-bound candidate checkout. Unknown
fields, a future observation time, a changed canonical digest, another
candidate/artifact/gate or a symlinked observation path are rejected.
`verify` rereads that exact file and digest; a GitHub run cannot impersonate
this evidence kind. A hash detects later changes; it does not authenticate
an author's real-world observation or establish a provider effect.
The owner/operator remains responsible for the truth of the explicit record.

Isolated oversized-recovery and controlled-performance results can instead
be bound to their exact dedicated GitHub workflow/job/step and source artifact.
They remain fixture evidence with the scope of the actual report, never
hosted/device acceptance. Aggregate status is derived without deleting valid
observations when another gate is recorded; missing or failed gates still
block acceptance. No command automatically marks implementation complete.

Main's required checks are `verify`, `benchmark`, `browser-performance`, `native`, `stream-contracts`, and `Native acceptance - chromium`, `Native acceptance - firefox`, and `Native acceptance - webkit`. Workflows that normalize push and pull-request runs to the same head repository and branch include `github.event_name` in their concurrency groups so opening a PR preserves required push checks; newer runs of the same event still cancel older runs.
