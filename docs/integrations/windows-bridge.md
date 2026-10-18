# Windows bridge handoff

The Node 24 bridge sends an allowlisted read-only projection from an already-running PC Command Center. It does not start a collector, model, service, driver, trader or remote shell.

**Windows installation, DPAPI round-trip, hidden window behavior, local ACLs, real collector readings and unattended credential renewal are NOT RUN / NOT VERIFIED.** Private ingress is unsupported by default. Packaging does not establish a live connection. See [private-service-ingress.md](private-service-ingress.md) and [windows-bridge-acceptance.md](../verification/windows-bridge-acceptance.md).

Use a reviewed package with exact source revision and SHA-256 digest recorded by the integrator. Release identity and package digest will be recorded later; this source leaf does not invent them. Extract into a stable local user-controlled directory and use a non-elevated PowerShell session with separately installed Node 24. Keep configuration, protected credentials, spool and logs outside source control. The intended config is under the current user's local application data. Do not publish the actual absolute path.

The CLI accepts doctor, enroll, run --once, run and revoke-local with --config followed by the absolute JSON config path. Set local variables to reviewed file paths and run these operator steps:

    & $NodePath $BridgeModule doctor --config $ConfigPath
    & $NodePath $BridgeModule enroll --config $ConfigPath
    & $NodePath $BridgeModule run --once --config $ConfigPath

Use pcCommandCenter.instanceId = pc-command-center in the shipped configuration: it must match the owner-selected cloud adapter's fixed endpointAlias exactly. The cloud does not infer or rename an instance from a device label. Configure pcCommandCenter.selectedGpuId and pcCommandCenter.selectedGpuAlias together, or leave both null for CPU-only telemetry. The ID selects the exact local collector GPU and stays on the device; the user-chosen opaque alias (at most 64 characters, for example owner-primary) must exactly match the cloud adapter's selectedGpuAlias. Only that alias is uploaded, including when the selected GPU or collector is unavailable. A missing or different alias is not silently mapped to another GPU. An absent selection keeps GPU readings unknown rather than using the first GPU. Historical heartbeat bytes without an alias remain unchanged and carry no new GPU-binding claim.

Follow the shipped strict configuration schema. Never put credentials in arguments or config, add arbitrary endpoint paths, or configure execution commands. Enrollment uses masked interactive input. Confirm owner, device and privacy before enrolling. Unsupported ingress must remain visibly disconnected. An absent collector stays absent; doctor and run never launch it.

Credentials use DPAPI CurrentUser with fixed non-secret application entropy. The fixed PowerShell script accepts only -Mode Protect or -Mode Unprotect. Plaintext JSON and protected base64 travel through redirected private anonymous stdin/stdout pipes; console use is refused. Plaintext is limited to 16 KiB. Only ciphertext is persisted; decrypted values are not console output, arguments or logs. A copied protected blob does not enroll another device. Verify actual current-user NTFS permissions locally: POSIX mode hints do not prove Windows ACLs. Memory clearing is best effort, not protection against a compromised process already running as the same user.

State uses the config's sibling .control-room-bridge directory, including credentials.dpapi. Preserve pending outbox identities during uncertain delivery. Local credential removal does not prove remote revocation; use the authenticated owner workflow when available.

After the one-shot checks and supported ingress decision, explicitly install startup:

    & $InstallScript -NodePath $NodePath -ConfigPath $ConfigPath

The installer validates local absolute regular files, rejects quotes/control characters/alternate data streams/reparse-point files, requires Node 24, and resolves the fixed packaged CLI and launcher. One task under the ControlRoom task folder is named from the current Windows SID. It triggers after that same user logs on with Interactive limited privileges and IgnoreNew duplicate-instance policy. Existing task names are refused rather than overwritten. No administrator password or elevation is requested. Installation itself never starts the task.

The action is fixed system PowerShell with a hidden window and the packaged run-bridge.ps1 launcher. That launcher validates the same files and starts only Node with the fixed CLI run --config action, hidden, waiting for termination. Task Scheduler Hidden alone is not relied on for process window behavior. Actual hidden-window, logon/reboot and task-child termination behavior remain Windows acceptance steps.

Run uninstall-task.ps1 from the same package location and Windows user. It validates the exact task name, folder, description, fixed launcher/action, principal, working directory and single logon trigger before stopping/removing that task. An altered or unrelated task is refused. Config, protected credentials, outbox and other local data remain for explicit review and cleanup. Neither script changes another service, registry startup entry or collector setting.

Run bridge fixture tests before handoff. PowerShell structural checks inspect source boundaries; they execute neither PowerShell nor DPAPI/Task Scheduler and cannot substitute for actual Windows evidence.
