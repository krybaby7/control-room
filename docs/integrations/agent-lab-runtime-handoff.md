# Independent Agent Lab runtime handoff

Status: **production runtime package not extracted / not installed**. The actual private upstream source interface has now been inspected read-only through authorized repository access. Its source, repository identity, pins and private contents are not copied or published here. No subscription session, installed provider executable, live evaluation or Windows lifecycle behavior was accessed or verified. The Control Room production runtime reports not_installed. Source/package/runtime versions and source/tarball digests remain null until an actual reviewed artifact exists. Fake adapters prove wrapper contracts only.

This is a separate owner-reviewed change in the Agent Lab repository. It does not authorize a Control Room worker to modify a sibling checkout, copy private evaluation data, launch a service or model, change provider settings, or select a different sandbox to manufacture success.

## Requested upstream change

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

LocalProviderConfig contains only provider codex or claude, local executable, subscriptionOnly true, and extraUsageOffAttested. Executable paths stay local; authentication remains in the existing local provider home and is never uploaded or accepted as cloud job configuration.

ProviderEvidence contains ready, nullable runtimeVersion, issues, checkedAt and toolPolicy. Source/runtime/tool-policy identity must be exact; missing proof stays unavailable. Public operational diagnostics must be typed/redacted rather than raw account, path or CLI error prose.

LocalExecutionRequest contains config, dedicated workspace, immutable prompt text, exact requestedModel, effort, mode response or edit, timeoutMs, outputBytesLimit and AbortSignal. The shared runtime must enforce the selected sandbox/tool policy and equal-or-tighter finite bounds. It must not accept shell payloads, arbitrary environment overrides, cloud executable paths, provider URLs or automatic model substitution.

LocalExecutionResult contains status completed/failed/timed_out/cancelled/blocked/rate_limited; finalText, stdout and stderr; nullable observedModel and observedModels; completed, nullable exitCode, terminationUnconfirmed; nullable numeric usage; and nullable error. Keep unavailable observed identity null. Never populate it from requestedModel. An emitted different model blocks the finite run. Missing identity may be accepted only under an explicit local policy and remains unverified; zero exit alone is insufficient terminal evidence. Unconfirmed termination is not a successful cancellation.

Raw output remains private local result data until explicit artifact handling/redaction. Runtime metadata imports must not automatically upload transcripts. Redaction is defense in depth, not a guarantee that arbitrary model output is free of sensitive data.

## Upstream acceptance and immutable release evidence

The extraction must preserve exact CLI argument construction, subscription checks, explicit extra-usage policy, clean environment, provider-specific sandbox/tool differences, streaming protocol parsing, terminal-event detection, bounded output, timeout/cancel behavior, authentication/quota stops and model-identity mismatch stops. No API-key fallback, credit purchase, quota reset or policy relaxation is permitted.

Run shared-runtime tests and the existing Agent Lab core/runtime/suite tests. Include fake owned parent/child processes, cancellation under output, output cap, timeout, unavailable identity, different observed identity, missing terminal protocol, authentication/quota failure and terminationUnconfirmed. Do not invoke real model evaluations merely to extract the package.

Record and review these values from the actual release artifact:

| Required value | Current handoff evidence |
| --- | --- |
| Package name and immutable version | null; no package verified |
| Upstream source commit and reviewed diff | not published here; actual source inspected privately, extraction/release still pending |
| Tarball SHA-256 and content manifest | null; no tarball verified |
| Runtime/tool-policy version and provider executable evidence | null; not probed |
| Node/platform/provider CLI test matrix | NOT RUN for this package |
| Existing Lab compatibility and shared-runtime results | NOT RUN |
| Actual Windows process ownership/exit behavior | NOT RUN |

Ensure the package contains only reviewed source/license/metadata, not provider homes, credentials, account output, local absolute paths, Lab run storage or private transcripts. Pin reviewed immutable version, source commit and tarball SHA-256 in the separate executor manifest and lockfile only after review. Resolve install from that exact supported artifact; verify content integrity. Do not use a mutable relative/absolute import into Agent Lab source.

## Control Room boundary

bridge/executor/runtime.mjs has an empty production package registry and no custom CLI/process or provider API implementation. createSubscriptionRuntime reports not_installed with null installed identity. Production configuration cannot choose an in-memory fake adapter by JSON, file path, model name or registry override. Its probeLocalExecution/probe and execute calls remain blocked without the actual pinned package.

createTestRuntimeHarness is a separate explicit function dependency constructor for synthetic tests. It checks exact source/package/runtime/tool-policy identity, provider, executable selection, subscription policy, model/effort, bounds and result identity. It is not package installation evidence and issues no job approval, lease or launch authority. The runtime wrapper is not a substitute for the independent workspace, journal, native owner approval, device scope, lease/reconciliation, artifact or task-acceptance boundaries.

The authored executor-runtime tests must run in actual Node 24 Actions before any source-check claim. Their synthetic probe/result objects do not certify subscription login, model execution, real CLI flags or Windows cancellation. Integration remains behind the Phase 6 gate and the independent runtime handoff.

## Local acceptance after reviewed installation

An authorized local operator must re-read current upstream instructions, verify package/source/tarball identities, confirm subscription authentication and the named exact model, and review sandbox/tool policy before enabling one repository/operation and one finite explicitly approved attempt. Begin with project.inspect in a dedicated isolated worktree at an exact base commit. No changes to the original checkout, merge, deployment, collector/model service startup, live trading or automatic evaluation batch are part of this acceptance.

First demonstrate owned fake-process cancellation/reconnect, unrelated-process preservation, journal recovery and denied lease renewal on the actual Windows version. Record process-tree exit evidence; PID or a taskkill invocation alone is not proof against crash/PID-reuse intervals. Any real-model trial requires a separate explicit finite approval and must keep missing identity and native policy blocks visible. Do not retry an uncertain launch to recreate evidence.

Record requested/observed identity, source/runtime/package digests, permission policy, attempt identity, timestamps, artifact digests and confirmed exit with private identifiers redacted. Keep actual Windows/model results separate from cloud/fake results. Until then the production adapter stays not_installed and execution stays disabled.

## Implemented original read-only projection

The Control Room adapter now has an original bounded projection for the inspected run-summary and typed report wire interfaces. It copies no private upstream implementation. Explicit selected local JSON imports omit raw state, token/auth/provider executable fields, paths, transcript/output, review prose and Markdown before transport. The optional report reader uses only the fixed numeric loopback GET and returns bounded cohort counts; aggregates never manufacture per-run records.

See [the local import procedure](agent-lab-evidence-import.md). Optional source-reported objective summaries keep assessable/pass/check counts separate from human verdict and claimed model verification. Unknown usage/cost remains unknown. Original-input digests are local source claims, not server verification of original bytes, provider execution or owner acceptance. The native server still validates the closed normalized upload and immutable historical hashes; old observations without optional fields retain their prior serialization.

Portable projection and fake-process compatibility work are feasible in cloud without running a provider. Runtime extraction/registration is still missing implementation, and actual Windows sandbox/owned-process supervision remains missing integration/acceptance. Neither owner login nor installing the existing disabled bridge alone completes those tasks.
