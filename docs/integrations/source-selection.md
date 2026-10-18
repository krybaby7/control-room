# Selecting and interpreting sources

Source selection is an explicit owner configuration. A connection identifies the provider, label, enabled state and requested access mode. A target identifies one project, connection, source kind, immutable provider resource, optional canonical URL, selected relative paths, staleness threshold and selection version. A project link or source URL alone is not provider authorization.

Current limits are 100 owner sources, at most 50 selected paths per target and a stale-after threshold from 60 seconds through one year. Paths must be relative, without traversal, backslashes or control characters. A GitHub file target requires explicit paths. Manual documents must match the selected resource and any selected filename/path. These rules do not authorize whole-account, whole-drive or arbitrary conversation ingestion.

Configuration commands use the owner workspace receipt boundary and row revisions. Changing a selection pauses its runtime state and invalidates cursors when the configuration hash changes. Restoring or unarchiving a selection does not silently restart reading. An explicit resume requires current owner-bound access checks.

## Manual content boundaries

Manual document input is at most 2 MiB of native UTF-8 `text/plain` (`txt`/`log`), `text/markdown` (`md`/`markdown`) or `application/json` (`json`). JSON nesting is bounded to 40 levels. Invalid UTF-8, NUL bytes, mismatched resources/paths and unsupported extraction formats are rejected. This path does not extract PDF, Office files or attachments, execute macros, render active markup or fetch remote links.

A document observation records resource/version metadata, source modification time when supplied, observation time, source URL, full input digest, original byte count, bounded excerpt and extraction limitations. Excerpt-only import remains the default: the adapter payload states `fullContentRetained: false`, and its observation or JSON workspace export does not reconstruct the source file. Unknown modification times remain null rather than becoming an invented reading date. An optional separately verified attachment-backed representation is described below; a source digest alone never claims retained full bytes.

The manual conversation format has `version: 1`, `kind: "conversation-export"`, one selected `sourceId`, unique `selectedMessageIds` and message records containing ID, speaker, nullable timestamp, text and nullable URL. Input is bounded to 2 MiB, 1,000 supplied messages and 100 selected messages per page. Missing selected messages and conflicting copies of the same message ID reject. Only selected messages become observations; changed message content produces a new digest/revision. Their origin remains `manual-import`. The default adapter cannot automatically refresh conversations, and a desktop thread-reading tool is not a deployed server API.

### Optional retained input attachment

A manual HTTP import may supply `contentAttachmentId`. This must identify this owner's already reserved, uploaded/staged and explicitly finalized ready attachment through the existing private-attachment workflow. Supplying an ID does not upload content, finalize a file, mint storage authority or accept source claims. The HTTP check compares the submitted input's exact SHA-256 and byte length with the ready record and its owner-bound, verified, unpurged and unfenced private physical ledger. The source page transaction guards the same attachment row/hash, generation, digest, size and physical state atomically, so a conflicting retirement or metadata change cannot silently create a retained-content claim.

A retained observation adds `contentAttachmentRef: {id, sha256, bytes}` and payload `contentRetention` describing the bytes. For a document these are the exact UTF-8 bytes of the submitted document content. For a conversation these are the canonical conversation JSON submitted for the selected import, with representation label `canonical-conversation-json`; they are not claimed to be the original provider export file or its original formatting. Only selected message IDs become observations, but retention covers the submitted validated conversation envelope, so provide only the intended content in that envelope.

Adding retention creates a new immutable observation ID/content digest and leaves the original source revision unchanged. It does not rewrite an earlier excerpt-only observation. The explicit attachment reference distinguishes separately retained input bytes from the adapter's excerpt-only reading projection; an excerpt, digest or `fullContentRetained: false` observation alone is never treated as a full blob.

The complete native workspace archive includes the referenced ready attachment when its bytes can be verified. JSON bundles remain metadata-only; a reference does not embed content or prove that a target restore has available bytes. Keep source originals and inspect archive completeness. Hosted private R2 provisioning and actual deployed availability remain unverified; these contracts do not claim pending source UI integration or live storage acceptance has passed.

Provider/imported text is data, including text claiming approval, completion or permission to run an agent. It cannot issue commands or mint owner evidence, acceptance, weekly commitments or execution authority.

## Observations and proposals

Immutable observations distinguish provider resource identity, source revision, source update time and server observation time. Payload digests identify the retained projection. A digest of an excerpt projection is different from the separate digest of full input bytes. File excerpts and manually selected messages are scoped reading context, not independent verification of every source claim.

Source page commits may retain observations and pending suggestions without changing the planning editor revision. Proposals cite exact observation IDs/digests and exact evidence `{id, version}` references; a historical citation never resolves to a newer mutable head. Deterministic identity includes owner, source revision, affected entity and field delta. Reordered fields do not produce duplicate identity; a changed source revision does.

A source suggestion is inferred and pending until an owner reviews it. The current generator recognizes concrete matching-head failed checks, merged PRs and server-derived source-change/stale-document/blocker facts. Raw prose is not an instruction parser. Allowed deltas cover safe planning text and scheduling metadata; IDs, statuses, archives, completion, weekly pins and acceptance are excluded. Projects use their actual `name`, `description` and `goal` fields. A merged PR never marks a task done.

Owner decisions use accept-selected-fields, optional reviewed edits, reject or defer through the shared command/receipt boundary. Current affected fields must still match the recorded before values; concurrent owner changes require conflict review rather than overwrite. This document describes those contracts, not completed route/UI acceptance. See [provider capabilities](provider-capabilities.md) and [unattended synchronization](unattended-sync.md) for remaining access and runner gates.
