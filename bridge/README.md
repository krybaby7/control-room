# Control Room Windows bridge

Requires Node24 and a supported renewable private Site service credential adapter. That adapter is not available in this package; the default transport stops with private_ingress_unavailable. Telemetry enrollment alone cannot bypass private hosting or activate execution. Keep the existing Site private.

Unpack this npm tarball into a dedicated directory. Review windows/install-task.ps1, windows/run-bridge.ps1 and windows/protect-credential.ps1 before installation. Copy config.example.json into the current user's private ControlRoomBridge configuration directory and explicitly choose the private Site origin and device enrollment. Supply enrollment secrets through the CLI's private interactive/stdin flow; never command-line arguments. GPU selection requires an owner-chosen opaque alias paired locally with the collector's GPU ID; only the alias is uploaded.

Run node src/cli.mjs doctor --config ABSOLUTE_CONFIG_PATH before enabling telemetry. The doctor never starts a collector or model. The fixed PC reader uses numeric loopback port47631 health and snapshot-summary routes only. Configure a current-user limited task with the supplied installer only after local review; installation does not start it. The uninstaller removes only its exact task and preserves credentials/configuration/spool data.

Windows DPAPI, Task Scheduler, power/reconnect, collector and real private ingress acceptance remain local operator checks. See repository docs/verification/windows-bridge-acceptance.md and docs/integrations/windows-bridge.md. No trade, shell, deployment or paid inference capability is enabled.
