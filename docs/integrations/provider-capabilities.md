# Provider capability boundaries

This describes the current Phase 4 source contracts and local implementation. It is not evidence that a hosted read route, source UI, renewable runner or real provider connection has been activated. The Phase 4 implementation plan remains the acceptance checklist.

## Read surfaces

| Surface | Implemented adapter behavior | Activation requirement |
| --- | --- | --- |
| Selected GitHub repositories | Repository identity/default branch and pinned head; paginated PR summaries and states; checks for selected repository/PR heads | Server-injected read-only transport plus verified connection, immutable repository IDs and the specific interactive or unattended mode |
| Selected GitHub files | Exact relative paths at a pinned commit; text excerpt, Git blob identity, raw-byte SHA-256 and size | Same verified GitHub access; at least one path for a `github_file` target |
| Connected documents | A bounded delegated `SourceAdapter` interface checks selected resource identity, observation clock and canonical payload digest | A separately discovered, eligible and verified provider read API. The default document adapter has no connected read capability |
| Manual documents | Native UTF-8 text, Markdown and JSON, with explicit resource/path metadata | Authenticated owner selection and bounded manual import; this does not enable provider refresh |
| Conversation exports | Explicitly selected messages from the versioned manual export format | Authenticated manual import. Automatic conversation reads are unsupported by the default adapter |

GitHub transport requests are a closed set: repository, branch, commit-pinned file, PR page and check page. Credentials remain outside the adapter. Provider URLs and continuations are validated; source selection does not authorize an arbitrary URL fetch. GitHub file observations retain a bounded excerpt, not the entire source blob. A check for an old SHA is retained with a limitation and no current-head failure signal. A merged PR is a source fact, not task completion or owner acceptance.

## Optional manual snapshot retention

Manual import can reference an existing owner-ready private attachment through `contentAttachmentId`. The HTTP layer requires exact submitted-byte digest/length and owner-bound verified, unpurged, unfenced physical ledger proof; the operational source commit repeats immutable attachment and physical-state guards atomically. The resulting observation carries `contentAttachmentRef` and payload `contentRetention`. Document retention covers submitted UTF-8 content; conversation retention covers canonical submitted conversation JSON filtered to explicitly selected messages, not an original provider export-file claim. This creates a new immutable observation representation without inventing a new source revision.

Excerpt-only observations remain the default (`fullContentRetained: false` for the document adapter). An attachment ID or digest by itself is not a full-content or availability claim. A complete native archive can include the referenced verified ready bytes; a metadata JSON bundle cannot. This local implementation does not establish that a hosted private R2 binding is provisioned or reachable. See [source selection](source-selection.md) for exact representation and ownership boundaries. Source UI integration and external activation require their own acceptance evidence.

## Eligibility is separate from authoring access

The current tool inventory has no `list_plugin_eligibility` capability. Consequently, hosted Sites connector eligibility cannot be claimed from this environment. Available authoring tools, a signed-in authoring session, a stored provider name or a connection label do not prove that the deployed Worker can read that provider.

When the supported runtime exposes eligibility discovery, verify the exact provider and required read surface through its advertised interface. If it is absent or the provider is ineligible, retain the explicit unsupported/disconnected state. Do not invent connector IDs, transfer browser cookies, broaden site visibility or substitute another account. Interactive request access must be verified separately from unattended access.

The capability contract reports supported source kinds, interactive/unattended read booleans, verification time and blocked reason. Freshness requires the requested mode to be verified, not merely a non-null runtime context. Missing, expired, disabled, revoked or unsupported access must not become a green connected state.

## Private grants and proof

Private access records bind an owner, connection, selected immutable resource IDs, access mode, principal reference, verification and expiry. Unattended access additionally requires a registered, renewable, unexpired service principal scoped exactly to `source:read`. Secret values, access grants and service identities are not portable source settings and must not enter exports, proposal text or browser-supplied configuration.

A hosted service bearer proves neither visitor identity nor connected-app consent. Real activation requires an authenticated private-ingress request, the correct application owner mapping, resource-scoped provider access and a successful bounded read whose SHA/version/content is checked against the provider. Unattended acceptance must repeat that proof from a fresh runner without visitor cookies. Local injected transports and SQLite tests establish contract behavior only.

Relevant implementation: `lib/sources/contracts.ts`, `validation.ts`, `runtime-access.ts`, `adapters/github.ts`, `adapters/documents.ts`, `adapters/conversation-export.ts`, and `lib/background/job-store.ts`. The source adapter/manual import/service-access tests exercise these boundaries with synthetic data. No external source writes or physical-device claims are established by these adapters.
