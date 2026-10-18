# Isolated segmented replacement rehearsal

This is an offline, synthetic replacement rehearsal, not an online restore endpoint or a hosted database cutover tool. Run:

    node --experimental-strip-types scripts/test-recovery-segments-d1.mjs

Node 24 and the locked project dependencies are required. The dedicated Actions workflow runs the same command. Miniflare creates four disposable, nonpersistent D1 databases and two disposable R2 buckets. The script never reads an existing owner workspace, contacts a provider, changes a Sites binding, or installs a device/service.

The fixture deliberately represents an already oversized source: more than 10,000 canonical audit events and more than 8,000,000 metadata bytes, alongside real planning, baseline evidence, draft decisions, attachment metadata, and verified synthetic file bytes. The ordinary v1 bundle exporter must still refuse this source. No v1 row/byte admission guard is relaxed.

The segmented codec is only an integrity layer. Its manifest is untrusted data. The rehearsal also captures a trusted source header containing the frozen revision, operational vector, exact logical source hashes, source audit namespace as provenance, export timestamp, and attachment manifest. An operator must obtain and retain this header independently of client-supplied segment content. Replacing the header and segments together does not establish owner authority.

Every segment is verified before the first staging row; the decoder checks it again during consumption. Staging is inactive and uses atomic checkpoint-and-row batches. Resume requires equality with the durable checkpoint, not a caller-chosen cursor. The rehearsal rejects corrupted early and late reads, forged resume offsets, missing staged rows, and attempts to reuse a partly written replacement. It compares the complete staged inventory before installation.

The replacement is initially empty. Actual registered adapters parse each supported module and validate references; actual module projections supply SQL mirror columns; physical rows are inserted in foreign-key order. Logical IDs, immutable evidence and decision versions, original planning state, and physical row revisions are checked. Historical audit claims use stable original source identity and exact payload digests, under a newly generated destination audit namespace. Original audit namespaces, grants, credentials, leases, cursors, session state, job intents, and approval/acceptance authority are never installed as current authority.

Ready attachment metadata alone is insufficient. The rehearsal reads each source object through the real verified-byte reader, checks the manifest identity/length/digest, creates a fresh destination namespace and immutable private key, verifies destination bytes, and then installs the rekeyed metadata and verified object ledger. Only the storage key changes; logical attachment IDs and evidence references remain exact. The original source remains unchanged.

A sidecar handoff hash is written only after decoder exhaustion, exact inventory checks, SQL foreign-key checks, audit source-identity checks, and attachment verification. It means "ready for a manual reviewed replacement binding handoff" in this isolated fixture. It does not expose the database or change production bindings. Interrupted replacement databases remain inactive and must be discarded, not blindly resumed.

## Boundaries before an operator replacement feature

The current profile bounds metadata to 64 MiB, 100,000 rows, 512 segments, and the codec's per-segment bounds; file bytes retain the existing attachment policy. This does not cover every possible owner size. The rehearsal retains file bytes only for its small synthetic fixture; a production installer must stream verified objects one at a time and retain immutable staged objects through cutover.

A supported operator installer still needs explicit empty-target identification, reviewed trusted-header intake, durable inactive-target state, a destination inventory report, reviewed D1 plus R2 binding handoff, source preservation, and a rollback procedure. Private deletion/tombstone lineage, baseline removal history, operational continuity, and future module-specific import normalization need a separately reviewed operator policy; historical claims must not silently become current owner authority. No "complete recoverable backup" claim is made for those excluded private semantics.

Do not use this rehearsal to bypass the v1 guards or label oversized online restore as supported. G48 remains contingent on an accepted, matching owner-size replacement path and explicit cutover acceptance.
