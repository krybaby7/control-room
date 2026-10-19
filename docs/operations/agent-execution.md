# Agent execution operations

Production execution status: **not_installed and disabled**. The Windows bridge package is version 0.2.0; it includes execution-policy, coordinator, authenticated-wire, journal, workspace and artifact code. It does not include a supported subscription runtime, provider executable, model, Windows Job Object supervisor or verified sandbox. An opt-in flag does not install these dependencies or authorize a launch.

## Implemented boundaries and evidence

| Boundary | Implemented behavior | Verification limit |
| --- | --- | --- |
| Owner coordination | Immutable job specification, exact approval/binding, dependency checks, finite reservation, lease/epoch/cancellation and reconciliation | Server and synthetic fixtures do not prove a local provider executed |
| Private wire | Fixed HTTPS bridge-job routes, private-ingress authentication plus scoped device credential, strict bounded lease decoding and in-memory authenticated-grant branding | The renewable private hosting credential adapter is unavailable by default |
| Local durability | Separate protected, fsynced execution journal and artifact descriptors; original claim nonce, event sequence/hash and receipt recovery | Windows ACL/process/crash acceptance still requires the actual device |
| Workspace preparation | Fixed Git executable, registered repository and exact commit, isolated worktree, allowed-path checks and bounded patch validation | Filesystem validation alone is not a sandbox or hostile same-user process confinement |
| Artifact storage | Attempt-bound reserve, binary stage and explicit finalize, original mutation receipt replay, SHA/size checks and private D1/R2 binding | File availability proves bytes, not runtime/tool-policy compliance or task acceptance |

At source revision `f7e6afcf207c9bbe74eb0a34ea83f100dc73471a`, GitHub Actions run `39172129866` passed eleven SQLite/HTTP artifact tests and the actual isolated Miniflare D1/R2 lifecycle. The latter applied 26 migrations and exercised native D1 claim, receipted reserve/stage/finalize/replay, digest rejection, aggregate quota, foreign-owner denial and unchanged planning. This is synthetic cloud storage evidence, not deployed private ingress, actual Windows execution or a paid model call. Later source changes require their own checks.

## Install the generated bridge package

Use the generated, reviewed 0.2.0 npm tarball and its accompanying digest/manifest. Do not substitute an unreviewed source directory or infer a digest from the version number. Follow [the package README](../../bridge/README.md) and [Windows bridge installation](../integrations/windows-bridge.md):

1. Unpack into a dedicated local directory and review the supplied Windows installer, launcher and credential-protection scripts.
2. Copy the telemetry configuration example into the current user's private configuration directory. Explicitly select the private Site origin and device enrollment. Keep execution configuration separate.
3. Use the existing CLI's private interactive/stdin credential flow. Never put enrollment/device/service secrets in command-line arguments, source, logs or a job specification.
4. From the unpacked package, run the documented diagnostic command: `node src/cli.mjs doctor --config ABSOLUTE_CONFIG_PATH`. Doctor does not launch a collector or model.
5. Only after local review, use the supplied limited current-user installer. It installs a logon task; it does not start it or enable the executor. Uninstallation preserves local data.

The separate disabled executor commands are documented in [executor README](../../bridge/executor/README.md):

```sh
node bridge/executor/cli.mjs --help
node bridge/executor/cli.mjs run --enable-execution --config <absolute-local-execution-config>
```

Those paths are repository-relative; inside the unpacked package use its `executor/` directory. The production run currently returns a blocked `not_installed` result and exit code 2 before reading that configuration, claiming work, creating a worktree, launching a child or calling a model. The empty execution configuration example grants no repository, model or budget.

## Required owner and local inputs

These are separate requirements; none can be supplied by an imported historical record or a JSON trust flag.

- **Private access:** an actual supported renewable private-ingress connector and separately enrolled device credential with the required execution scopes. Keep the Site private; telemetry enrollment is insufficient.
- **Reviewed runtime release:** the independent upstream package name/version, source commit, tarball SHA-256 and manifest; actual runtime version, provider executable version/SHA-256, tool-policy name/SHA-256 and capability/configuration digests. The production registry is currently empty. See [the upstream runtime handoff](../integrations/agent-lab-runtime-handoff.md).
- **Exact provider/model policy:** explicitly select the supported provider (`codex` or `claude`), exact requested model and effort, subscription-only access and extra-usage-off attestation. Authentication remains in the local provider environment. Unknown or different models never trigger substitution or an API-key fallback. Missing observed model identity remains null; it is never copied from the request.
- **Repository permission:** locally register the repository, fixed Git executable, exact base commit and allowed paths/digest. Cloud job data cannot choose an executable, absolute workspace path, arbitrary environment or provider URL.
- **Finite owner approval:** approve the exact immutable job, binding hash, device, operation/effects and budget. Binding pins include provider/model/effort, full runtime/executable/tool-policy identity, capability/configuration hashes, allowed-path hash and exact input-artifact hashes. Input is at most 32 KiB, execution at most 600 seconds and output at most 2 MiB under the current contracts; tighter local bounds apply. Payment policy is subscription-only with unknown dollar cost retained as null.
- **Local safety evidence:** actual Windows protected state, process ownership and whole-tree exit/cancellation evidence, isolated-workspace confinement, reconnect/crash behavior and unrelated-process preservation. These are not established by Linux fixtures, fake adapters or a successful PID lookup.

The exact 14-field JobSpec remains immutable; execution pins are in its separate binding. Current capability admission is short-lived. A resumed attempt may reconcile/upload under its frozen admission and original hard deadline; it never receives another launch permission. Renewals cannot extend that original deadline.

## Recovery and unsupported cases

Keep claim nonces and original mutation IDs/bodies before writes. After an ambiguous claim or artifact mutation, reconcile/retry the same identity rather than creating another attempt. Journal event retries retain exact sequence/hash bytes. Lease tokens remain in memory, not the journal. Unacknowledged terminal data is not evicted to make room; capacity blocks admission.

An uncertain launch is not evidence of exit. An uncertain object PUT retains a nonexpiring pending upload fence; elapsed time alone cannot settle it. Reserved or staged metadata is not a ready file. Explicit finalization and verified physical bytes still do not establish runtime provenance, owner acceptance, task completion or weekly commitment.

Unsupported or missing runtime, private ingress, model identity policy, sandbox or process supervision must remain visibly blocked. There is no custom shell, provider CLI, alternate API, paid inference or automatic evaluation fallback. Test-only injected runtimes cannot be selected through production JSON.

Before any actual finite model trial, complete the independent upstream release review and [Windows acceptance checklist](../verification/windows-bridge-acceptance.md), then obtain the exact explicit owner approval. Record actual device/provider results separately from cloud tests, with private identifiers and paths redacted. Public source and portable metadata must never contain credentials or private provider homes.

## Artifact privacy rejection

Selected local text can be explicitly prepared with
`prepareExecutionArtifactContent` before reservation: it returns redacted bytes,
safe rule codes and a visible heuristic limitation. Hash and reserve those exact
prepared bytes; their digest differs from any changed original. The original
local data remains owner-controlled. Patch content containing a detected
credential is rejected rather than silently rewriting patch semantics.

The durable local artifact writer refuses remaining detected credential text.
The server independently scans bounded UTF-8 bytes before an upload token or R2
PUT. A detection returns `artifact_sensitive_content` and HTTP 422; metadata
stays reserved, no object is stored, and no result is accepted. This is rejection
before storage, **not** a claim that a persisted quarantined record was created.
There is no automatic upload, secret logging or original-data deletion.

The fixed heuristic checks private-key blocks, supported credential-token
formats, bearer values and common credential assignments. It cannot recognize
every secret, proprietary text, encoding or private file path. Absence of a match
does not establish secret-free content. The owner must review selected reports,
patches and transcripts before upload; raw transcripts remain explicitly selected.

Agent reservation accepts only text/plain, text/markdown, text/x-diff and application/json. Markdown and diff are stored/downloaded as text/plain; a .diff/.patch filename gains a .txt suffix. Responses show the normalized filename/MIME. The requested metadata remains part of the original immutable command identity; bytes and SHA-256 are unchanged. This never renders Markdown, HTML or a patch as executable content.
