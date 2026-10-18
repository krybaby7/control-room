# Isolated attachment recovery with Miniflare R2

Verified on 2026-10-18 using Node v24.19.0 and Miniflare 4.20260515.0:

```sh
node --experimental-strip-types scripts/test-attachment-recovery-r2.mjs
```

Result: **PASS**. Scoped ESLint also passed.

The fixture uses an actual ephemeral Miniflare R2 bucket, the production R2 adapter, an in-memory SQLite database with all repository migrations, the real workspace command executor and handlers, and the native archive writer/parser/stager. Object storage is not mocked. It never connects to a deployed database or bucket and does not change deployment bindings.

The verified journey:

1. Create an isolated synthetic workspace; reserve a text attachment through the actual command handler and physical quota ledger.
2. Acquire a persistent upload attempt, upload to actual R2, explicitly settle the completed upload, finalize through the actual command handler, and verify downloaded bytes.
3. Export a full native ZIP; stage it under a fresh private namespace, then verify actual R2 bytes and the staged ledger verification timestamp. Physical usage rises from one file to two.
4. Explicitly discard the verified stage. Its physical charge remains until cleanup confirms object deletion and R2 HEAD absence.
5. Run abandoned archive cleanup. Only the orphan key disappears, its physical charge is released, and the original attachment row and original bytes remain unchanged—even though both copies share the same logical attachment ID.
6. Stage the ZIP again and explicitly commit the reviewed replacement through `workspace.import.commit`. Resolve the committed private namespace and verify the restored attachment's exact bytes.
7. Confirm cleanup rejects the committed stage and both the restored object and original retained object remain present and charged.

Synthetic file size: **43 bytes**. File SHA-256:

```text
0efdb53b7cb11c96724c45bdc7623d913dc97b41f3554de8ce551b2b72e61d0c
```

The recorded run produced a 21,447-byte ZIP. ZIP hashes vary because each run generates fresh synthetic IDs and private namespaces; the script reports its current byte count and digest. It prints no owner records, object keys, namespaces or private paths. Bucket contents, SQLite and Miniflare are disposed in `finally`, including on assertion failure.

This proves the local R2 API and SQLite integration path for the stated synthetic journey. It does not establish a deployed private R2 binding, production availability, a registered cleanup runner, cross-service atomicity, or verification of attachment assertions. Concurrent races and ambiguous storage failures remain covered separately by the focused SQLite and injected-adapter tests.
