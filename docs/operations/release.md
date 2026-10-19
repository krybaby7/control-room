# Private release procedure

The completion source is not an accepted new hosted deployment. Preserve the existing private Site identity, owner-only access, D1/R2 bindings and owner records. Current implementation, cloud verification and hosted/device acceptance are separate states. Do not clear a release gate from an earlier source's passing run.

## Build and bind one candidate

Use Node 24, the lockfile and the configured supported cloud runtime. The canonical commands and evidence recorder are in [release verification](release-verification.md):

```sh
npm run install:ci
node scripts/verify-release.mjs --target local-fixture
```

The runner stops on a real failure and retains partial evidence. Browser dependencies use the existing pinned CI setup. Controlled performance, migration/oversized recovery, actual R2, private hosting and owner devices retain their separate required evidence. A build alone is not a packaged application candidate; bind the exact application artifact name/digest and source SHA using the recorder. Never bind an unrelated bridge package or infer an artifact digest.

Record each terminal gate against its actual source, run/job/step, artifact, environment and original completion time. Missing or failed gates stay blocked. Only an actual owner/operator observation can supply the separate hosted/device attestation; GitHub success cannot impersonate it. Re-fetch and verify provenance before declaring acceptance. Never commit owner data, secrets, private traces or provider transcripts to the ledger.

## Reviewed publication and rollback

Before publication, retain a verified complete recovery point and inventory the current deployed version, schema/migration journal, bindings and owner access. Applied migrations are append-only; rehearse compatible upgrades and actual isolated recovery. Stop if counts/hashes, owner isolation, physical bytes or exact artifact identity do not match.

Use only the supported Sites publication workflow when helper execution and required authentication are available. Do not create a replacement public Site, change privacy, run a raw hosting CLI against guessed bindings or bypass a failed deployment check. Verify the terminal deployment, exact artifact/version, owner login, anonymous denial and non-destructive read/export against the existing private identity afterward.

Rollback the application only to a build that understands the current expanded schema and side tables. Prefer a compatible redeployment/forward fix; never apply destructive down migrations or seed/reset production. Data replacement is a separate privileged inactive-target procedure with reviewed manual binding handoff, not an automatic release rollback. See [backup/restore](backup-restore.md).

## Remaining external acceptance

The owner/operator supplies interactive sign-in/passkey handling, actual private staging/production access and supported Sites execution. Physical Windows/mobile checks must name the actual device/OS/browser and procedure; emulation is separate. Real provider/resource permission, renewable ingress/device credentials, storage binding, installed pinned runtime/sandbox/process supervisor and any paid-model approval require their own explicit acceptance.

Leave paid inference, external notifications and trading/exchange effects disabled. No planning UI, evaluation summary or release test authorizes them. A final handoff identifies exact source/artifact/deployed version, completed gates, failed or unavailable checks and the next concrete owner action. Do not call the release fully verified while required hosted/device or performance gates remain pending.
