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
