# Disabled local execution boundary

The production `cli.mjs run --enable-execution --config <absolute-local-config>` is an explicit separate entry point. It returns `not_installed` without reading that file, acquiring a lease, making a worktree, launching a child, or calling a model. No provider command, runtime package, executable, subscription login, Windows process supervisor, or API fallback is installed by these leaves.

The pure policy's exact 14-field JobSpec remains unchanged. `admitExecutionLease` separately verifies the full execution binding against the caller's independently retained expected binding digest, then requires the existing policy verdict. Native-looking JSON does not authenticate an owner. The caller must obtain the lease and server time through authenticated transport. Lease tokens remain in memory; journal records contain no token. Renewal cannot extend the original finite job deadline. Cancellation, revocation, clock reversal and uncertain launch prohibit another launch.

Use `openExecutorStore` for a dedicated protected execution-journal directory, separate from telemetry. It holds one exclusive local slot. Retained attempts are capped at twelve, each journal at 10 MiB/10,000 records and original artifacts at 10 MiB/100 files. No automatic eviction, truncation, stale-lock takeover or unacknowledged-data deletion exists. A crash-held lock requires owner reconciliation, not a PID guess. Artifacts are written and fsynced before their immutable descriptors enter the journal. Append/hash/receipt validation prevents acknowledging different bytes. Windows opening requires the trusted ACL verifier callback; no JSON permission flag suffices.

`createWorkspaceManager` accepts only trusted local registration and an absolute fixed Git executable. Its shell:false operations produce an isolated detached worktree from an exact registered commit, materializing only allowed regular blobs. Original dirty files are left alone. Tracked attributes, linked repositories, symlinks/submodules and unsafe paths fail closed. No checkout filters or hooks run. Report claims require exact file hashes and line bounds. Narrow patch bytes require allowed paths and an actual fixed `git apply --check --cached` against the base; the helper never applies a patch to the original checkout. A future runtime still needs a verified sandbox: these filesystem checks do not establish process confinement or close a hostile same-user race.

Recovery is conservative: prelaunch requires owner review, uncertain launch requires reconciliation, confirmed process exit permits upload-only, and an acknowledged result is complete. These leaves do not implement an installed-runtime supervisor or claim a provider process exited. Existing `createTestRuntimeHarness` is explicit dependency injection for tests and cannot be selected from production JSON.

Authored cloud checks: `node --test bridge/test/execution-policy.test.mjs bridge/test/executor-*.test.mjs`. Execution status at authoring: **NOT RUN**, pending parent GitHub Actions integration. Synthetic process identities and Linux temporary Git fixtures do not certify Windows ACLs, hidden windows, process-tree termination, provider authentication, subscription billing, model identity or an actual model run.

## Empty local configuration example

`config.example.json` is a separate disabled execution-policy example, not the bridge telemetry configuration. It contains no repository registration, model, runtime, capability, job allowance or approval. The installer does not enable or schedule this executor. The production entry point still stops at `not_installed`; it does not read this example or turn an opt-in flag into runtime authority.

```sh
node bridge/executor/cli.mjs --help
node bridge/executor/cli.mjs run --enable-execution --config <absolute-local-execution-config>
```

The second command currently returns a blocked result and exit code 2. A later independently reviewed runtime integration must validate the exact policy and authenticated lease before any effects.

## Authenticated wire preparation

The separate `transport.mjs` is disabled by default. Its only destinations are the fixed HTTPS site `/api/bridge/jobs/{capabilities,claim,renew,events,complete,reconcile}` routes. It requires both the separately assigned device credential and a proven private-ingress connector; unavailable ingress stops rather than falling back to cookies, telemetry access, provider APIs, alternate URLs or automatic request retries. Each request operation has a 15-second deadline. POST bodies and ordinary responses remain capped at 64 KiB. Only claim/renew lease responses have the fixed 512-KiB cap, including at most 384 KiB of frozen dependency admission data; task input plus input-artifact bytes remains limited to 32 KiB.

`prepareDurableClaim` persists an immutable client-generated recovery nonce before a claim request. It does not persist a lease token or issue authority. It is separate from telemetry and holds at most twelve claim records without eviction. A corrupt record or stale writer lock requires reconciliation. Reuse the exact job/nonce after ambiguous claim delivery; never create another job or nonce to hide a lost response.

`parseAgentLease` uses the actual server names `executionEpoch`, `leaseExpiresAt`, `record` and `executionBinding`, plus the frozen `approvalEnvelope`, `frozenAdmission`, `taskInput` and trusted `serverNow`. The task input is the exact shared semantic projection, digest-checked and bounded together with input artifacts at 32 KiB. It is data, not instructions to select an executable. No absent task text is invented.

The low-level `bindAgentLease` accepts explicit trusted admission inputs for isolated contract tests. The production protocol-facing `bindAuthenticatedAgentGrant` accepts only an in-memory grant branded by the fixed TLS/private-ingress transport after strict decoding. JSON copies or trust flags cannot mint that provenance. The server's frozen manifest supplies the actual preclaim state and same-owner dependency graph, while the independently configured local policy/capability and protected local journal reader still control pins, finite budgets, cancellation and local disablement. The stored approval binding hash is used only inside that branded boundary and rechecked against local pins; a plain response object is insufficient. Each grant can bind once. A pinned runtime is still absent, so the production entry point remains not installed. A resumed lease never offers launch permission. The one initial permission is consumable once; durable launch-intent journal state must precede any future actual launch.

The helper exposes a 15-second monotonic renewal cadence and preserves the original server hard deadline. An ambiguous renewal stops local permission; it does not prove cancellation or exit. `flushJournalEvents` retries the same pending sequence/hash bytes and journals acknowledgements only for an exact complete receipt set matching attempt, epoch, sequence and canonical event hash. Unchanged persisted receipts survive response loss. This is a polling protocol boundary, not proof of a running supervisor or live private ingress.

A resumed authenticated lease checks the frozen capability and approval at original admission time, with unchanged pin hashes, current local stops/budgets, current server lease authority and the original hard deadline. It does not require a newly hashed capability after the five-minute admission TTL, and never grants another launch.
