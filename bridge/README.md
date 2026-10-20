# Control Room Windows bridge

Requires Node24. The finite manual owner-private Sites adapter described below is implemented and disabled by default; a renewable service credential adapter for unattended operation is not supplied. Without configured private access, transport stops with private_ingress_unavailable. Telemetry enrollment alone cannot bypass private hosting or activate execution. Keep the existing Site private.

Unpack this npm tarball into a dedicated directory. Review windows/install-task.ps1, windows/run-bridge.ps1 and windows/protect-credential.ps1 before installation. Copy config.example.json into the current user's private ControlRoomBridge configuration directory and confirm the fixed existing Site identity and explicitly configure device enrollment. Supply enrollment secrets through the CLI's private interactive/stdin flow; never command-line arguments. GPU selection requires an owner-chosen opaque alias paired locally with the collector's GPU ID; only the alias is uploaded.

Run node src/cli.mjs doctor --config ABSOLUTE_CONFIG_PATH before enabling telemetry. The doctor never starts a collector or model. The fixed PC reader uses numeric loopback port47631 health and snapshot-summary routes only. Configure a current-user limited task with the supplied installer only after local review; installation does not start it. The uninstaller removes only its exact task and preserves credentials/configuration/spool data.

Windows DPAPI, Task Scheduler, power/reconnect, collector and real private ingress acceptance remain local operator checks. See repository docs/verification/windows-bridge-acceptance.md and docs/integrations/windows-bridge.md. No trade, shell, deployment or paid inference capability is enabled.

The separate execution entry point is `executor/cli.mjs`. Version 0.3 includes the bounded coordinator, verified private-runtime installer, nonce recovery and original Windows owned-process helper source. See `docs/integrations/subscription-executor.md` in the repository and `windows/owned-process/README.md` in this package for the installation boundary. The private runtime itself is supplied separately under its own review and exact archive/source pins. The disabled launch example is `executor/launch-config.example.json`; the legacy invocation remains disabled. No renewable private ingress adapter or provider account is supplied by this package.

Manual owner-private Sites access is optional and disabled by default. Immediately after confirming this deployment is still owner-private with the native Sites service, import its supported service bearer through the masked prompt:

```powershell
node src/cli.mjs sites-access --config C:\private\bridge.json --confirm-owner-private --until FUTURE_UTC_CUTOFF
node src/cli.mjs sites-access-remove --config C:\private\bridge.json
```

Replace FUTURE_UTC_CUTOFF with an ISO UTC timestamp at most 15 minutes after import. The matching server release window must also be configured through supported server environment configuration; local import alone does not activate bridge routes. See the repository subscription-executor integration guide for that boundary. This is a local release cutoff, not verified issuer expiry. The separate Windows DPAPI record sends the documented Sites authorization header only to the fixed Site and supported bridge routes. Device credentials and consent remain independently required. A 401/403 invalidates the record. Manual access permits `run --once`; it supplies no unattended renewal or continuous scheduling.
