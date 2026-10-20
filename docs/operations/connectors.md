# Connector operations

Connections are selected sources of context. A saved configuration, imported observation or synthetic fixture is not proof of live provider access. Source changes never automatically accept a proposal, complete planning work, create owner evidence or authorize trading.

## Inspect freshness before retrying

The owner source panel reads `GET /api/sources`; selected-source observations, proposals and runs use `/api/sources/<id>/observations`, `/proposals` and `/runs`. Pages are bounded and owner-scoped; use the returned cursor to reach later records. The public state shows attempted time, last success, last source revision, failure and retry time, without private cursor/ETag/authority values.

A successful attempt is not necessarily a successful refresh. Read last-success and original observation timestamps. Missing dates remain unknown. An outage, revoked scope, rate limit or partial page must preserve last-good records and the prior committed cursor. A repeated partial run retains its original intent/cursor rather than manufacturing a fresh healthy result.

## Manual sources

Interactive document and conversation imports use `POST /api/sources/<id>/import` through the owner UI. The selected resource/configuration, exact content identity, expected row/workspace revision and original mutation ID are bound before operational writes. Retry an ambiguous import with the unchanged retained input/ID; reconcile its original receipt first.

Manual text/JSON/Markdown input is bounded to 2 MiB and treated as data, never executed or rendered as macros, HTML or executable instructions. Conversation selection is explicit: only selected messages enter the canonical retained JSON. A canonical selected conversation is not the original export-file format. Source-modified dates remain nullable; server observation time is distinct.

Full-content retention is optional. The owner must first reserve/upload/finalize the exact private file and select its ready ID. The server checks its exact owner, digest, size, verified ledger and absence of cleanup fences. An excerpt does not imply full content was retained.

## Connected reads, scopes and revocation

Provider reads require a supported injected adapter plus an exact selected-resource access grant. Unattended reads additionally require a separately registered renewable principal with exact `source:read` scope. Scheduled source runs require distinct current automation authority; telemetry or browser identity cannot substitute. Default automatic reads remain unverified/unsupported until these real dependencies are supplied and accepted.

Use the actual provider's least-privilege selected-resource consent and revocation/rotation procedure. Never export credentials, paste tokens into source fields, reuse another subsystem's credential or infer consent from a URL. Pause/archive the connection or target through explicit owner controls before changing selections. Reconnect with supported credentials and verify a new bounded read before resuming.

Observe the recorded retry deadline/backoff and provider restrictions. There is no general force-refresh loop or permission to bypass rate limits. A terminal failure is inspected through its run; a new explicit refresh is a new reviewed action only after the previous outcome is resolved.

PC telemetry and Agent Lab evaluation adapters are separate read-only boundaries. Offline means stale/unknown; the collector must not start a model, local service or Lab queue to make itself healthy. See [Windows bridge](../integrations/windows-bridge.md), [private ingress](../integrations/private-service-ingress.md) and [agent execution](agent-execution.md). Real local installation, provider/resource consent and renewable private ingress remain owner/operator acceptance actions.
