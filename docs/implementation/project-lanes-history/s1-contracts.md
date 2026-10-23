# Project lanes/history foundation contract, version 1

The implementation baseline is the current imported application, planning schema v4. This feature allocates planning v5 and appended database migration 0029. Existing editor IDs and owner decisions survive migration; legacy tasks become Unclassified / other without title inference. Legacy input keeps its original 1,000,000-byte bound before normalization. Current v5 content has 1,500,000 bytes of bounded migration headroom.

## Storage and transaction boundary

`project_history` is one registered normalized owner module with individually addressable discriminated records, not a planning JSON property or a single transcript blob. Closed kinds represent the source, conversation, immutable message revision, segment, attachment, gap, alias, ingestion acknowledgement, cursor, run, claim, work item/event, story, roadmap version/head/assessment, association rule, repository evidence, inventory membership, analysis checkpoint and source-removal tombstone. This adapts the proposed table-per-record model to the application's existing typed module/export/recovery compiler. Owner/kind/source/conversation/area/sequence indexes and unique native thread/revision indexes preserve the same identity boundaries. Private object bytes are opaque R2 objects with a separate owner ledger; credentials are separate non-portable authority.

Wire codec v1 includes SourceConfiguration, epoch/scope-scoped InventoryMembership, SourceContext, HistoryClaim, HistoryWorkItem, AreaProgress, RepositoryEvidenceSnapshot, roadmap commands, association/analysis records and removal impact. Readers use the strict shared codecs unchanged. Subsequent incompatible wire changes require a version increment.

Physical row IDs hash logical IDs under a closed kind prefix. Logical source and provider IDs remain in the record. Message identities and revisions are immutable. CollectionEnvelope digests cover the entire envelope; credentials are excluded. Pages have at most 250 messages and 2 MiB metadata. Private objects are individually bounded at 16 MiB, with atomic 256 MiB / 10,000-object owner retention limits. Exhaustion and recoverability limits pause admission visibly; they never evict prior evidence or certify complete history.

`ingestHistoryPage` takes a required server recovery-admission adapter, authenticated owner and current persisted principal guard. It verifies the source epoch/scope/global execution epoch, native identity, finalized manifests, expected cursor and whole captured recovery boundary. One atomic batch commits rows, history sequence, acknowledgement, cursor and one durable area-analysis intent. Replay returns the original acknowledgement only after authority is revalidated. Planning revision and acceptance grants are untouched by operational ingestion.

`historyRecoveryAdmission` uses the existing full normalized recoverability measurement and private capacity proof. History updates alone extend operational update support; all other operational module writes retain their previous insert-only restrictions. D1 binding, statement, row and byte limits remain enforced.

## Owner actions and recovery

Area changes, source configuration, roadmap scope and checkpoint assessment use the existing owner revision/receipt/audit command boundary. Provider-kind changes require a new source identity. Every source control rotates epoch/scope; restored sources are paused and require new enrollment. A distinct finite history credential is hashes-only, owner/source/epoch/scope/global-epoch bound and is usable only after separately verified private ingress. Application bearer possession cannot prove private Site access. Default ingress is closed.

Roadmap criteria edits append versions and clear agreement. Owner agreement and accepted/reopened assessments use existing owner-grant proofs. Imported acceptance remains historical until explicitly accepted again. Automated text cannot call owner commands.

Disconnect retains history. Explicit removal requires a paused source, reviewed impact digest and atomic complete-history row-set precondition, then records a tombstone and recomputation intent. Accepted planning records remain. Physical bytes are deliberately retained pending a verified private backup and separately reviewed retention cleanup; logical removal is not reported as physical deletion. Views must mark affected evidence unavailable and preserve historical decisions.

All portable exports redact source roots/account/device selection, contain no renewable authority and restore disconnected. The dedicated bounded Node/offline history artifact includes selected verified body/segment/attachment/repository bytes and explicit unavailable/excluded entries. Standard workspace backups remain metadata-only for history objects; they are not full private-byte backups. The 64 MiB buffered offline helper is not a claim that hosted Worker memory supports buffering that artifact. Hosted transfer must be paged/streamed within its actual limits.

## Evidence boundary

Fixture and real isolated SQLite tests establish code behavior. They do not prove owner's retained local inventory, Windows unattended service behavior, renewable provider access, private Site ingestion or hosted publication. All four live source capability gates remain independently unverified until actual scoped access is available. Paid inference stays disabled and unconfigured.
