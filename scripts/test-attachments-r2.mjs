import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { Miniflare } from 'miniflare';
import {
  attachmentHash, createR2BlobStore, prepareAttachmentReservation,
  stageAttachmentUpload, prepareAttachmentFinalization, readReadyAttachment,
  AttachmentIntegrityError, AttachmentReplayMismatchError,
} from '../lib/attachments.ts';

assert.ok(Number(process.versions.node.split('.')[0]) >= 24, 'Run with Node 24 or newer.');
const require = createRequire(import.meta.url);
const ownerNamespace = randomUUID();
const owner = 'synthetic-local-r2-fixture';
const options = { ownerNamespace, now: '2026-10-18T12:00:00.000Z' };
const keys = new Set();
const encoder = new TextEncoder();
const stream = bytes => new ReadableStream({ start(controller) { controller.enqueue(bytes.slice()); controller.close(); } });
const reserve = (filename, mimeType, bytes) => {
  const record = prepareAttachmentReservation(owner, {
    filename, mimeType, expectedBytes: bytes.byteLength, uploadMutationId: randomUUID(),
  }, { bytes: 0, files: 0 }, options);
  keys.add(record.storageKey);
  return record;
};
// A genuine one-page PDF, with byte offsets computed rather than a signature-only stub.
function pdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] /Contents 4 0 R >>',
    '<< /Length 0 >>\nstream\nendstream',
  ];
  let value = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(encoder.encode(value).length); value += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = encoder.encode(value).length;
  value += `xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return encoder.encode(value);
}
const fixtures = [
  ['fixture.txt', 'text/plain', encoder.encode('Synthetic local R2 attachment fixture.\n')],
  ['fixture.pdf', 'application/pdf', pdf()],
  ['fixture.png', 'image/png', new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64'))],
];
const mf = new Miniflare({
  modules: true, script: 'export default { fetch() { return new Response("isolated synthetic fixture"); } };',
  compatibilityDate: '2026-05-15', r2Buckets: ['FIXTURE_BUCKET'], r2Persist: false, cf: false,
});
let bucket;
let store;
const digests = [];
try {
  bucket = await mf.getR2Bucket('FIXTURE_BUCKET');
  store = createR2BlobStore(bucket);
  assert.equal(store.available, true);
  for (const [filename, mimeType, bytes] of fixtures) {
    const record = reserve(filename, mimeType, bytes);
    const staged = await stageAttachmentUpload(owner, record, stream(bytes), store, options);
    assert.equal(staged.status, 'staged');
    assert.equal(staged.replayed, false);
    assert.equal(record.status, 'reserved');
    const retry = await stageAttachmentUpload(owner, record, stream(bytes), store, options);
    assert.equal(retry.status, 'staged');
    assert.equal(retry.replayed, true);
    const changed = bytes.slice(); changed[changed.length - 1] ^= 1;
    await assert.rejects(stageAttachmentUpload(owner, record, stream(changed), store, options), AttachmentReplayMismatchError);
    const ready = await prepareAttachmentFinalization(owner, staged.record, store, options);
    const read = await readReadyAttachment(owner, ready, store, options);
    assert.deepEqual(read.bytes, bytes);
    const raw = await bucket.get(record.storageKey);
    assert.ok(raw);
    const rawBytes = new Uint8Array(await raw.arrayBuffer());
    assert.deepEqual(rawBytes, bytes);
    const sha256 = await attachmentHash(rawBytes);
    assert.equal(ready.sha256, sha256);
    assert.equal(raw.customMetadata.sha256, sha256);
    assert.equal(raw.httpMetadata.contentType, mimeType);
    assert.equal(raw.size, bytes.length);
    digests.push({ filename, bytes: bytes.length, sha256 });
  }
  const invalidBytes = encoder.encode('This is not a PNG.');
  const invalid = reserve('invalid.png', 'image/png', invalidBytes);
  const rejected = await stageAttachmentUpload(owner, invalid, stream(invalidBytes), store, options);
  assert.equal(rejected.status, 'quarantined');
  assert.equal(await bucket.head(invalid.storageKey), null);
  await assert.rejects(prepareAttachmentFinalization(owner, rejected.record, store, options));

  const damageBytes = encoder.encode('Synthetic corruption fixture.');
  const damaged = reserve('damaged.txt', 'text/plain', damageBytes);
  const damagedStage = await stageAttachmentUpload(owner, damaged, stream(damageBytes), store, options);
  assert.equal(damagedStage.status, 'staged');
  const readyDamaged = await prepareAttachmentFinalization(owner, damagedStage.record, store, options);
  // Deliberately bypass the immutable adapter only to simulate object corruption.
  await bucket.put(damaged.storageKey, damageBytes, { httpMetadata: { contentType: 'text/plain' }, customMetadata: { sha256: 'invalid' } });
  await assert.rejects(readReadyAttachment(owner, readyDamaged, store, options), AttachmentIntegrityError);
  await store.delete(damaged.storageKey);
  await assert.rejects(readReadyAttachment(owner, readyDamaged, store, options), AttachmentIntegrityError);

  const racers = [encoder.encode('synthetic race A'), encoder.encode('synthetic race B')];
  const race = reserve('race.txt', 'text/plain', racers[0]);
  const metadata = await Promise.all(racers.map(async bytes => ({ bytes: bytes.length, sha256: await attachmentHash(bytes), mimeType: 'text/plain' })));
  const results = await Promise.all(racers.map((bytes, index) => store.put(race.storageKey, bytes, metadata[index])));
  assert.deepEqual([...results].sort(), ['exists', 'stored']);
  const winner = results.indexOf('stored');
  const raceObject = await bucket.get(race.storageKey);
  const raceBytes = new Uint8Array(await raceObject.arrayBuffer());
  assert.deepEqual(raceBytes, racers[winner]);
  assert.deepEqual(await store.head(race.storageKey), metadata[winner]);
  await assert.rejects(stageAttachmentUpload(owner, race, stream(racers[1 - winner]), store, options), AttachmentReplayMismatchError);
  const absent = await stageAttachmentUpload(owner, reserve('unavailable.txt', 'text/plain', racers[0]), stream(racers[0]), createR2BlobStore(), options);
  assert.equal(absent.status, 'unavailable');
  assert.equal(absent.reason, 'storage_unavailable');
  console.log(JSON.stringify({ runtime: process.version, miniflare: require('miniflare/package.json').version, digests, race: { results, sha256: await attachmentHash(raceBytes) } }, null, 2));
} finally {
  try {
    if (store && bucket) {
      for (const key of keys) await store.delete(key);
      const remaining = await bucket.list({ prefix: `attachments/${ownerNamespace}/` });
      assert.equal(remaining.objects.length, 0, 'Synthetic fixture cleanup must leave no objects.');
    }
  } finally { await mf.dispose(); }
}
console.log('PASS local Miniflare R2: text/PDF/PNG round trips; immutable retries; invalid signature; corrupt metadata; missing object; atomic conditional race; missing binding; cleanup.');
