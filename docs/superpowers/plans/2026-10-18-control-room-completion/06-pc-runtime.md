# PC Telemetry and Runtime Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show trustworthy PC and configured runtime status in the private Control Room by reusing the existing Windows PC Command Center collector through an outbound, read-only bridge.

**Architecture:** Keep Windows hardware collection in PC Command Center and send a small allowlisted projection to owner-scoped D1 tables. A device credential supplies application identity; supported private Sites service ingress supplies network access and is a separate prerequisite. Browser reads use the existing authenticated owner boundary; Windows services stay on loopback and are never exposed to the internet.

**Tech Stack:** Existing Vinext/React/TypeScript app, D1 and existing transaction boundary, Node.js 24 bridge with standard-library HTTP, Windows user-scoped credential protection, existing Python/FastAPI PC Command Center.

---

## Scope, prerequisites, and evidence

This is a future implementation plan. Only source and documentation were inspected for planning; neither local service was queried or started. No hardware, runtime health, credentials, model execution, process lifecycle, or trading state was verified. All example payloads below are synthetic fixtures.

The cloud repository is `project-control-center`. Its current persistence is the workspace JSON record in `db/schema.ts`; its existing routes demonstrate authenticated user ownership in `app/api/workspace/route.ts`. Use Phase 1's `lib/workspace-transaction.ts` for an atomic owner-scoped mutation, receipt, and event whenever a control-plane mutation changes workspace-linked state. High-frequency telemetry uses its own narrow store transaction and must not rewrite the workspace JSON or increment its editor revision.

The local source inspected on 2026-10-18 provides these reusable interfaces:

| Evidence path on the Windows handoff machine | Observed contract | Consequence |
| --- | --- | --- |
| `<PC_COMMAND_CENTER>\command_center\server.py:10` | Host is restricted to `127.0.0.1`; default port is `47631`. | The cloud cannot call this local URL. Keep the listener unchanged. |
| `<PC_COMMAND_CENTER>\command_center\app.py:180` | Loopback Host, same-origin checks, no-store responses, token protection on POST. | Bridge makes numeric-loopback GETs only and never fetches `/api/session`. |
| `<PC_COMMAND_CENTER>\command_center\app.py:234` | `GET /api/health` and `/api/diagnostics` expose collector/provider freshness. | A successful network response is separate from a healthy collector. |
| `<PC_COMMAND_CENTER>\command_center\app.py:262` and `command_center\service.py:27` | `GET /api/snapshot?detail=summary` omits `processes`; the first missing snapshot returns 503. | Reuse summary telemetry; do not implement a second hardware scanner. |
| `<PC_COMMAND_CENTER>\command_center\service.py:33` | `ready` requires a recent sample (at most ten seconds), worker availability, and running collector state. | Preserve reported readiness; do not infer it from a cached numeric value. |
| `<PC_COMMAND_CENTER>\command_center\app.py:308` and `:391` | Read-only integration/capture summaries exist. Starting an Ollama benchmark or PresentMon capture requires POST. | Read-only default never starts inference, capture, or an OS change. |
| `<PC_COMMAND_CENTER>\docs\contract.md` | Schema 1 JSON uses snake_case; readings can be null; provider gaps and sample coverage are explicit. | Translate at the boundary; null does not become zero. |

The local paths above are evidence references, not requirements for the cloud checkout. Copy the sanitized shapes below into committed fixtures. The cloud worker must not attempt to read a `C:` path, run the local launch scripts, install drivers, or modify the PC project. PC Command Center remains separately maintained.

### Required private-service ingress decision

Private Sites access and application device identity are different credentials. A Sites service bearer can permit access without a visitor identity. It is not evidence of `oai-authenticated-user-id`, and no device route may use a supplied owner ID, email, or browser identity header as its owner.

Before enabling any unattended bridge, prove a supported mechanism by which that Windows installation acquires and refreshes private-site service access. Record the supported header names, refresh/expiry behavior, endpoint restrictions, and deployment evidence without recording credential values. `X-Control-Room-Device` below is the application's additional device credential; it does not bypass private-site access. Do not hard-code a short-lived preview token, scrape a desktop credential, copy browser cookies, or expose the Site publicly to make polling work.

If unattended ingress is unavailable, complete cloud stores, API fixtures, UI, packaging, and the disabled Windows bridge, then report **cloud ready; unattended connection unverified**. A minimal authenticated relay is a distinct deployment choice requiring a documented supported ingress path and owner decision. A relay must retain mapped device identity and cannot manufacture visitor headers. This gate is a deployment limitation, not permission to weaken the owner boundary.

## File map

All paths below are relative to `project-control-center`, except the explicit Windows evidence paths above.

| Create or modify | Responsibility |
| --- | --- |
| Create `lib/devices/contracts.ts`, `lib/devices/auth.ts`, `lib/devices/store.ts` | Strict protocol, mapped device credential authentication, owner-scoped enrollment/revocation. |
| Create `lib/runtime/contracts.ts`, `lib/runtime/store.ts`, `lib/runtime/freshness.ts` | Sanitized observation schemas, monotonic ingestion, freshness projection. |
| Modify `db/schema.ts`; create the next migration named `*_devices_runtime.sql` | `devices`, `device_credentials`, `device_enrollments`, `device_heartbeats`, `runtime_observations`. Generate the numeric prefix after preceding phases land. |
| Create `app/api/devices/route.ts`, `app/api/devices/enrollments/route.ts`, `app/api/devices/[deviceId]/revoke/route.ts` | Browser-owned list, one-time enrollment, revoke. |
| Create `app/api/bridge/enroll/route.ts`, `app/api/bridge/session/route.ts`, `app/api/bridge/heartbeat/route.ts` | Service-ingress plus mapped-device routes; register a bridge generation before telemetry; no browser-owner inference. |
| Create `app/api/runtime/route.ts`, `components/runtime-view.tsx`, `components/runtime-card.tsx` | Owner-only read model and freshness-aware UI. |
| Modify `components/control-center.tsx` | Add Runtime navigation without changing the existing editor save/retry flow. |
| Create `bridge/package.json`, `bridge/src/cli.mjs`, `bridge/src/config.mjs`, `bridge/src/transport.mjs`, `bridge/src/pc-command-center.mjs`, `bridge/src/outbox.mjs`, `bridge/src/credentials.mjs` | Outbound bridge, fixed endpoint map, bounded outbox, credentials separate from config. |
| Create `bridge/windows/protect-credential.ps1`, `bridge/windows/install-task.ps1`, `bridge/windows/uninstall-task.ps1` | DPAPI protection and explicit current-user task installation/removal. |
| Create `tests/device-auth.test.ts`, `tests/runtime-ingest.test.ts`, `tests/runtime-freshness.test.ts`, `bridge/test/pc-command-center.test.mjs`, `bridge/test/transport.test.mjs`, `bridge/test/outbox.test.mjs` | Cloud ownership, replay, freshness, sanitization, and bridge failure fixtures. |
| Create `tests/e2e/runtime.spec.ts`, `lib/runtime/export.ts`; register owner tables in `lib/workspace-modules.ts` and export adapter through `lib/workspace-export.ts` | Runtime UI acceptance and bounded non-secret export/restore integration. |
| Create `tests/fixtures/runtime/pc-summary-v2.1.1.json`, `tests/fixtures/runtime/pc-health-degraded.json`, `tests/fixtures/runtime/pc-unavailable.json` | Synthetic examples derived from observed source contracts. |
| Create `docs/integrations/windows-bridge.md`, `docs/integrations/private-service-ingress.md`, `docs/verification/windows-bridge-acceptance.md` | Installation, supported ingress decision, Windows evidence and rollback checklist. |

## Contract and storage decisions

Use these exact normalized names. Each primary/foreign-key relationship includes `user_id`, matching the foundation's owner-scoped registry, so an ID belonging to another owner cannot be attached accidentally. `DevicePrincipal.ownerId` is the authenticated owner represented by that column. Device routes obtain that owner from a verified stored credential. Enrollment routes obtain it from the authenticated browser session. `device_enrollments` stores a hashed one-use 256-bit secret, owner, intended label, allowed scopes, ten-minute expiry, and consumed-at timestamp. Return the plaintext once in a no-store response; never in a URL or log. `device_credentials` stores only a digest, device ID, scope set, expiry, creation, and revocation timestamps. Credential rotation revokes the old credential after an overlap of at most five minutes; revocation is checked on every device request.

```ts
// lib/devices/contracts.ts
export type DeviceScope = 'telemetry:write' | 'evaluations:write' | 'jobs:poll' | 'jobs:report';
export interface DevicePrincipal {
  ownerId: string; deviceId: string; credentialId: string; scopes: readonly DeviceScope[];
}
export interface HeartbeatV1 {
  schemaVersion: 1;
  deviceId: string;
  bootId: string;                 // bridge-instance UUID; never an OS secret
  generation: number;             // server-issued session generation
  sequence: number;               // monotonically increasing within bootId
  sentAt: string;                 // UTC; diagnostic, not authority for lease time
  bridgeVersion: string;
  observations: RuntimeObservationV1[];
}
export interface RuntimeObservationV1 {
  source: 'pc-command-center' | 'agent-lab' | 'trade-graph';
  instanceId: string;             // configured opaque alias, never a local path
  observedAt: string | null;
  reportedAgeSeconds: number | null;
  state: 'ready' | 'warming' | 'degraded' | 'unavailable' | 'disabled';
  diagnostic: 'ok' | 'source_unreachable' | 'source_stale' | 'source_invalid' | 'not_configured';
  metrics: {
    cpuPercent: number | null; memoryPercent: number | null;
    gpuUtilizationPercent: number | null; gpuMemoryUsedBytes: number | null;
    gpuMemoryTotalBytes: number | null; gpuTemperatureC: number | null;
    diskReadBytesPerSec: number | null; diskWriteBytesPerSec: number | null;
    networkSentBytesPerSec: number | null; networkReceivedBytesPerSec: number | null;
  } | null;
}
```

The PC adapter selects one configured GPU ID, never whichever GPU happens to be first. It reports that selection and availability in a non-sensitive source descriptor; a missing selected GPU produces null GPU readings. A later multi-GPU view can add an explicit versioned array. Readings must be finite, percentages in `[0,100]`, byte/rate values nonnegative, and temperatures in `[-50,150]` or null. Reject unknown object keys. Max eight observations, 64 KiB body, twenty provider status entries, and one request per device per ten seconds with a bounded retry allowance. The source timestamp may be absent; it is never replaced with ingest time.

Sanitized source fixtures contain only this subset of the inspected PC API:

```json
{
  "health": {"app":"pc-command-center","version":"2.1.1","ready":true,"status":"ok","last_sample_at":"2026-10-18T12:00:00Z","sample_age_seconds":1,"collector_state":"running","worker_alive":true},
  "summary": {"schema_version":1,"timestamp":"2026-10-18T12:00:00Z","cpu":{"percent":12.5},"memory":{"percent":32},"gpus":[{"id":"nvidia-0","utilization_percent":6,"memory_used_bytes":2000000000,"memory_total_bytes":17179869184,"temperature_c":42}],"disk_io":{"read_bytes_per_sec":1000,"write_bytes_per_sec":2000},"network":{"sent_bytes_per_sec":1000,"received_bytes_per_sec":3000}}
}
```

Never forward the original summary object. Although it omits process rows, it still can contain hostname, hardware inventory, interface/disk identifiers, provider details, and diagnostic text. Construct the cloud payload from the explicit allowlist. Do not upload usernames, executable paths, command lines, startup entries, process IDs, raw errors, tokens, capture prompts, or local absolute paths. Host display label is user-chosen during enrollment. Diagnostics use typed classifications; detailed logs stay local with redaction and bounded retention.

`device_heartbeats` has a unique `(user_id,device_id,boot_id,sequence)` and a canonical payload digest. Repeating the same key and digest returns the original receipt; repeating it with different bytes returns 409. `runtime_observations` records source sample time, source-reported age, server received time, sanitized metrics, and heartbeat identity. On startup, `POST /api/bridge/session` registers `{bootId,bridgeVersion}` and atomically returns a monotonically increasing generation; repeating the same boot ID returns the same generation. A superseded boot cannot register itself again as new. Update each source's latest projection only for the current generation and a newer sequence; older generations may replay history but cannot update last-seen/latest state. Never compare unrelated boot UUIDs lexically. Retain raw heartbeat/observation rows for seven days and minute aggregates for ninety days; a scheduled owner-safe cleanup job deletes in bounded pages. D1 stores summaries; raw PC history and recorder payloads stay local. R2 is used only for explicitly selected evidence artifacts through the shared private artifact flow, not constant raw telemetry dumps.

## Task 1: Prove enrollment, service access, and owner isolation

- [ ] Add `tests/device-auth.test.ts` with independent owner fixtures, enrolled and revoked device fixtures, expired/consumed enrollment fixtures, and an ingress stub that deliberately supplies no visitor identity. Make these named assertions fail before implementing the route/store boundary:

```ts
const cases = [
  ['valid ingress without device credential', 401],
  ['device credential without verified private ingress', 401],
  ['ownerId injected into heartbeat body', 400],
  ['visitor headers injected into device request', 401],
  ['credential belongs to another deviceId', 403],
  ['revoked or expired device credential', 401],
  ['consumed enrollment redeemed again', 409],
  ['telemetry credential polls execution jobs', 403],
] as const;
```

- [ ] Implement strict enrollment/revocation schemas and atomic single-use consumption in `lib/devices/store.ts`. Verify all hashes with fixed-length bytes and constant-time comparison where applicable. Never return a stored hash to the browser. Permit only `telemetry:write` by default; requested execution scopes require Phase 7 enrollment and explicit local configuration.
- [ ] Implement `lib/devices/auth.ts` with separate `authenticateBrowserOwner(request)` and `authenticateDevice(request, requiredScope)` boundaries. The latter first requires documented platform ingress, then resolves `X-Control-Room-Device` against its stored digest, expiry, revocation, and scopes. It returns `DevicePrincipal`; it never accepts an owner from request JSON. Device request rate limiting keys use the resolved device, with an outer unauthenticated limit before credential lookup.
- [ ] Implement `/api/devices`, `/api/devices/enrollments`, device revocation, `/api/bridge/enroll`, and `/api/bridge/session`. Apply browser same-origin protection to enrollment/revocation and service authentication to the bridge routes. Add no-store/private and request correlation headers consistently with the existing workspace route. Session registration is a narrow operational CAS; owner enrollment/configuration commands use the shared transaction/revision boundary.
- [ ] Run `node --experimental-strip-types --test tests/device-auth.test.ts`. Expected: all cases pass; unknown IDs do not expose another owner's row. Record the private ingress acquisition/refresh result in `docs/integrations/private-service-ingress.md`; mark it unverified until a deployed private endpoint and the intended Windows credential mechanism are tested.

## Task 2: Implement deterministic telemetry ingestion and freshness

- [ ] Add fixture-driven tests in `tests/runtime-ingest.test.ts` for one heartbeat, exact duplicate, changed-payload duplicate, older sequence, new bridge generation, malformed timestamp, unknown fields, null GPU, owner separation, revoked credential, and a database failure before receipt commit. Add these freshness cases in `tests/runtime-freshness.test.ts`:

```ts
// Source readiness and bridge connectivity are separate columns in the read model.
const freshnessCases = [
  {heartbeatAge:30, sourceReady:true, sourceAge:2, connectivity:'online', source:'fresh'},
  {heartbeatAge:30, sourceReady:false, sourceAge:20, connectivity:'online', source:'stale'},
  {heartbeatAge:100, sourceReady:true, sourceAge:2, connectivity:'stale', source:'stale'},
  {heartbeatAge:301, sourceReady:true, sourceAge:2, connectivity:'offline', source:'stale'},
  {heartbeatAge:null, sourceReady:false, sourceAge:null, connectivity:'never-seen', source:'unknown'},
];
```

- [ ] Add the migration and store transaction. Atomically deduplicate receipt, insert the heartbeat, insert bounded observations, and advance latest-source state. Persist server received time separately. Interrupted transactions must leave neither a partial receipt nor a partially advanced latest row.
- [ ] Implement freshness using server time: heartbeat at most ninety seconds is online, ninety to three hundred seconds is stale, older is offline, absent is never-seen. A PC source is fresh only when its own state is ready, reported sample age was at most ten seconds at ingest, device connectivity is online, and reported age plus elapsed server time since ingest is at most forty-five seconds. This allows the thirty-second upload cadence plus bounded jitter while retaining the local collector's stricter readiness rule. Mark a source clock more than five minutes from server time as `clock-skew`; show server age and source-reported age without claiming exact sample age.
- [ ] Implement owner-scoped `GET /api/runtime` with explicit `receivedAt`, `observedAt`, `lastSuccessfulSampleAt`, connectivity, source freshness, and diagnostic code. Do not claim unavailable metrics are current. Add bounded retention cleanup without merging unavailable buckets into zero-valued averages.
- [ ] Run `node --experimental-strip-types --test tests/runtime-ingest.test.ts tests/runtime-freshness.test.ts`. Expected: retries do not duplicate observations, clock skew is visible, stale cached samples never become a green live state, and another owner's data cannot be read.

## Task 3: Build the outbound Windows bridge without duplicating collection

- [ ] Add `bridge/package.json` with `"type":"module"`, `"engines":{"node":">=24"}`, `"scripts":{"test":"node --test test/*.test.mjs"}`. Keep bridge dependencies separate from browser/worker dependencies. Add tests using fake local HTTP servers; none of these tests invokes PC Command Center or a model.
- [ ] Implement the fixed read-only endpoint registry in `bridge/src/pc-command-center.mjs`:

```js
export const PC_READS = Object.freeze({
  health: 'http://127.0.0.1:47631/api/health',
  summary: 'http://127.0.0.1:47631/api/snapshot?detail=summary',
});
export const BRIDGE_LIMITS = Object.freeze({
  sampleEveryMs: 30_000, localDeadlineMs: 2_000, responseBytes: 262_144,
  cloudDeadlineMs: 10_000, outboxBytes: 8_388_608, outboxRecords: 240,
  retryMinMs: 5_000, retryMaxMs: 300_000,
});
```

- [ ] Use `node:http` for numeric-loopback requests with redirects rejected, no proxy environment support, a two-second deadline, streaming response-size cap, and JSON/content-type checks. `source_unreachable` covers refused/timed-out GETs; invalid source data is `source_invalid`. Never call the service's session, POST, shutdown, control, benchmark, or setup routes. Never start the local collector when it is absent.
- [ ] Construct the allowlisted payload, retaining nulls. Derive age from local monotonic elapsed time plus the PC-reported sample age; preserve the original sample timestamp as evidence. The bridge may be online while the PC service is down. Unit tests must inject extra `hostname`, `username`, `exe`, `token`, and `prompt` fields into a source response and assert that none reaches serialized upload bytes.
- [ ] Implement `bridge/src/outbox.mjs` as an atomic bounded spool with the same boot ID, sequence, and payload bytes reused on retry. On the 240-record/eight-MiB bound, discard oldest telemetry only, record a gap count, and retain the newest state. Do not treat historical replay as a fresh heartbeat; after reconnect send a new current heartbeat, then bounded historical records with original sample times. Phase 7 job events use a separate durable journal and may never use this lossy queue.
- [ ] Implement `bridge/src/transport.mjs` around a `getPrivateIngressCredentials()` adapter whose only production implementation comes from the proven ingress mechanism. Send its supported platform headers plus `X-Control-Room-Device`; redact both. On 401 stop and show reconnect required; on 403 stop with capability mismatch; on 429 obey bounded `Retry-After`; on network/5xx retry the same bytes with jitter within five seconds to five minutes. Do not silently re-enroll or change Site privacy.
- [ ] Run `node --test bridge/test/pc-command-center.test.mjs bridge/test/transport.test.mjs bridge/test/outbox.test.mjs`. Expected: blocked redirects/proxies, response caps, no leaked extra fields, stable retry identity, bounded storage, and credential expiry without a retry storm.

## Task 4: Add runtime UI and a disabled operational-adapter contract

- [ ] Add Runtime navigation and cards for device connectivity, PC collector freshness, selected CPU/RAM/GPU metrics, last received/last sampled times, and typed unavailable diagnostics. Render empty, never-enrolled, disconnected, revoked, unsupported-version, source-down, clock-skew, and fresh states. Keep the last successful readings visibly dated; do not show a green dot solely because a card has numbers.
- [ ] Show enrollment, copy-once code, expiration, revoke, and credential-rotation actions in the authenticated owner UI. Never show a device secret after redemption. Provide a local-open link as a convenience only on a Windows device; explain that another computer's localhost refers to that other computer. No iframe, browser fetch, or cloud proxy is used to inspect localhost.
- [ ] Define a runtime adapter manifest in `lib/runtime/contracts.ts` and the bridge configuration, using only explicit named capabilities:

```ts
export interface RuntimeAdapterManifest {
  id: 'pc-command-center' | 'agent-lab' | 'trade-graph';
  version: 1;
  enabled: boolean;
  capabilities: readonly ('read.health' | 'read.summary' | 'read.evaluations')[];
  endpointAlias: string; // resolves locally to an audited fixed loopback adapter
}
```

- [ ] Set Trade Graph's adapter to `enabled:false` and show `not_configured` until its actual read-only status interface is independently inspected and a versioned sanitized fixture exists. Runtime monitoring never starts/stops the trader, changes configuration, authorizes trades, calls venue order APIs, or treats source/CI evidence as installation evidence. A future operational adapter requires a separate exact-action contract, local capability grant, and explicit owner authorization; live orders are outside this phase and default activation.
- [ ] Register `lib/runtime/export.ts` with the shared bundle registry: include device display aliases, disabled adapter configuration, selected source observations/evidence references and provenance within the export capacity limits. Exclude device credentials, enrollment secrets, ingress credentials, active sessions/generations, leases and local absolute paths. Restore device references as disconnected and adapters as disabled; restored historical telemetry remains dated evidence. Never recreate an enrolled active device from an import.
- [ ] Add runtime UI scenario coverage in `tests/e2e/runtime.spec.ts`. Inspect narrow/wide layout, keyboard focus, text alternatives for status, stale chart gaps, and a denied owner read. Run `npm run typecheck` and `npm run test:e2e -- tests/e2e/runtime.spec.ts` before the full quality gate.

## Task 5: Package the Windows handoff and record the evidence boundary

- [ ] Implement `bridge/src/cli.mjs` commands `doctor`, `enroll`, `run --once`, `run`, and `revoke-local`. `doctor` checks only Node version, config validity, credential availability, fixed loopback reachability, and configured cloud transport; it never starts a service, launches a model, or emits secret values. Enrollment takes its one-use secret through masked/interactive input, not a command-line argument.
- [ ] Keep local config under `%LOCALAPPDATA%\ControlRoomBridge\config.json`, encrypted credentials under that directory with current-user ACLs, and spool/log state in bounded subdirectories. `protect-credential.ps1` uses Windows DPAPI `CurrentUser`; pass plaintext through a private anonymous stdin pipe, return the protected blob through its stdout pipe, and never log either. Decryption returns plaintext only to the owning process's private pipe, never a console or command-line argument. The source repository contains example config with opaque aliases and disabled execution, not local paths or credentials.
- [ ] Make task installation an explicit local handoff step: a named current-user scheduled task starts only the bridge in a hidden window after sign-in, without elevation. The installer validates the resolved bridge executable/module paths and task identity before mutation. Uninstall removes only that exact task and leaves local data for explicit cleanup. Neither script changes PC Command Center's startup, process, registry, drivers, or service.
- [ ] Write `docs/verification/windows-bridge-acceptance.md` with separate rows for cloud fixture evidence and actual Windows evidence. The cloud implementer records commit/build identity, test output paths, private deployment URL, supported ingress result, and package digest. The Windows operator records local collector version, bridge version, timestamp, anonymized device ID, observed source state, and redacted screenshots. Never paste credential or account output.
- [ ] On the intended Windows machine, after explicit installation/connection authorization, run these non-model steps against an already-running PC service:

```powershell
node bridge/src/cli.mjs doctor
node bridge/src/cli.mjs enroll
node bridge/src/cli.mjs run --once
```

Expected: a private owner-only runtime card reports a real source timestamp and correctly named collector state. If the PC service is absent, expected output is `source_unreachable` and no service launch. Exercise offline, restore connectivity, source unavailable, revoked credential, restart with a new boot ID, and ingress expiry/refresh. Use fake servers for destructive outage cases; never stop a real trading process for this test.
- [ ] Run the phase tests, then the project-wide verification commands prescribed by the final verification phase. Commit this phase as `feat: add authenticated PC runtime telemetry` only after those checks pass. Record Windows tests as **not run** when the cloud environment cannot perform them; fixtures alone do not satisfy device acceptance.

## Completion gate

The implementation is cloud-complete when owner-scoped enrollment, typed ingestion, private reads, deduplication, retention, freshness, fixtures, UI, and installable bridge packaging pass. It is device-complete only after supported private ingress acquisition/refresh and the actual Windows smoke evidence above are recorded. Telemetry completeness never implies execution authority. Phase 7 adds a separate execution agent with its own local capability configuration, leases, approval, and budgets.
