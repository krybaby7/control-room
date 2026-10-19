# Jobs and uncertain execution

Queues store intent and receipts, not proof of an external effect. Inspect job state and provenance before retrying. Paid analysis and operational/trading effects are disabled in the current release boundary; the production subscription runtime reports not_installed.

## Owner inspection

Agent jobs have owner-scoped list/detail and paginated events at `GET /api/jobs`, `GET /api/jobs/<jobId>` and `GET /api/jobs/<jobId>/events`. Review the immutable specification, exact provider/model/effort and runtime/tool-policy pins, task snapshot, attempt identity, event sequence/hash, outcome and ready artifact descriptors. Historical imported records are not live authority. A file download proves bytes, not execution compliance or accepted work.

Explicit owner approval is bound to one job/device/specification, execution binding and finite budget. Cancellation/rejection/acceptance are separate reviewed owner actions. Acceptance never applies a patch or completes a task automatically. Do not manufacture approvals or invoke bridge routes from a browser session.

Source/automation runs expose their own bounded histories through `/api/sources/<id>/runs` and `/api/automations/<id>/runs`. Inspect pending, retrying, failed and paused state there; there is no generic dead-letter reset command.

## Leases, retries and reconciliation

- Retain the original claim nonce, event bodies, sequence/hash, mutation IDs and durable local journal before writes.
- A response loss does not prove a failed claim or effect. Reconcile the original identity; never create another attempt merely to get a clean response.
- Lease renewal must keep exact owner/device/epoch/configuration authority and cannot extend the original job deadline. A stale/revoked lease cannot dispatch.
- An expired or unknown process is not an exited process. Retain its occupied slot and budget reservation until actual no-launch/exit proof permits reconciliation. Never clear a journal, cancel flag or pending token by age.
- Partial/retry source work continues the same intent/cursor/occurrence. Terminal failure or exhausted retry requires inspection and an explicit supported new request, not a hidden retry loop. No manual action may erase earlier receipts or claim a failure succeeded.

The shared service runners require registered exact scopes and current native authority. `POST /api/automations/run-due` is an authenticated service boundary, not a public cron URL or owner credential shortcut. A scheduled-source run requires both automation and selected-source authority. Restores revoke operational epochs and pause dispatch; imported schedules do not become active principals.

## Local bridge and notifications

The opt-in executor still fails closed before configuration, claim, worktree or model launch because no pinned production runtime is installed. Fixed Git workspace preparation is not a sandbox or Windows whole-process-tree supervisor. Follow [agent execution](agent-execution.md) and its upstream/Windows acceptance handoffs; do not substitute an arbitrary shell, provider CLI or paid API.

In-app notifications retain their exact fact identity and first event/citation. Mute and Cairo quiet hours affect presentation, not event retention or job execution. External push/email delivery is disabled unless a real supported authorized delivery path is implemented and verified; a visible notification is not delivery proof.

For an offline PC, inspect the last received/observed times and local doctor output without disclosing paths or credentials. Restore supported ingress/device authentication and reconcile the protected journal before any new explicit work. Cloud fixtures do not prove actual Windows cancellation, sandboxing, provider model identity or physical device acceptance.
