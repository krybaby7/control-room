# Existing private Site handoff

This procedure does not represent a deployment. The existing private Site remains active version 2. Resolve the implementation branch and its exact terminal verification/artifact records before selecting a release. Do not treat an UNVALIDATED diagnostic artifact as release acceptance.

## Continue the supported execution path

The managed cloud command runner and installed Sites source/package helpers are restored. Reuse the existing helper-opened private checkout and saved opening result; do not create a replacement Site. Keep the supported explicit `gpt-6.1-sol` selection for implementation/review workers. Do not move implementation into the original Windows checkout or substitute another model.

Check out the verified public source commit in cloud execution and use Node 24 with `npm run install:ci`. Reconcile all required gates against that exact source. Preserve the original hosting manifest and applied migrations. Obtain a verified complete backup/inventory of the existing owner workspace before a compatible upgrade; no reset, replacement Site or automatic recovery cutover is authorized by packaging.

## Open the existing Site source

Read its existing project identity from `.openai/hosting.json` locally; never copy the value or credentials into a checkpoint. Refresh native Sites metadata and confirm the audience remains the existing owner only. Use `create_source_repository_write_credential` for that same existing Site.

Run the installed helper in a terminal with hidden stdin:

```text
node <absolute-installed-plugin-root>/scripts/site-workflow.mjs --project-id <existing-project-id>
```

After its ready message, provide one newline-terminated JSON object through stdin with the returned credential object. Omit `archivePath` while opening. Retain the complete opening result and use its returned checkout. The helper owns source-repository preparation; do not invent a remote or put credential values in arguments, files, logs or public Actions.

Apply only the reviewed candidate source to that helper-opened checkout. Preserve the existing hosting identity, original D1 binding and owner access. Git history and source commit identities differ between the public implementation repository and the private Site source repository: record the public candidate SHA and the exact private helper commit separately, with a source comparison. Do not assume the public SHA already exists in the private history. Never copy owner records, runtime state, credentials or Git metadata from another checkout.

## Validate, package and publish one coherent release

The current native read-only DB interface truncates the existing workspace value, so it cannot produce a complete verified pre-cutover snapshot. Obtain a complete owner/provider export or snapshot of the existing workspace, mutation and recovery tables, verify its counts/content integrity and rehearse recovery in isolation before any deployment. Keep snapshots private. Do not substitute the truncated projection, a new empty database or a synthetic recovery test. A validated source release may be saved without deployment while this gate is blocked.

Use the same source helper with its complete prior `source` result, the same credential via hidden stdin, ordered remaining check/build argument arrays, and an absolute output `archivePath`. Framework builds use the installed `build-site.mjs` helper. Reuse checks only when their exact inputs remain unchanged; a source/build archive produced by the public GitHub packaging script is review material, not a substitute for the supported Sites helper archive.

Provision any required private R2 binding only through the supported existing-Site storage workflow; preserve D1 and confirm binding identities. Until that storage/provider/ingress acceptance passes, dependent live file and unattended features remain unavailable. Do not infer working storage from a fixture or manifest declaration.

For the confirmed owner-private audience, pass the helper's actual `project_id`, `commit_sha` and unchanged `archive` directly to `save_version_and_deploy_private`. If that combined operation is unavailable, use the supported save-version then private-deploy operations. Preserve any returned saved version and resume an existing deployment rather than creating duplicates.

Poll deployment status only while pending/building/publishing. Record the terminal result, literal deployed URL, saved/deployed version and actual private source commit. Then verify owner sign-in, anonymous denial and non-destructive read/export against that release. A failed or unavailable gate remains recorded as such. Do not publish an incoherent or failed candidate.

## Separate required owner/provider work

- Use the inspected actual upstream interface and the original read-only projection adapter after its source gates pass. The approved private pinned runtime extraction, Windows owned-process integration and provider-native sandbox flag policy are implemented. Cloud tests cover the package/protocol/process boundaries; actual provider sandbox enforcement has not been tested. Production invocation still requires the exact reviewed private package installation, matching local configuration and real owner-device/provider acceptance. Installing the public bridge alone does not install the private runtime. Keep private upstream source, installation pins, paths and credentials private. Changes that extract/package code in another private repository require that repository's separately authorized workflow; do not publish it into this repository.
- Install the source-identified Windows package on the owner device using its protected credential and Task Scheduler procedure. Verify actual collection, offline/reconnect, renewal and revocation; cloud Windows synthetic ACL/DPAPI tests do not attest to that device.
- Connect only explicitly selected provider resources with their real consent, and verify renewable private ingress and any hosted SSE implementation. Closed-browser scheduling needs actual renewable wakeup/runner acceptance.
- Complete physical phone/tablet/browser/passkey checks using the device checklist. Record observations without inventing a device, result or consent.
- Keep paid inference disabled until one exact provider/model and spending budget are configured. Keep operational/trading effects and external alert delivery disabled unless separately authorized.
