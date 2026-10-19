# Subscription executor integration

The Phase 7 implementation connects the bounded public coordinator to a separately reviewed private subscription-runtime package. Execution remains disabled by default. The connection registry has no supported private Site service adapter installed, so the shipped CLI reports `needs_connection` instead of borrowing browser credentials or weakening private access. Source, synthetic HTTP tests and Windows CI do not establish owner-device, provider authentication or sandbox acceptance.

## Independent installation evidence

Keep the launch manifest, private runtime archive, approved source pin and owner credentials private. Start with `bridge/executor/launch-config.example.json`. Configure an exact provider, exact model list, repository allowlist and protected paths, finite job/runtime/output budgets, explicit subscription-only policy and owner attestation that extra usage is off. Approval freezes the runtime, executable, tool policy, model, repository/base commit, allowed paths, effects and budgets. No default permits paid inference or operational effects.

The installer requires independently retained package name/version, source commit, archive SHA-256, runtime version and tool-policy version. It accepts only the five reviewed package files and retains the original archive. Opening an installation rechecks that archive and every extracted byte; editing its local record cannot substitute another package. The private extraction has its own draft PR and source-only package, never included in the public bridge archive.

Use Node 24 and Windows with .NET 8 installed. Build the original single-file helper using `bridge/windows/owned-process/README.md`, review its bytes and retain its actual SHA-256. The provider executable has its own independently pinned hash and version. A helper controls process lifetime; provider sandbox arguments remain separate policy and need actual local acceptance.

The manifest's `stateDirectory` is exactly `.control-room-executor` next to the private manifest. Its runtime installation is `runtime` beneath that directory. Workspaces are derived beneath sibling `.control-room-workspaces/repo-<hash>`; cloud JSON cannot choose those roots. Telemetry configuration and DPAPI credentials retain the original `.control-room-bridge` boundary and its original inventory limit. Existing state is verified rather than silently repaired. Explicit helper/runtime installation prepares only its selected new objects.

After independently configuring the private manifest, the supported commands are:

```powershell
node bridge/executor/cli.mjs install-runtime --config ABSOLUTE_LOCAL_MANIFEST --archive ABSOLUTE_REVIEWED_ARCHIVE
node bridge/executor/cli.mjs prepare-helper --config ABSOLUTE_LOCAL_MANIFEST
node bridge/executor/cli.mjs runtime-policy --config ABSOLUTE_LOCAL_MANIFEST
node bridge/executor/cli.mjs run --enable-execution --once --config ABSOLUTE_LOCAL_MANIFEST --job-id OWNER_APPROVED_JOB_ID
```

Review the derived tool-policy descriptor and hash before independently approving the matching runtime identity. These commands do not supply a missing private ingress adapter. Install and validate a supported renewable service-credential adapter before activating a finite execution. Do not paste session cookies, credentials or arbitrary headers into the manifest.

## Durable execution and recovery

A claim nonce is persisted before sending. Authenticated grant provenance binds the owner, device, attempt, epoch, approval and exact frozen input. A durable launch intent consumes permission once. The native helper creates the provider suspended inside its own Job Object, and resumes only after the started observation is durably recorded. It never cancels by PID. Missing or ambiguous whole-tree exit evidence requires reconciliation and blocks another launch.

Observed-model evidence is recorded after it actually arrives, using the additive `model_observed` event. It does not rewrite the earlier started event or infer a model from a request. Mismatches block success. A resumed attempt cannot launch again.

Artifact upload retains separate exact reserve/finalize mutation intents and owner/attempt-bound remote mappings. Completion persists the mapped outbound events/result before sending and acknowledges only exact remote receipts. Lost replies can replay those same intents without repeating provider execution. The original local journal remains unchanged.

Successful inspection artifacts use a closed bounded report format. Patch results additionally require a frozen, physically verified owner-approved `agent-patch-scope` input with repository/base, allowed paths and protected paths. Missing scope returns `approved_patch_scope_required`. The server verifies artifact bytes and proposal structure; source claims and local Git applicability remain device evidence. Results do not accept proposals, complete tasks or create weekly commitments.

## Remaining activation evidence

Run the exact source-specific native supervisor/ACL, bridge, D1/R2/HTTP, browser, performance and package-integrity gates before publication. A passing synthetic provider fixture is not a real provider call. On the owner's Windows device, separately verify provider login/version/model observation, the unchanged sandbox/tool restrictions, approved worktree scope, cancellation/tree exit, output bounds, disconnect/reconciliation, durable artifact receipts and private service credential renewal. Use isolated synthetic repositories and data for failure tests. Keep inference disabled until the owner selects exact models and budgets; retain explicit proposal review after execution.
