# Private history collector 0.1.0

This dependency-free Node 24 collector reads explicitly selected local Codex or Claude Code history. It does not install itself, create source chats, run paid providers or execute transcript instructions. Native private ingress is a separate required deployment gate; the default transport refuses delivery until a verified ingress provider is supplied.

## Build and verify the handoff

From a committed checkout, run `node scripts/package-history-collector.mjs` at the repository root (or add `--output <directory>` for a separate handoff location). The deterministic ZIP and external `manifest.json` are written to `release/history-collector/`. The builder verifies every packaged file against the indicated Git commit. Unrelated working-tree edits do not affect the package. Modified packaged files must be committed before building.

Verify the ZIP SHA256 against the external manifest through a trusted handoff, then extract into a dedicated current-user package directory. The ZIP contains only the closed runtime, readers, adapters, this README and four Windows scripts. It contains no config, selected private roots, enrollment, credentials or spool. `package-manifest.json` inside the ZIP binds the source commit, version and SHA256 of every package file; the external `manifestSha256` is the value required by the installer. Hashes identify bytes; obtain the external manifest from a trusted channel.

No `npm install` is needed. With Node 24 or later, invoke `node src/cli.mjs status --config <absolute-private-config.json>` from the extracted directory. Configuration and enrollment are separate owner-authorized steps. Runtime scopes are exactly `history.read` and `history.ingest`; a broad agent credential is insufficient. Use a separate current-user state directory and never place private state inside this package directory.

## Windows installation requires explicit enrollment

Use one selected source per Windows task. Store config/state under `%LOCALAPPDATA%\ControlRoomHistory\SHA256(sourceId)`. Protect the separately issued finite-lived enrollment using `windows/protect-credential.ps1` through stdin; do not put tokens in command arguments. Config must match the enrolled source, epoch and scope revision. See the repository operations guide for enrollment and private ingress handoff details.

Run `windows/install-task.ps1` with explicit absolute `-ConfigPath`, `-PackageDirectory`, `-NodePath`, the exact `-SourceId`, trusted `-ExpectedManifestSha256`, and `-ConfirmInstall`. It verifies package hashes, current-user state and enrollment before registering a limited task for the current logged-in user. No password or service is installed. `windows/uninstall-task.ps1 -ConfirmUninstall` removes the task while preserving state and evidence.

`import` makes one bounded acquisition/delivery attempt. Inspect `status`: a continuation cursor, paused acquisition or pending delivery means catch-up remains. `run` performs further bounded attempts and reconciliation. Preserve pending spool entries during full-disk, connectivity or credential failures; retry immutable pages unchanged.

Windows ACL/DPAPI/Task Scheduler behavior, restart/power-loss recovery, native private ingress and live source receipt/readback require actual verification on the authorized machine. Package integrity tests do not establish those live capabilities.
