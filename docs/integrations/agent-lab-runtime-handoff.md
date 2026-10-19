# Independent Agent Lab runtime handoff

Status: **reviewed extraction and Control Room installation/invocation integration implemented; real owner-device/provider acceptance pending**. A separate private draft PR contains the actual dependency-free runtime extraction and compatibility re-exports. Its actual Linux and Windows Actions passed 51 tests. The cloud release archive, inner package digest, immutable source pin and all five reviewed package files were independently checked. The actual archive was installed, reopened and loaded through Control Room's strict public installer. No provider/model was invoked. Private repository identity, source pins, installation paths and credentials stay outside this public document.

The public bridge implements the constrained installer, Windows suspended owned-process supervisor, dedicated workspaces, exact-model/approval/budget checks, durable launch and artifact journals, cancellation and nonce-only reconciliation. Synthetic native Windows tests verify their named boundaries; they do not certify the owner's installed device, provider CLI/login or actual sandbox behavior. Default production configuration remains disabled until the owner installs the reviewed private package and configures the matching local manifest.

The owner explicitly authorized the scoped extraction and integration. Preserve the private upstream's independent history and draft PR; do not copy its implementation or private runtime records into this public repository. No merge, provider invocation or operational activation is implied.

## Implemented upstream extraction contract

Before editing, the assigned upstream worker must read the current Agent Lab AGENTS and README, use its required exact implementation model (GPT-6.1 Sol in the inspected plan), and confirm current source/runtime constraints. Preserve dependency-free Node 24, standard-library code and node:test. Re-read the actual current source; plan-time source references do not prove current CLI versions, entitlement or installed authentication. Missing public source provenance here is a privacy boundary, not evidence that upstream access is unavailable.

Extract the tested low-level subscription runtime into:

- packages/subscription-runtime/package.json
- packages/subscription-runtime/src/index.mjs
- packages/subscription-runtime/src/providers.mjs
- packages/subscription-runtime/src/runner.mjs
- packages/subscription-runtime/src/policy.mjs
- test/shared-runtime.test.mjs

Move the provider/protocol/process policy from the existing providers and runner modules, plus shared clean-environment/redaction helpers from config. Keep compatibility re-exports so Agent Lab behavior and existing tests remain unchanged. Do not move fixture/suite materialization, grading, Lab settings, storage, queue authority or active run state. Do not expose the finite Lab fixture queue as arbitrary project execution.

## Required local module interface

The exported RuntimeAdapter retains these exact operations:

    probe(config: LocalProviderConfig): Promise<ProviderEvidence>
    execute(request: LocalExecutionRequest): Promise<LocalExecutionResult>
    executeOwned(request: LocalExecutionRequest, { owner, onStarted }): Promise<LocalExecutionResult>

LocalProviderConfig contains only provider codex or claude, local executable, subscriptionOnly true, and extraUsageOffAttested. Executable paths stay local; authentication remains in the existing local provider home and is never uploaded or accepted as cloud job configuration.

ProviderEvidence contains ready, nullable runtimeVersion, issues, checkedAt and toolPolicy. Source/runtime/tool-policy identity must be exact; missing proof stays unavailable. Public operational diagnostics must be typed/redacted rather than raw account, path or CLI error prose.

LocalExecutionRequest contains config, dedicated workspace, immutable prompt text, exact requestedModel, effort, mode response or edit, timeoutMs, outputBytesLimit, explicit allowUnverifiedModel boolean and AbortSignal. Control Room invokes executeOwned through its native owner; onStarted must durably acknowledge the suspended process before provider execution resumes. The unowned execute interface is retained for upstream compatibility and grants no Control Room launch authority. The shared runtime must enforce the selected sandbox/tool policy and equal-or-tighter finite bounds. It must not accept shell payloads, arbitrary environment overrides, cloud executable paths, provider URLs or automatic model substitution.

LocalExecutionResult contains status completed/failed/timed_out/cancelled/blocked/rate_limited; finalText, stdout and stderr; nullable observedModel and observedModels; completed, nullable exitCode, terminationUnconfirmed; nullable numeric usage; and nullable error. Keep unavailable observed identity null. Never populate it from requestedModel. An emitted different model blocks the finite run. Missing identity may be accepted only under an explicit local policy and remains unverified; zero exit alone is insufficient terminal evidence. Unconfirmed termination is not a successful cancellation.

Raw output remains private local result data until explicit artifact handling/redaction. Runtime metadata imports must not automatically upload transcripts. Redaction is defense in depth, not a guarantee that arbitrary model output is free of sensitive data.

## Upstream acceptance and immutable release evidence

The extraction must preserve exact CLI argument construction, subscription checks, explicit extra-usage policy, clean environment, provider-specific sandbox/tool differences, streaming protocol parsing, terminal-event detection, bounded output, timeout/cancel behavior, authentication/quota stops and model-identity mismatch stops. No API-key fallback, credit purchase, quota reset or policy relaxation is permitted.

Run shared-runtime tests and the existing Agent Lab core/runtime/suite tests. Include fake owned parent/child processes, cancellation under output, output cap, timeout, unavailable identity, different observed identity, missing terminal protocol, authentication/quota failure and terminationUnconfirmed. Do not invoke real model evaluations merely to extract the package.

Record and review these values from the actual release artifact:

| Required value | Current handoff evidence |
| --- | --- |
| Package name and immutable version | Reviewed private subscription runtime 0.1.0; exact package identity retained privately |
| Upstream source commit and reviewed diff | Separate private draft PR and immutable release pin verified; identity retained privately |
| Tarball SHA-256 and content manifest | Actual cloud outer/inner digests and five source files verified; pins retained privately |
| Runtime/tool-policy version and provider executable evidence | Package policy pinned; owner executable/login not probed |
| Node/platform/provider CLI test matrix | Node 24 Linux and Windows synthetic tests passed; real provider CLI not run |
| Existing Lab compatibility and shared-runtime results | 51 tests passed on Linux and Windows |
| Actual Windows process ownership/exit behavior | Native cloud Windows fixture passed; owner-device acceptance not run |

Ensure the package contains only reviewed source/license/metadata, not provider homes, credentials, account output, local absolute paths, Lab run storage or private transcripts. Pin reviewed immutable version, source commit and tarball SHA-256 in the separate executor manifest and lockfile only after review. Resolve install from that exact supported artifact; verify content integrity. Do not use a mutable relative/absolute import into Agent Lab source.

## Control Room boundary

`bridge/executor/runtime.mjs` loads only an independently reviewed immutable package through the strict installer. Production JSON cannot select an arbitrary module, in-memory fake, shell payload or provider endpoint. Installation pins, protected local state, archive/file integrity and actual native process ownership are independently checked before invocation. The private package is not bundled into the public bridge.

The coordinator requires an approved frozen attempt, exact device/workspace/base identity, explicit model and budget, protected launch journal and current lease. Artifacts become reviewable proposals through reserve/upload/finalize and the production physical-byte verifier; they never automatically accept evidence or complete planning tasks. Cancellation requires confirmed owned-process exit before acknowledgement. Retained exited attempts reconcile by their original nonce without probing or launching another provider.

Three genuine isolated D1/R2 HTTP regressions cover lost replies and restart upload, authenticated cancellation, and 61-event expired-lease nonce recovery in bounded batches. Exact-source native Windows/portable and canonical evidence is recorded in the completion plan's verification index. These checks neither provide provider consent nor attest to the owner's device.

## Local acceptance after reviewed installation

An authorized local operator must re-read current upstream instructions, verify package/source/tarball identities, confirm subscription authentication and the named exact model, and review sandbox/tool policy before enabling one repository/operation and one finite explicitly approved attempt. Begin with project.inspect in a dedicated isolated worktree at an exact base commit. No changes to the original checkout, merge, deployment, collector/model service startup, live trading or automatic evaluation batch are part of this acceptance.

First demonstrate owned fake-process cancellation/reconnect, unrelated-process preservation, journal recovery and denied lease renewal on the actual Windows version. Record process-tree exit evidence; PID or a taskkill invocation alone is not proof against crash/PID-reuse intervals. Any real-model trial requires a separate explicit finite approval and must keep missing identity and native policy blocks visible. Do not retry an uncertain launch to recreate evidence.

Record requested/observed identity, source/runtime/package digests, permission policy, attempt identity, timestamps, artifact digests and confirmed exit with private identifiers redacted. Keep actual Windows/model results separate from cloud/fake results. Until the owner performs reviewed local installation/configuration, the production adapter remains unavailable and execution stays disabled.

## Implemented original read-only projection

The Control Room adapter now has an original bounded projection for the inspected run-summary and typed report wire interfaces. It copies no private upstream implementation. Explicit selected local JSON imports omit raw state, token/auth/provider executable fields, paths, transcript/output, review prose and Markdown before transport. The optional report reader uses only the fixed numeric loopback GET and returns bounded cohort counts; aggregates never manufacture per-run records.

See [the local import procedure](agent-lab-evidence-import.md). Optional source-reported objective summaries keep assessable/pass/check counts separate from human verdict and claimed model verification. Unknown usage/cost remains unknown. Original-input digests are local source claims, not server verification of original bytes, provider execution or owner acceptance. The native server still validates the closed normalized upload and immutable historical hashes; old observations without optional fields retain their prior serialization.

Portable projection and fake-process compatibility work are feasible in cloud without running a provider. Runtime extraction and Windows owned-process integration are implemented. Actual owner installation, provider login/model and sandbox/device acceptance remain separate required checks; a passing cloud fixture does not supply them.
