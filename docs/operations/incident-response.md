# Incident response

This runbook covers the source implementation. The completion candidate is not a newly published hosted release. Keep the existing private Site, owner access and data intact. Paid inference and trading/exchange execution remain off.

## First response

Stop repeating the affected action. Keep the original command, mutation ID and draft in the protected owner session. Record the UTC time, exact source/artifact or deployed version, sanitized diagnostic code and request/correlation ID if the response provides one. Public issues and release reports must exclude owner IDs, command bodies, lease tokens, provider responses, private filenames, paths and screenshots containing owner content.

Use the signed-in application's controls or authenticated same-origin reads below. Never supply an owner ID in a request to select another namespace. A failed health read means unknown, not empty.

| Symptom | Read-only check | Safe next action |
| --- | --- | --- |
| Save timed out or response lost | `GET /api/workspace/mutations/<originalMutationId>` | If committed, refresh the saved workspace. If not-found, the first request can still commit: reconcile/retry only the unchanged original ID/body. If retired, stop retrying; retain the draft for explicit new review. |
| Revision conflict (409) | Current workspace and the retained field comparison | Review current values, preserve unrelated changes, then explicitly submit the reviewed command against the new revision. Never force overwrite or silently create a second submission for an uncertain first one. |
| Authentication expired (401) | Sign-in/session state | Sign in as the intended owner. Private views and replay stop on expiry. Reopen the protected draft after identity verification; another owner must not inherit it. |
| Storage unavailable or unknown write | Original mutation outcome, then workspace read | Preserve the original identity. Do not infer rollback from a 503 or clear local recovery state. Escalate if reconciliation remains unavailable. |
| Unsupported/corrupt import | Owner import preview and downloadable staged data | Retain the original file, review diagnostics and explicit repair child previews. Never edit database JSON to bypass a validator. |
| Quota or recovery-capacity refusal | `GET /api/workspace/usage` and backup/file state | Follow [capacity](capacity.md); preserve receipts, history and unresolved physical claims. |
| Backup failed or file bytes missing | Backup manifest/archive download and actual digest/byte verification | Keep the last verified complete point. Do not call metadata-only fallback a successful file backup. See [backup/restore](backup-restore.md). |
| Source stale or provider unavailable | Source state, last success, observations and run history | Preserve last-good observations; inspect configuration/scope and retry deadline. See [connectors](connectors.md). |
| PC offline or job lease uncertain | Runtime age and job detail/events | Do not infer process exit or release its slot. See [jobs](jobs.md). |

## Escalation and containment

Use explicit pause/cancel/revoke controls appropriate to the affected source, schedule or device. They prevent future authority; they do not prove an already launched process or ambiguous PUT stopped. Preserve unknown attempts, event journals, original receipts, pending tokens and physical fences.

A suspected credential exposure requires the owner to revoke/rotate it through the actual issuer and the corresponding enrolled connection/device control. Do not paste it into a report or copy browser credentials. Reconnect only after supported authentication is verified.

Before an operator data intervention, retain a verified private export/recovery point and exact inventories. Follow [privileged maintenance](recovery-maintenance.md) for a reviewed inactive replacement. Never reset/reseed the workspace, delete private rows to make checks pass, apply destructive down migrations or change hosted bindings as an incident shortcut. If trusted operator access, exact candidate identity or recoverable bytes are unavailable, leave the operation blocked and hand over the sanitized evidence.
