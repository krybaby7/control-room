# Owner and physical-device acceptance

Status: not observed. This checklist does not grant release acceptance. Use the exact source, application artifact digest and private saved/deployed version from the final release evidence. Do not substitute the bridge archive for the application artifact. Open the existing owner-private Site from its authenticated dashboard; do not create another Site or publish credentials/records in this repository.

## Private hosted checks

- The owner completes normal sign-in and any passkey/biometric prompt on their own device. Never export a browser profile, credential, token or passkey.
- Confirm the recorded version and source identity, existing project records and saved revision. Read Sources freshness labels, export/backup availability, job/device states and operational health. A recorded backup catalog is not fresh verification of file bytes.
- In a separate unauthenticated session verify private access is denied. Confirm sign-out/session expiry hides protected data. Do not copy gateway identity headers or bypass the gateway.
- Keep production checks read-only and use an isolated synthetic workspace for writes, conflict/replay, draft recovery, uploads/downloads and restore rehearsals. Never reset or reseed production for a test.

## Actual PC, phone and tablet

For each owned device, record only sanitized OS/browser/version, actual date, source/artifact/version, procedure and observed result. An unavailable device remains unavailable; viewport emulation is a separate result.

- Check keyboard and touch navigation, focus, modal scrolling, rotation, on-screen keyboard and long forms. Check downloads/uploads only with synthetic files in the isolated workspace.
- Test server draft recovery and explicit discard in isolation. Trusted-device storage stays off until explicitly enabled; verify lock/unlock/Forget and session-expiry behavior without placing secrets in drafts.
- On Windows, follow the packaged [bridge instructions](../../../bridge/README.md) and [executor boundary](../../../bridge/executor/README.md). Validate package/source hashes before installation. Confirm the actual account-scoped DPAPI credential, scheduled task, collector allowlist, boot/session identity and private ingress connection. A Linux or synthetic Windows runner is not that installation.
- Verify actual heartbeat/telemetry arrival, disconnect/offline labeling and credential revocation. Do not infer physical GPU/process/runtime behavior from fixture JSON.
- General agent execution remains unavailable until the exact pinned runtime, executable, sandbox, owned-process supervisor, confirmed finite private ingress window (or separately verified renewable access) and owner budget/approval are installed and verified. Never replace that boundary with a remote shell.

## Recording observations

Use the separately reviewed observed-attestation format in [release verification](../../operations/release-verification.md). Record a pass only after the exact procedure is observed; retain limitations and failed checks. Do not create an attestation to clear a gate.

Provider consent/resource selection, unattended closed-browser execution, external notifications, private SSE, paid inference and trading effects each have their own activation and acceptance boundary. Paid inference and operational/trading effects remain disabled. Physical planning acceptance does not accept an underlying product release, trading strategy or profitability claim.
