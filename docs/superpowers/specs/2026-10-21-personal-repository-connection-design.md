# Personal repository connection

The owner requests a personal dashboard that connects seamlessly to the existing Codex and Claude Code subscriptions, browses for a local repository, runs analysis with the explicitly selected provider and refreshes the latest working-tree changes. Routine UI must expose no port, pairing code, test-connection button or report-file download/import.

## Owner workflow

Repositories is the primary navigation entry. Show this PC's current connection and separate Codex/Claude readiness in plain language. Choose folder creates one explicit owner request and opens the Windows folder picker through the signed-in user's local app. The chosen absolute path stays on that PC; the Site receives only opaque repository identity/name/current head/dirty state. Select an existing project or derive a new project name from the folder, choose Codex or Claude Code, then Analyze. Save the returned report through the signed-in owner's existing immutable evidence command. Repository cards provide Analyze latest changes and latest analysis time. Cancellation, offline state, sign-in needs and delivery interruptions have specific recovery text.

Main navigation retains Today, Projects, Repositories, Inbox and Weekly planning. Existing attention/history/evidence/source/runtime/agent surfaces remain reachable under More. Do not remove records, routes or existing capabilities.

## Personal PC channel

Use a dedicated bounded outbound HTTPS channel rather than browser-to-loopback fetch. Preserve the existing manual 15-minute execution bridge and its authorization contract unchanged. The running Site remains owner-private. Supported Sites service access uses its existing dispatch bearer only for this Site; an independent high-entropy device key authenticates a narrower personal repository endpoint. The fixed owner/device/origin/key hash is private runtime configuration. Both local secrets are protected with Windows DPAPI and private user/System ACLs. No token is printed, committed, embedded in the browser or added to the downloadable package. No broad bypass token is created or rotated.

Only signed-in owner requests enqueue folder selection or analysis. Device credentials can poll assigned requests, report readiness/repository metadata and deliver bounded results; they cannot create owner requests, select arbitrary commands or invoke a general shell. Each analysis immutably binds request ID, local repository key, project ID and provider. Queue claims expire and are never automatically re-executed. A lost response retries status/result delivery only. Pending results survive PC or browser restarts and retain original project association. Owner-only disconnect/reconnect changes the device state/epoch. Imported connection backups restore disconnected with pending execution interrupted.

A dedicated exportable owner module stores at most 16 repository descriptors and 20 bounded jobs. Never evict an unsaved completed report. The owner browser performs the existing local-analysis.save transaction; the device does not impersonate owner audit commands. Server acknowledgement verifies saved run identity/hash/project before consuming a result. Existing planning and immutable evidence remain intact.

## Local app and providers

Use fixed checked-in PowerShell for the Windows folder picker, protected credential storage and a per-user startup shortcut. Register a fixed controlroom://open launcher so the dashboard can offer Start Control Room if this app is closed. Ignore arbitrary URI arguments. No administrator account or broad remote command facility is added.

Keep one finite model call per explicit analysis. Codex still requests exactly gpt-6.1-sol. Claude Code uses its existing personal subscription and configured/default model, with requestedModel claude-code-default and observed runtime identity only when actually supplied. Its adapter disables tools/MCP/customizations/persistence, denies execution, guards applicable managed policy and validates terminal structured output. Neither provider falls back to a paid API or a different provider automatically. Retain the existing source exclusions, read-only snapshots, bounded concise-user chat selection and cloud-history boundary.

## Verification

TDD covers owner/device authority, expiry/cancel/replay, immutable association, delivery-only retry, queue limits, restoration without execution, native picker outcomes, DPAPI failures, provider readiness/arguments/output and legacy reports. Verify private deployment, both installed provider readiness states, automatic report persistence and refresh without planning changes. Synthetic tests must not execute provider calls or read real chats. Keep all live private evidence outside public source; preserve unrelated work in the original checkout.
