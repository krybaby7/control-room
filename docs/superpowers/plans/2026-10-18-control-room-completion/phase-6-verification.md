# Phase 6 cloud verification

Current integrated source before documentation: `96b4738cedbbe510cc94bb72824846a2c6e55072`.

## Implemented boundary

Owner commands create one-time telemetry enrollment, configure the registered PC summary reader, revoke device capabilities and select exact immutable dated runtime evidence. Plaintext enrollment secrets are returned once, are never persisted in receipts/audit/export, and uncertain saves retain their original mutation. A committed response lost in transport cannot regenerate the secret: the owner explicitly revokes/replaces it.

Private bridge ingress and device credentials are independent mandatory gates. Production ingress is unavailable by default. No browser cookie, invented owner header, Site access relaxation or arbitrary shell is used. Telemetry does not enroll execution scopes. The bridge reads fixed numeric loopback health and snapshot-summary routes only; no collector is started.

Server-issued thirty-second windows precede sampling and bind owner/device/boot/generation/sequence. First expired delivery and offline retries remain history. Identical canonical heartbeats return their original classification; changing the transport envelope cannot promote history to live. Source timestamps and missing metrics stay explicit; receipt time is not a sample timestamp. Raw telemetry is bounded/retained separately from owner-selected evidence and portable history. Restore clears private device authority before replacing portable parents; imported configurations are disabled and selected evidence historical.

The locally installable Windows source package uses CurrentUser DPAPI via private pipes, fixed hidden PowerShell/Node entrypoints, current-user limited Scheduled Task registration, no automatic installer start and uninstall preserving local data. Actual Windows installation, DPAPI, Task Scheduler, power/reconnect and physical collector acceptance are not run here.

## Exact observed checks

| Source / run | Result |
| --- | --- |
| Phase5 `af221ccf`, CI39161269563/job117774922683 | Terminal success:1301Node,48defaultChromium,3R2Chromium, locked install/type/lint/build and D1/R2/HTTP gates |
| Bootstrap `6cee529d`, schema39162797902/job117779442767 | Node24 locked install and Drizzle generation terminal success; migration0021 plus journal/snapshot emitted and reviewed additive-only |
| Runtime `0f1b20c9`, CI39163245805/job117780791323 |1343Node,1326passed/17failed. New device/ingest/retention checks passed, including actual eight-source Miniflare D1 depth/rollback.17old registry fixtures corrected in51dc; no pass claimed for that failed run |
| Integrated `51dc1b4f`, CI39163449560/job117781402444 | 1360Node/1359passed/1failed: HTTP helper used a parameter property unsupported by Node strip-types; fixed in this follow-up. No final acceptance claimed |

## Remaining acceptance

Finish exact integrated Node/bridge/type/lint/build and D1/HTTP/native-browser gates; integrate full runtime D1 acceptance fixture and regressions found during integration. Package/source hashes will be recorded for the coherent candidate. Supported private ingress acquisition/renewal, real Windows/device/collector checks and owner hosted acceptance require their actual environments. No new Site release or live provider/device/model execution is claimed.
