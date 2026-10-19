# Native owned process helper

This original helper owns one Windows Job Object. It creates the selected local executable suspended, assigns it to the Job Object, and allows only its three standard pipe handles to be inherited. It reports a fresh supervisor observation to Node. The primary thread remains suspended until Node has awaited the local journal callback and explicitly acknowledges `resume`. Input delivery begins after that acknowledgement.

The helper closes or terminates its own kernel handles, never looks up a process by PID, never invokes taskkill, and does not accept a PID for cancellation. Closing its Job Object handle kills its descendants. A terminal receipt requires querying that same live Job Object and observing zero active processes, then waiting for output pipes and the helper's successful exit. A helper crash, protocol error, rejected callback or missing receipt remains unconfirmed; the coordinator must reconcile rather than retry or acknowledge cancellation. The supervisor instance refuses subsequent runs after an unconfirmed outcome. If the helper exits during the durable callback, settlement waits for that callback and its completion cannot resume the closed helper. The public observation timestamp is a helper timestamp, not a claim of a kernel creation-time lookup. PID reuse cannot redirect cancellation because PIDs are not used for cancellation.

Job ownership is a lifetime control. It does not establish filesystem or network confinement. Provider-native sandbox/tool arguments must come unchanged from the separately reviewed subscription runtime. A dedicated worktree and this helper alone do not prove sandbox acceptance.

Build on Windows with the .NET 8 SDK:

```powershell
dotnet publish bridge/windows/owned-process/OwnedProcess.csproj --configuration Release --runtime win-x64 --self-contained false -p:PublishSingleFile=true --output ABSOLUTE_PRIVATE_OUTPUT
```

During explicit local installation, call `prepareWindowsOwnedHelperDirectory` on its dedicated canonical output directory. This fixed operation protects only the helper directory and its executable/optional PDB, validates current-user ownership, safe parent ACLs, native reparse attributes and regular file link counts, and never changes parent ACLs. Registration and execution only verify those protections; they do not repair permissions. Register the resulting single-file `OwnedProcess.exe` with its actual SHA-256 through trusted local composition. The single-file build is required: hashing an apphost while leaving a mutable sibling DLL outside that hash is insufficient. The installed .NET 8 platform remains a local prerequisite. Do not point the production configuration at an unreviewed binary or replace an unavailable helper with a script, PID kill or arbitrary shell.

`createWindowsOwnedProcessSupervisor` accepts only a trusted absolute helper path and digest. Its `run` method receives the runtime's exact executable, argument vector, clean environment, prompt and finite bounds in local code; cloud job JSON cannot select an owner implementation. It streams bounded output to the existing provider protocol parser, allowing immediate abort on an authentication, quota, model or policy stop. The wrapper never substitutes a provider or model.

Native acceptance is isolated and synthetic:

```powershell
node --test --test-timeout=180000 bridge/test/owned-process-native.test.mjs
```

It compiles the single-file helper, tests suspended launch, exact input, descendant cancellation, unrelated-child preservation, finite timeout/output stops and refusal of a failed durable-start callback. Linux skips Windows cases explicitly. Neither authored source nor Linux skips establish a Windows pass, an installed owner device, provider authentication, a provider sandbox, or a model run. Production remains disabled until the reviewed package/helper composition and actual local acceptance exist.

Executor state verification uses fixed scope names and purpose-derived immediate inventories. Credential storage keeps its existing separate 256-entry tree. Runtime, attempts, claims, reservations and artifacts use their own finite bounds, so retaining workspace files cannot consume the credential verifier's allowance. Workspace verification selects exactly one registered attempt tree, with the existing 2,000 source-file, 8 MiB materialization limits plus its Git marker; directory count derives from bounded relative path segments. Its single recursive check runs after fresh materialization and before/after execution. Junctions/reparse points, foreign owners and untrusted access rules still fail. Existing safely inherited access rules are accepted only when they grant precisely current-user and SYSTEM full control with the expected propagation. Ordinary verification never repairs them.

Windows CI fixture setup is explicitly synthetic. It may normalize ownership of its own fresh temporary objects from the Administrators group to the current user, after exact inventory/hash and native object checks. For the larger workspace fixture it changes only the short-lived fixture creator's default object owner, preserving product process tokens and strict product owner verification. These fixture operations are excluded from installation packages.
