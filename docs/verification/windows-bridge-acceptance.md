# Windows bridge acceptance record

**Windows acceptance NOT RUN. Private ingress acquisition and renewal NOT VERIFIED.** This is an evidence boundary, not installation or live hardware proof.

| Check | Cloud evidence boundary | Actual device / private deployment |
| --- | --- | --- |
| Source version and artifact digest | Integrator records exact packaged source and SHA-256 later | Compare download; NOT RUN |
| Node 24 and strict config | Structural/package tests, once Actions runs them | Installed executable/config; NOT RUN |
| Credential handling | Fixed modes, private pipes, bounded plaintext and CurrentUser inspected by windows-package.test.mjs; checks NOT RUN until Actions | DPAPI round-trip, console refusal, changed-user refusal and actual NTFS ACLs; NOT RUN |
| Task installation | Fixed current-user limited logon action inspected by structural tests; checks NOT RUN until Actions | Non-elevated install, hidden runtime window, one instance, correct user after logon; NOT RUN |
| Task uninstall | Identity guard before exact stop/removal; no data deletion | Altered task refused; unrelated tasks untouched; child exits; data retained; NOT RUN |
| Private ingress | Unsupported default and synthetic protocol fixtures | Supported acquisition, expiry, renewal, endpoint scope and revocation; NOT VERIFIED |
| Device mapping | Synthetic owner-bound authentication fixtures | Intended owner enrollment and actual mapped telemetry credential; NOT RUN |
| Collector and observations | Sanitized synthetic allowlist data only | Real collector version, readiness, sample age and timestamps; NOT RUN |
| Outage/recovery | Fixture behavior only | Source absent, network absent/reconnected, ingress expiry, credential revoke and new boot generation; NOT RUN |
| Operational boundary | No service/model launcher or execution selector | No process lifecycle/trading changes; NOT RUN |

Record exact commands, exit status and redacted output locations when executed. Do not add private account/device identifiers, local absolute paths, credentials, sessions, full diagnostics or hardware inventory to this public document. Keep operational evidence private. Redact screenshots. Source/build identity, package digest and intended private deployment identity belong to final release evidence; they are not invented here.

After explicit local installation/connection authorization:

1. Verify reviewed package digest, Node 24, strict config and actual NTFS permissions. Keep operational adapters disabled.
2. Run doctor against the already-running collector. If absent, record source_unreachable; do not start a service to satisfy acceptance.
3. Resolve the supported private-ingress gate. If unsupported, stop activation and retain disconnected state.
4. Enroll through masked input and run once. Compare server received time, actual source sample time/readiness and null/unavailable metrics. HTTP success is not collector health.
5. Exercise outage/recovery using synthetic outage fixtures where possible. Never stop a real trader. Confirm last successful values remain visibly dated/stale and unknown never becomes zero.
6. Exercise revocation, ingress expiration/renewal and new bridge boot generation. Same-identity retries must not duplicate history; retired generations must not become current.
7. Explicitly install the current-user task. Sign out/in or reboot as appropriate; verify limited privileges, hidden window, fixed action, no secret arguments and one instance.
8. Uninstall; verify only the matching task and child bridge stop, unrelated tasks/services remain intact, and protected local data remains. Altered identity must refuse removal.

Mark each result PASS, FAIL, BLOCKED or NOT RUN with timestamp and redacted evidence. Only real execution replaces NOT RUN; cloud fixtures alone do not complete device acceptance.
