# Opt-in local execution boundary

The legacy `cli.mjs run --enable-execution --config <absolute-local-config>` invocation returns `not_installed` without reading that file or acquiring execution authority. The separate `run --enable-execution --once` path implements finite installed-runtime execution after its exact local configuration and authenticated approval checks. Execution remains disabled by default. The public package includes the constrained installer and original Windows owned-process helper source; the reviewed private runtime, provider executable/login and compiled helper require separate local installation. No API fallback is supplied.

The pure policy's exact 14-field JobSpec remains unchanged. `admitExecutionLease` separately verifies the full execution binding against the caller's independently retained expected binding digest, then requires the existing policy verdict. Native-looking JSON does not authenticate an owner. The caller must obtain the lease and server time through authenticated transport. Lease tokens remain in memory; journal records contain no token. Renewal cannot extend the original finite job deadline. Cancellation, revocation, clock reversal and uncertain launch prohibit another launch.

Use `openExecutorStore` for a dedicated protected execution-journal directory, separate from telemetry. It holds one exclusive local slot. Retained attempts are capped at twelve, each journal at 10 MiB/10,000 records and original artifacts at 10 MiB/100 files. No automatic eviction, truncation, stale-lock takeover or unacknowledged-data deletion exists. A crash-held lock requires owner reconciliation, not a PID guess. Artifacts are written and fsynced before their immutable descriptors enter the journal. Append/hash/receipt validation prevents acknowledging different bytes. Windows opening requires the trusted ACL verifier callback; no JSON permission flag suffices.

`createWorkspaceManager` accepts only trusted local registration and an absolute fixed Git executable. Its shell:false operations produce an isolated detached worktree from an exact registered commit, materializing only allowed regular blobs. Original dirty files are left alone. Tracked attributes, linked repositories, symlinks/submodules and unsafe paths fail closed. No checkout filters or hooks run. Report claims require exact file hashes and line bounds. Narrow patch bytes require allowed paths and an actual fixed `git apply --check --cached` against the base; the helper never applies a patch to the original checkout. The installed provider runtime still needs an accepted sandbox: these filesystem checks do not establish process confinement or close a hostile same-user race.

Recovery is conservative: prelaunch requires owner review, uncertain launch requires reconciliation, confirmed process exit permits upload-only, and an acknowledged result is complete. The installed path uses the Windows suspended Job Object supervisor and requires confirmed whole-tree exit evidence. Cloud fixtures do not establish owner-device or provider acceptance. Existing `createTestRuntimeHarness` is explicit dependency injection for tests and cannot be selected from production JSON.

Cloud checks include `node --test bridge/test/execution-policy.test.mjs bridge/test/executor-*.test.mjs`; source-specific results are recorded in the repository completion plan’s `progress.json` and `resume-checkpoint.json`. Historical passes do not certify a later source or installation. Synthetic process identities and Linux temporary Git fixtures do not certify Windows ACLs, hidden windows, process-tree termination, provider authentication, subscription billing, model identity or an actual model run.

## Empty local configuration example

`config.example.json` is a separate disabled execution-policy example, not the bridge telemetry configuration. It contains no repository registration, model, runtime, capability, job allowance or approval. The installer does not enable or schedule this executor. The legacy invocation still stops at `not_installed`. The installed `--once` path instead uses the separate private `launch-config.example.json` shape; an opt-in flag alone cannot supply runtime authority.

```sh
node bridge/executor/cli.mjs --help
node bridge/executor/cli.mjs run --enable-execution --config <absolute-local-execution-config>
```

The second command is the legacy invocation and returns a blocked result with exit code 2. For the installed finite path, follow the repository [subscription executor procedure](../../docs/integrations/subscription-executor.md). From this unpacked package directory, the supported command sequence is:

```powershell
node executor/cli.mjs install-runtime --config ABSOLUTE_LOCAL_MANIFEST --archive ABSOLUTE_REVIEWED_ARCHIVE
node executor/cli.mjs prepare-helper --config ABSOLUTE_LOCAL_MANIFEST
node executor/cli.mjs runtime-policy --config ABSOLUTE_LOCAL_MANIFEST
node executor/cli.mjs report-capability --once --config ABSOLUTE_LOCAL_MANIFEST --expected-revision null
node executor/cli.mjs run --enable-execution --once --config ABSOLUTE_LOCAL_MANIFEST --job-id OWNER_APPROVED_JOB_ID
```

Review the derived runtime/tool policy before reporting capability. Use `null` only for the initial capability report; subsequent reports require the independently observed current operational revision. Configure the finite manual Sites connection before reporting, and obtain an explicit owner approval for the exact frozen job after its matching capability is available. These commands do not grant consent for a real provider trial.

## Authenticated wire preparation

The separate `transport.mjs` is disabled by default. Its only destinations are the fixed HTTPS site `/api/bridge/jobs/{capabilities,claim,renew,events,complete,reconcile}` routes. It requires both the separately assigned device credential and a proven private-ingress connector; unavailable ingress stops rather than falling back to cookies, telemetry access, provider APIs, alternate URLs or automatic request retries. Each request operation has a 15-second deadline. POST bodies and ordinary responses remain capped at 64 KiB. Only claim/renew lease responses have the fixed 512-KiB cap, including at most 384 KiB of frozen dependency admission data; task input plus input-artifact bytes remains limited to 32 KiB.

`prepareDurableClaim` persists an immutable client-generated recovery nonce before a claim request. It does not persist a lease token or issue authority. It is separate from telemetry and holds at most twelve claim records without eviction. A corrupt record or stale writer lock requires reconciliation. Reuse the exact job/nonce after ambiguous claim delivery; never create another job or nonce to hide a lost response.

`parseAgentLease` uses the actual server names `executionEpoch`, `leaseExpiresAt`, `record` and `executionBinding`, plus the frozen `approvalEnvelope`, `frozenAdmission`, `taskInput` and trusted `serverNow`. The task input is the exact shared semantic projection, digest-checked and bounded together with input artifacts at 32 KiB. It is data, not instructions to select an executable. No absent task text is invented.

The low-level `bindAgentLease` accepts explicit trusted admission inputs for isolated contract tests. The production protocol-facing `bindAuthenticatedAgentGrant` accepts only an in-memory grant branded by the fixed TLS/private-ingress transport after strict decoding. JSON copies or trust flags cannot mint that provenance. The server's frozen manifest supplies the actual preclaim state and same-owner dependency graph, while the independently configured local policy/capability and protected local journal reader still control pins, finite budgets, cancellation and local disablement. The stored approval binding hash is used only inside that branded boundary and rechecked against local pins; a plain response object is insufficient. Each grant can bind once. The installed path requires the independently pinned private runtime and genuine native supervisor; neither a response object nor the public archive alone supplies them. A resumed lease never offers launch permission. The one initial permission is consumable once; durable launch-intent journal state must precede any future actual launch.

The helper exposes a 15-second monotonic renewal cadence and preserves the original server hard deadline. An ambiguous renewal stops local permission; it does not prove cancellation or exit. `flushJournalEvents` retries the same pending sequence/hash bytes and journals acknowledgements only for an exact complete receipt set matching attempt, epoch, sequence and canonical event hash. Unchanged persisted receipts survive response loss. The polling protocol itself is not proof of owner-device supervisor behavior or live private ingress acceptance.

A resumed authenticated lease checks the frozen capability and approval at original admission time, with unchanged pin hashes, current local stops/budgets, current server lease authority and the original hard deadline. It does not require a newly hashed capability after the five-minute admission TTL, and never grants another launch.

After the native Sites owner-private confirmation and masked `sites-access` import described in the bridge README, explicitly report the current local capability before admitting a job:

```powershell
node executor/cli.mjs report-capability --once --config C:\private\launch.json --expected-revision null
node executor/cli.mjs report-capability --once --config C:\private\launch.json --expected-revision 1
```

Use `null` only for an initial report; otherwise supply the independently observed current operational revision. Reporting authenticates the installed package, native supervisor and configured provider probe, then derives scope from current policy, verified runtime identity, protected device identity and retained local budget. It performs no model call and does not claim executed model verification. Only an exact authenticated receipt updates the protected local launch capability. An uncertain receipt requires owner reconciliation rather than an automatic retry. Manual Sites access expires at its local cutoff (at most 15 minutes), actively aborting owned execution; this is not issuer expiry or unattended renewal.
