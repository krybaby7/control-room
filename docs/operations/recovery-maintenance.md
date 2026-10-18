# Operator-only recovery maintenance protocol

The maintenance helper is privileged offline tooling, not an app route. It changes no hosted Site in the test suite and does not infer authority from a recovery JSON file. Every operation receives an authenticated operator's injected SqlDatabase binding and independently trusted manifest/context/schema identities. Keep its token in a controlled private operator journal before invoking freeze; never put it in portable data, logs or release evidence.

The fixed profile covers 97 actual application tables from the reviewed 27-migration source, including global/private records and the backup archive, cleanup and retained-generation tables. Unknown/missing tables, changed SQL schema, altered/missing maintenance triggers and changed control columns fail explicitly. The optional platform bookkeeping names are only _cf_METADATA, _cf_KV, d1_migrations and __drizzle_migrations; they are not application recovery data.

prepareRecoveryMaintenance creates an operator control table and one BEFORE INSERT/UPDATE/DELETE guard on every closed application table. The scope is deliberately DB-wide. An owner-only predicate is insufficient: SQLite REPLACE can otherwise delete another owner's globally unique row without firing the expected DELETE trigger. No application credential is permitted to mutate the operator control table; access to the underlying privileged D1/SQL binding remains the operator trust boundary.

freezeRecoveryDatabase checks the exact workspace revision, execution epoch, operational vector, schema/trigger row set and absence of unsettled PUTs globally, then inserts the actual frozen control row as its final atomic operation. It also waits for backup_archive_objects.pending_token with settled_at NULL. An exact retry with the retained operation/token recovers the same freeze; another token or package cannot. Existing private jobs can no longer update the source through application D1 after this fence. The operator must still allow bridge processes to reach their bounded lease deadlines and retain unknown outcomes; the freeze never proves an external process exited.

bindFrozenPrivateContinuity validates the independently expected private root and recaptures the real frozen private rows to establish equality before recording the root in the control row. Source JSON alone never becomes a freeze receipt.

## R2 safety

The fence does not pretend to prove that every old DELETE promise settled. Every exact attachment_blob_fences key and attachment_archive_cleanup_claims key is permanently excluded by assertRecoveryBlobCopyEligible. An eligible live file additionally needs current typed ready metadata plus matching verified unpurged physical identity. The assembler still must read and check actual bytes. New target files must use fresh target namespaces. A late DELETE of an excluded old key then cannot mutate a copied fresh key. Preserve all old exact-key fences and purged immutable identities; do not clear an ambiguous PUT by clock or silently drop an unresolved row.

Archive chunks have write-ahead PUT tokens and explicit physical cleanup protected by permanent backup_archive_cleanup_claims. Every such exact old key is excluded from ready copies. The continuity artifact preserves those claims and the old physical ledger; retired imported epochs remain old and cannot authorize target cleanup. Ready chunks are verified from the frozen source and copied into fresh namespaces, with old generations retained and charged. Backup archive source index/physical identities are private continuity data; their old keys are never advertised as fresh target byte authority.

## Inactive target

prepareInactiveRecoveryTarget requires the actual source binding and authenticated freeze receipt with a bound private root. It rejects every nonempty application table and any prior target maintenance operation. It rejects a source with another owner's rows: replacing an entire shared D1 with one owner's package would lose other owners. A multi-owner replacement requires a separate complete trusted manifest protocol.

An inactive target rejects all application writes. writeInactiveRecoveryTarget permits only a bounded array of statements from trusted local installer code, temporarily within its own atomic transaction; it returns the actual underlying SQL results and restores the inactive fence before other transactions can run. Failed batches roll back both data and the temporary state. Never pass request SQL or an untrusted callback.

recoveryTargetInventorySha256 hashes every closed keyed application row with bounded pages. Empty transient unkeyed tables must remain empty. This is an exact inventory digest, not domain/reference/blob validation.

markRecoveryTargetReady requires matching source/private/manifest/schema roots, a trusted domain/reference/blob verifier's actual inventory digest, a bumped execution epoch, no credential/access/capability/approval dispatch authority, paused execution state, cancelled pending work and valid SQL foreign keys. Unknown agent attempts may remain running only as cancel-requested reconcile_required work, with their occupied slots, journals, events and budget reservations preserved by the assembler. Historical approvals must be revoked. A write-revision CAS rejects installer/verifier races.

The ready marker is still write-blocked. There is no function that automatically opens it, rebinds Sites D1/R2, resumes a schedule, restores a credential or dispatches a process. Actual binding cutover remains an explicit operator/deployment action after all domain and byte checks; a ready marker alone is not complete backup acceptance. Source release is an explicit token-bound reviewed rollback; it is never automatic. There is no cross-database transaction or automatic publication claim, and one trusted operator must serialize rollback versus cutover.

## Actual tests

The SQLite and Miniflare fixtures use only synthetic disposable databases. Run:

    node --experimental-strip-types --test tests/recovery-maintenance.test.ts
    node --experimental-strip-types scripts/test-recovery-maintenance-d1.mjs

They exercise actual trigger DDL, global REPLACE refusal, pending-write freeze refusal, trusted DB receipt, private-root binding, inactive target batches, rollback, final CAS, retained old fences/receipts, epoch retirement and manual-only marker. These protocol tests do not install all source modules or prove hosted/physical access. The separately integrated segmented rehearsal must exercise the full verified metadata/reference/R2 assembler before G48 can claim a supported bounded replacement path.


The reusable operator boundaries are `inactiveRecoveryDatabase` and
`installRecoveryPrivateContinuity` in `lib/recovery-install.ts`, plus
`copyRecoveryBackupArchives` in `lib/recovery-backups.ts`. They require actual
source and target maintenance receipts and independently recapture the frozen
private root. Prepared SQL is constructed by trusted local installer code; no
HTTP body or archive-supplied SQL is accepted. Native database results and atomic
rollback are preserved through the fenced wrapper.

The continuity installer preserves previous planning bytes/revision/time,
legacy receipt tombstones, permanently retired epochs, native baseline removal
fences, process journal and event receipt identities, occupied unknown slots and
finite budget reservations. It cancels pending intents, changes uncertain
attempt state to reconcile_required, revokes approval history, and disables
budgets. Original source records remain in the sealed continuity artifact.
Execution credentials, provider/paid grants, capabilities and schedule dispatch authority are absent. Existing nonexecution owner attribution and read-state records remain exact.

The backup adapter preserves logical backup IDs, original metadata serialization,
source timestamps and namespace-free index hashes. Ready archives undergo full
native ZIP validation from the actual frozen source, then each chunk is copied
to a new server namespace using a durable pending token before PUT. Definitive
PUT settlement and a verifying GET precede readiness. A rejected or ambiguous
PUT leaves the destination inactive and its token unresolved. Retired, failed
and preparing history stays inert, with its old physical charge/cleanup ledger;
it is never advertised as a ready archive. Permanent old cleanup keys remain
excluded from ready copies, and their delayed DELETE cannot name new keys.

The oversized D1/R2 rehearsal composes the complete closed registry metadata
adapters with these boundaries. It exercises an actual native baseline removal,
an uncertain synthetic agent attempt, legacy receipts, old-epoch retirement,
ready and retired file backups, and fresh R2 namespaces. This remains an isolated
synthetic rehearsal. The reusable helpers do not constitute a deployed hosted
cutover endpoint or authorize a source database from a JSON package. A complete
operator must use the reviewed metadata/reference/projection installer and
verify every segment before installing any application row, retain the sealed
private artifact and old-to-new namespace mapping, and perform a separately
reviewed manual binding/unfence handoff only after all verification succeeds.

The verified private profile is bounded to 200,000 rows globally, 100,000 per
private table and 64 MiB. Target inventory is bounded to 300,000 application
rows and 128 MiB. These are tool-format limits, not a claim that every future
application write is admitted against this combined profile. A pre-existing
owner beyond a format limit is refused without pruning and needs an explicit
engineering/operator handoff.

Operational stream heads retain both original revision and sequence, and final
seal independently reads the resulting target vector. Reserved nonempty
workspace_configuration is blocked until a typed recovery adapter exists.
Backup archives with epochs ahead of the actual frozen source epoch are rejected
even when a caller recomputes a JSON digest. Backup input is cloned before async
verification. Old ready chunk identities enter the retained physical ledger,
which grants no cleanup authority, before any new PUT. Old plus fresh physical
bytes must fit the ordinary backup quota; old charges are never exempted.
Attachment generations likewise require headroom including both old and new
objects. A target with unsettled PUTs or excess physical quota cannot be sealed.

A trusted same-owner frozen cutover preserves the original audit namespace as an
identity, every native audit physical ID and nullable source column, immutable
project links and existing import identity mappings. Its cursor secret is
new, so old cursor MACs do not authorize the new binding. This policy does not
change ordinary portable imports: imported history remains claims and cannot
mint native grants.

The closed 42-table private profile also preserves existing owner assessment/decision
attribution, exact review acknowledgements, notification read state, active
baseline head identity and unsubmitted server drafts. Source grants are checked
against exact same-owner immutable body hashes. The target seal independently
compares these actual source/target rows; an imported normalized record without
an existing source grant never gains attribution. These are existing owner
choices, not new acceptance, completion, execution or paid consent.

Nonempty workspace_imports, workspace_import_chunks, attachment_archive_stages or review_analysis_requests
are refused before target writes with an explicit staging/blob handoff message.
No staged original input, file path or expired draft is silently discarded.
Execution credentials, provider grants/capabilities and paid consent remain
excluded; pending jobs stay cancelled and unknown attempts remain fenced.

Single-owner eligibility is checked before source maintenance DDL and again in the atomic freeze predicate and frozen-source verification. Foreign user rows are rejected; the explicitly inventoried global device rate buckets convey no owner data. Final readiness requires the actual source audit identity, a distinct target blob namespace and a fresh cursor secret. Current agent attempt identities retain their complete original approval envelope, task input and frozen admission bytes; a real claim fixture verifies preservation without restoring lease authority.

The remaining dated native source/review integration journals, occurrence claims,
source cursor/freshness state and automation history are copied as inert data.
Integration lease credentials are cleared; schedules and sources stay paused.
Native device sessions, heartbeat receipts, observation/latest/aggregate bodies
and sequence floors remain original, while runtimes are revoked and sessions
retired. Original reported/observed/received dates are preserved. Credentials,
provider grants and fresh execution consent are never copied. The closed table
classification rejects unclassified schema additions and populated transient
claim/assertion/guard tables instead of dropping them.

Final readiness independently reads each actual frozen private source row and
its exact owner/primary-key target row, hashes the full scalar bodies and checks
the deterministic inert transformation and exact row counts. This comparison
uses primary-key pages, with single-row pages for large serialized bodies, avoiding giant aggregate JSON proofs. The five physical
backup rekey tables follow the separately verified byte/ledger adapter. A
caller recomputing a generic target inventory cannot excuse an omitted
observation, altered receipt or changed sequence floor.
