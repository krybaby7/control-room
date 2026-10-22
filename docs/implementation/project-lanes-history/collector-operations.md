# Private history collector operations

The Node 24 collector implements local acquisition and delivery against frozen history v1 contracts. It has not been installed, run against private histories, or verified unattended. Cloud collection and private Sites ingress remain unconfigured. No paid inference, source chat writes, or telemetry permissions are enabled.

## Explicit setup

Use a dedicated current-user directory with POSIX mode 0700 or a Windows current-user-only ACL. Configuration, credentials and spool are separate. Configure only approved absolute provider roots. The scopes must be exactly `history.read` and `history.ingest`. `origin` must be the existing trusted private Site origin; alternate origins require an explicitly supplied trusted deployment list in server code, never provider data.

Configuration version 1 contains `origin`, `stateDirectory`, `sources` (the frozen `SourceConfiguration` records), `scopes`, `reconcileIntervalMs` (300000), `debounceMs` (5000), and `maxCatchUpLagMs` (600000). Unknown keys and telemetry scopes fail closed. Never put a token in configuration, command arguments, logs, or a transcript.

Run `node collector/src/cli.mjs configure --config <absolute-private-config.json> --input <absolute-selected-config.json>`, then `import`, `status`, or `run` with the same explicit `--config`. CLI diagnostics expose typed state/counts, not private paths, raw chats or tokens. `import` retains acquired pages when delivery is unavailable. The default private-ingress dependency refuses every upload: a valid application credential is insufficient to prove private Sites ingress. A verified deployment must explicitly supply its independent ingress provider before live delivery can be claimed.

## Durable boundaries and recovery

Each page first becomes a durable acquisition draft plus separately hashed local assets. Only then may its acquisition cursor advance. Upload results map LOCAL asset keys to server-generated opaque keys. The collector persists each known finalized upload, then atomically flushes the entire resolved envelope and digest **before the first metadata send**. Unknown metadata responses retry those exact bytes; uploaded keys and page identity never change after this boundary.

A matching durable server receipt precedes the acknowledged cursor. Only acknowledged pages with the matching durable checkpoint are pruned. Acquisition and delivery checkpoints never share a cursor. Monotonic local acquisition sequences prevent an older completed sweep from rewinding a restarted checkpoint. Changed epoch/scope uses a fresh checkpoint; old unacknowledged pages remain retained and visible rather than being silently reclassified.

The spool defaults to 128 MiB and 1000 entries, including reserved delivery metadata. Full/corrupt storage stops acquisition and leaves its checkpoint intact. Never delete pending data as telemetry overflow handling. Recovery removes only interrupted temporary writes before acquisition while holding the process instance lease; committed entries with bad hashes stop the collector for operator inspection. Kernel-held single-instance exclusion releases on process exit and avoids stealing an active PID-file lock. Atomic file flush/rename is used; directory flush is attempted where supported. Windows directory fsync limitations remain a platform limitation requiring actual restart/power-loss proof.

Watchers are hints. Startup and periodic inventories remain authoritative. Full streamed fingerprints catch changed content with preserved timestamps; truncated/replaced/compressed segments restart at safe offsets. Incomplete final JSONL records do not advance the complete-record offset. Scans are paged and interrupted work retains the prior checkpoint. Large raw objects must be split by the reader or represented as gaps; the collector never silently truncates a page.

## Windows enrollment and installation

The installer does nothing without `-ConfirmInstall`, explicit absolute paths, a selected enrolled source, Node 24+, a complete package manifest and its independently supplied SHA-256. Root packaging must generate `package-manifest.json` listing every runtime `.mjs`, `.json`, and `.ps1` file; no unlisted executable source is accepted. The manifest version is `0.1.0`. Packaging and a release manifest are separate deliverables; this task does not create an installation on the owner's computer.

Protect enrollment JSON through stdin with `windows/protect-credential.ps1 -CredentialFile <state/credentials/SHA256(sourceId).dpapi>`. The script uses Windows CurrentUser DPAPI and a current-user-only protected ACL; do not paste its token into a shell command. The Node Windows credential reader invokes only that fixed packaged script with arguments, never a command from transcript/configuration. Expired or rotated credentials stop delivery; renewable enrollment is not implied.

`windows/install-task.ps1 -ConfigPath ... -PackageDirectory ... -ExpectedManifestSha256 ... -SourceId ... -NodePath ... -ConfirmInstall` registers the current logged-in user's limited task with IgnoreNew and bounded restart backoff. It does not store a Windows password or install a service. A logged-out user is outside this installation mode. `windows/uninstall-task.ps1` requires `-ConfirmUninstall`, stops the task, and preserves credentials/spool/evidence. Removing those bytes is a separate explicit action.

## Activation proof still required

On the authorized machine, prove initial import, terminal/browser closure, an actual later or resumed conversation, durable hosted receipt/readback, restart, network interruption/reconnect and credential revocation. Use existing authorized activity; do not create source chats merely to manufacture evidence. Record sanitized versions/counts/latency and receipt references in the verification ledger. Native private ingress, Windows ACL/DPAPI/task behavior and each cloud provider remain separate live gates.

The first-seen index retains unchanged revision `observedAt` and `sequence`, keyed by source/revision/digest, across reordered rescans. Role, parent, native ID or conversation changes require explicit provenance. A repeated gap ID retains its original detection time; materially changed explanation/kind/conversation requires a new ID. Finalized asset mappings are also durable across pages/runs within the enrolled epoch/scope. These bounded indices count toward backpressure and are never silently evicted.

An explicit authentication denial or cursor conflict blocks that source's local acquisition/delivery checkpoint. Resolve the enrollment/scope conflict, then explicitly run `configure` with the approved source selection to clear the local block. Existing pending evidence stays retained. This does not bypass server authorization. Expired credentials and an unavailable ingress provider cannot make delivery appear successful.

Windows uses the dedicated `%LOCALAPPDATA%\ControlRoomHistory\SHA256(sourceId)` state directory with a one-source configuration. The installer restricts its ACL to the current user. Runtime checks refuse other-user access or reparse points through the fixed packaged `check-private-path.ps1`; this implementation still requires actual Windows verification.

Each `import` invocation performs at most five acquisition pages per source. An empty delivery queue does not establish inventory completion: its JSON result and `status` include `complete`, `catchUpRequired`, and persisted `continuations` with acquisition/acknowledgement cursors. Repeat `import` or leave `run` active to resume the next bounded attempt. Newly configured or interrupted inventories remain incomplete even when no packet is queued. Pending delivery is recovered and drained before new acquisition, so a full spool can free acknowledged space; acquisition backpressure never suppresses delivery of already queued immutable packets.
