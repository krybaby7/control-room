# Local attachment R2 fixture

Run from the repository with Node 24 and the lockfile-installed dependencies:

```sh
node --experimental-strip-types scripts/test-attachments-r2.mjs
```

Verified locally on 18 October 2026 with Node **v24.19.0** and Miniflare **4.20260515.0**. No dependency installation or upgrade was required. The script uses the installed SDK's `Miniflare` constructor, `getR2Bucket`, and `dispose` APIs; its `r2Buckets` binding and `r2Persist: false` configuration come from the installed SDK types (`node_modules/miniflare/dist/src/index.d.ts`).

The fixture uses an actual isolated Miniflare R2 binding through `createR2BlobStore`, rather than a fake bucket implementation. It creates a random opaque namespace and synthetic reservation IDs, reads no credentials or deployed configuration, and deletes only its tracked synthetic keys. Cleanup checks the namespace is empty and always disposes Miniflare, including on failure.

For UTF-8 text, a one-page PDF with computed cross-reference offsets, and a one-pixel PNG with valid chunk checksums, it executes reservation preparation, streamed staging, finalization preparation and ready-object reads. Both the adapter read and direct R2 object body must equal the original bytes; R2 content type, length and SHA-256 metadata must agree. These pure preparations do not commit an authoritative D1 reservation or ready record.

| Synthetic fixture | Bytes | Verified body SHA-256 |
| --- | ---: | --- |
| fixture.txt | 39 | `455600928d2301d7053adbdcd231daf53271da10dc5f155d17c09c21c590a5c5` |
| fixture.pdf | 411 | `1f858c9c24d17e3300036a3a59325ca2b92a3296f1922089b174425004147653` |
| fixture.png | 68 | `5e3d382db4dd83d59aa5742793ad6b7903409e865c83bcbc54835049f043bc15` |

The script also asserts:

- Identical upload retries replay the existing immutable body; changed retries reject.
- A false PNG signature is quarantined without writing an object or permitting finalization.
- Corrupt stored metadata and a missing object prevent ready-object reads.
- Concurrent conditional puts for different bodies produce exactly one `stored` and one `exists`; the stored bytes and metadata match the winner, and the losing upload cannot overwrite it. Winner order may vary.
- An absent binding reports storage unavailable.

The recorded run's conditional race returned `["stored","exists"]`, with winner SHA-256 `80fcd462a0cff40a6b5e28e1d1c4adda1f2e9ea93afa7e5f1da77c470b162725`. It exited **0**, ending with:

```text
PASS local Miniflare R2: text/PDF/PNG round trips; immutable retries; invalid signature; corrupt metadata; missing object; atomic conditional race; missing binding; cleanup.
```

This proves the local emulator path and adapter's conditional-write behavior. Live private R2 provisioning remains an external activation gate: the deployed binding, private access, authenticated owner namespace resolution, D1 reservation/finalization transaction, deployed upload/read routes, quotas and cleanup authorization require separate hosted acceptance. This fixture does not claim a deployed bucket exists, a live upload succeeded, full file decoding or malware scanning, or production durability.

## Local authenticated HTTP fixture

The optional HTTP journey passed on the same date against a fresh built Worker:

```sh
node scripts/test-worker.mjs --target local-fixture --with-r2
```

`--with-r2` is accepted only with the explicit local-fixture target. It adds `BUCKET` with a synthetic local bucket name and `remote: false` only to the temporary copied Wrangler configuration. The deployment configuration and hosting identity remain untouched. Without this flag, the default fixture still has no R2 binding, preserving storage-unavailable browser coverage. Existing production-target and source-binding rejection guards remain enforced; four fixture harness tests passed, including option gating and the exact configuration difference.

Through the synthetic authenticated HTTP proxy and normal owner commands, this journey reserves a uniquely named text attachment, locates its exact generated ID in `/api/evidence`, streams its body through PUT, and verifies it remains reserved and GET returns 404 before finalization. The normal receipted finalize command and its exact replay advance the workspace revision once. The final GET verifies exact bytes, SHA-256, content type, attachment disposition, private/no-store caching and `nosniff` headers. The journey also verifies a changed upload body returns 409, owner B receives 404, an expired synthetic session receives 401, and foreign-origin PUT receives 403. A forged PNG returns 422, cannot finalize and remains unavailable through GET.

The fresh-build run exited **0** with:

```text
Synthetic fixture HTTP GET/POST/replay/CSRF smoke passed.
Synthetic fixture HTTP R2 reserve/stage/finalize/replay/download/isolation/forgery smoke passed. bytes=32 sha256=ee8061dff83dd68f205b6597c2333557be9e2b07a15c5dab79b35e707fb8104e
```

The attachment journey performs no direct D1 mutations: it uses the normal HTTP commands and routes. Initial synthetic workspace seeding and actual migrations belong to the existing fixture setup. All D1 and R2 state lives under the temporary fixture directory, which is removed after stopping the local Worker. No production objects are listed or deleted. This adds local HTTP and D1 transaction evidence; it does not satisfy the live private R2 provisioning or hosted acceptance gate described above.
