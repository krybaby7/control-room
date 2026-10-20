import assert from 'node:assert/strict';
import test from 'node:test';
import { ATTACHMENT_POLICY, attachmentDownloadHeaders, AttachmentPolicyError, hasExpectedSignature, readAttachmentStream, validateAttachmentContent, validateAttachmentMetadata } from '../lib/attachment-policy.ts';
import { attachmentHash, attachmentStorageKey, AttachmentReplayMismatchError, createR2BlobStore, prepareAttachmentFinalization, prepareAttachmentReservation, prepareAttachmentRetirement, readReadyAttachment, stageAttachmentUpload, type AttachmentBucket, type BlobMetadata, type BlobStore } from '../lib/attachments.ts';

const namespace = '11111111-1111-4111-8111-111111111111';
const foreignNamespace = '22222222-2222-4222-8222-222222222222';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const now = '2026-10-18T12:00:00.000Z';
const options = { ownerNamespace: namespace, now };
const text = (value: string) => new TextEncoder().encode(value);
function stream(bytes: Uint8Array) { return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }); }
function reserve(bytes = text('Evidence'), extra: Partial<{ filename: string; mimeType: string; expectedBytes: number }> = {}) {
  return prepareAttachmentReservation('synthetic-owner', { filename: 'evidence.txt', mimeType: 'text/plain', expectedBytes: bytes.length, uploadMutationId: 'original-upload', ...extra }, { bytes: 0, files: 0 }, { ...options, createId: () => id });
}
function memoryStore() {
  const objects = new Map<string, { bytes: Uint8Array; metadata: BlobMetadata }>();
  const calls = { puts: 0, deletes: 0 };
  const store: BlobStore = {
    available: true,
    async put(key, bytes, metadata) { calls.puts++; if (objects.has(key)) return 'exists'; objects.set(key, { bytes: bytes.slice(), metadata: { ...metadata } }); return 'stored'; },
    async get(key) { const value = objects.get(key); return value ? { body: stream(value.bytes.slice()), metadata: { ...value.metadata } } : null; },
    async head(key) { return objects.has(key) ? { ...objects.get(key)!.metadata } : null; },
    async delete(key) { calls.deletes++; objects.delete(key); },
  };
  return { store, objects, calls };
}

test('attachment product limits and reservation expiry include pending usage', () => {
  assert.equal(ATTACHMENT_POLICY.fileBytes, 20 * 1024 * 1024);
  assert.equal(ATTACHMENT_POLICY.ownerBytes, 200 * 1024 * 1024);
  const result = reserve();
  assert.equal(result.status, 'reserved'); assert.equal(result.readyAt, null); assert.equal(result.sha256, null);
  assert.equal(Date.parse(result.expiresAt) - Date.parse(now), 30 * 60_000);
  assert.equal(result.storageKey, `attachments/${namespace}/${id}`);
  assert.ok(!result.storageKey.includes('synthetic-owner')); assert.ok(!result.storageKey.includes('evidence.txt'));
  for (const usage of [{ bytes: ATTACHMENT_POLICY.ownerBytes, files: 1 }, { bytes: 0, files: 500 }, { bytes: -1, files: 0 }]) {
    assert.throws(() => prepareAttachmentReservation('owner', { filename: 'a.txt', mimeType: 'text/plain', expectedBytes: 1, uploadMutationId: 'upload' }, usage, options), /200 MiB/);
  }
  assert.throws(() => prepareAttachmentReservation('owner', { filename: 'a.txt', mimeType: 'text/plain', expectedBytes: ATTACHMENT_POLICY.fileBytes + 1, uploadMutationId: 'upload' }, { bytes: 0, files: 0 }, options), /20 MiB/);
});

test('namespace and filenames cannot inject paths, controls, active types or executable extensions', () => {
  for (const filename of ['bad\ud800.txt', 'CON.txt', '../a.txt', 'C:\\a.txt', 'a/b.txt', 'a\u0000.txt', 'a\u202e.txt', ' a.txt', 'a.txt ', '.env', 'file.exe.txt', 'file.html.txt', 'file.svg', 'file.js', 'file.pdf']) {
    assert.throws(() => validateAttachmentMetadata({ filename, mimeType: 'text/plain', expectedBytes: 1 }), AttachmentPolicyError);
  }
  for (const mimeType of ['text/html', 'image/svg+xml', 'application/x-msdownload', 'text/plain; charset=utf-8']) assert.throws(() => validateAttachmentMetadata({ filename: 'safe.txt', mimeType, expectedBytes: 1 }), AttachmentPolicyError);
  assert.equal(validateAttachmentMetadata({ filename: 'دليل.md', mimeType: 'text/plain', expectedBytes: 1 }).filename, 'دليل.md');
  assert.throws(() => attachmentStorageKey('../owner', id));
  assert.throws(() => attachmentStorageKey(namespace, 'filename.txt'));
});

test('actual signatures and strict UTF-8 determine acceptance, not declarations', () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const webp = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  for (const [bytes, mime] of [[text('%PDF-1.7'), 'application/pdf'], [png, 'image/png'], [Uint8Array.from([255, 216, 255]), 'image/jpeg'], [webp, 'image/webp'], [text('تجربة'), 'text/plain'], [text('a,b\n1,2'), 'text/csv'], [text('{"ok":true}'), 'application/json']] as const) assert.equal(hasExpectedSignature(bytes, mime), true);
  for (const [bytes, mime] of [[png, 'image/jpeg'], [text('not PDF'), 'application/pdf'], [Uint8Array.from([0xff]), 'text/plain'], [text('a\u0000b'), 'text/plain'], [text('<html>bad</html>'), 'text/plain'], [text('<svg/>'), 'text/plain'], [text('#!/bin/sh\necho bad'), 'text/plain'], [text('{broken'), 'application/json'], [text('1e999'), 'application/json']] as const) assert.equal(hasExpectedSignature(bytes, mime), false);
  assert.throws(() => validateAttachmentContent(text('long'), 'text/plain', 3), /length/);
});

test('bounded streams cancel before retaining oversize bytes even when cancel never resolves', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(text('too much')); }, cancel() { cancelled = true; return new Promise<void>(() => {}); } });
  await assert.rejects(readAttachmentStream(body, { maxBytes: 1, deadlineMs: 50 }), /reserved size/);
  assert.equal(cancelled, true);
});

test('one read deadline also bounds a hanging body and cancels it', async () => {
  let cancelled = false;
  await assert.rejects(readAttachmentStream(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }), { maxBytes: 1, deadlineMs: 10 }), (error: unknown) => error instanceof AttachmentPolicyError && error.code === 'upload_timeout');
  assert.equal(cancelled, true);
});

test('valid upload remains staged until independent verified finalization proposal', async () => {
  const bytes = text('Evidence'); const record = reserve(bytes); const { store, calls } = memoryStore();
  const staged = await stageAttachmentUpload('owner', record, stream(bytes), store, options);
  assert.equal(staged.status, 'staged'); assert.equal(staged.record.status, 'reserved'); assert.equal(staged.record.readyAt, null);
  assert.equal(record.actualBytes, null); assert.equal(record.sha256, null);
  const ready = await prepareAttachmentFinalization('owner', staged.record, store, options);
  assert.equal(ready.status, 'ready'); assert.equal(ready.actualBytes, bytes.length); assert.equal(ready.sha256, await attachmentHash(bytes)); assert.equal(ready.readyAt, now);
  assert.equal(calls.puts, 1);
});

test('successful blob and failed D1 finalization can retry from unchanged reservation without another write', async () => {
  const bytes = text('Evidence'); const record = reserve(bytes); const { store, calls } = memoryStore();
  await stageAttachmentUpload('owner', record, stream(bytes), store, options);
  // No authoritative metadata write occurred: original reservation is still reserved.
  const retry = await stageAttachmentUpload('owner', record, stream(bytes), store, options);
  assert.equal(retry.status, 'staged'); if (retry.status === 'staged') assert.equal(retry.replayed, true);
  assert.equal((await prepareAttachmentFinalization('owner', record, store, options)).status, 'ready');
  assert.equal(calls.puts, 1);
});

test('different retry body is rejected without overwriting or deleting the winning object', async () => {
  const record = reserve(text('first')); const { store, objects, calls } = memoryStore();
  await stageAttachmentUpload('owner', record, stream(text('first')), store, options);
  await assert.rejects(stageAttachmentUpload('owner', record, stream(text('other')), store, options), AttachmentReplayMismatchError);
  assert.deepEqual(objects.get(record.storageKey)!.bytes, text('first')); assert.equal(calls.deletes, 0); assert.equal(calls.puts, 1);
});

test('forged incoming content quarantines a proposal without claiming ready or writing a blob', async () => {
  const bytes = text('not a PDF'); const record = reserve(bytes, { filename: 'evidence.pdf', mimeType: 'application/pdf' }); const { store, calls } = memoryStore();
  const result = await stageAttachmentUpload('owner', record, stream(bytes), store, options);
  assert.equal(result.status, 'quarantined'); assert.equal(result.record.status, 'quarantined'); assert.equal(result.record.readyAt, null); assert.equal(calls.puts, 0); assert.equal(calls.deletes, 0);
});

test('write failure retains a reserved retry and lost write response reuses the immutable key', async () => {
  const bytes = text('Evidence'); const record = reserve(bytes); const { store, calls } = memoryStore();
  const failed = await stageAttachmentUpload('owner', record, stream(bytes), { ...store, async put() { throw new Error('unavailable'); } }, options);
  assert.equal(failed.status, 'unavailable'); assert.equal(failed.record.status, 'reserved'); assert.equal(failed.record.readyAt, null);
  const put = store.put.bind(store);
  const lost = await stageAttachmentUpload('owner', record, stream(bytes), { ...store, async put(...args) { await put(...args); throw new Error('response lost after storage'); } }, options);
  assert.equal(lost.status, 'unavailable');
  const retry = await stageAttachmentUpload('owner', record, stream(bytes), store, options);
  assert.equal(retry.status, 'staged'); if (retry.status === 'staged') assert.equal(retry.replayed, true);
  assert.equal(calls.puts, 1);
});

test('read verification failure is staged/unavailable, while corrupt stored bytes quarantine and cannot finalize', async () => {
  const bytes = text('Evidence'); const record = reserve(bytes); const { store, objects } = memoryStore();
  const result = await stageAttachmentUpload('owner', record, stream(bytes), { ...store, async get() { throw new Error('network unavailable'); } }, options);
  assert.equal(result.status, 'unavailable'); assert.equal(result.record.status, 'reserved'); assert.equal(result.record.readyAt, null);
  objects.get(record.storageKey)!.bytes = text('Corrupt!');
  const corrupt = await stageAttachmentUpload('owner', record, stream(bytes), store, options);
  assert.equal(corrupt.status, 'quarantined'); assert.equal(corrupt.record.status, 'quarantined');
  await assert.rejects(prepareAttachmentFinalization('owner', record, store, options), /digest/);
});

test('cross-owner namespace, expired reservation and finalized cleanup are rejected before effects', async () => {
  const bytes = text('Evidence'); const record = reserve(bytes); const { store, calls } = memoryStore();
  await assert.rejects(stageAttachmentUpload('foreign-owner', record, stream(bytes), store, { ...options, ownerNamespace: foreignNamespace }), /unavailable/);
  await assert.rejects(stageAttachmentUpload('owner', record, stream(bytes), store, { ...options, now: record.expiresAt }), /expired/);
  assert.equal(calls.puts, 0);
  await stageAttachmentUpload('owner', record, stream(bytes), store, options);
  const ready = await prepareAttachmentFinalization('owner', record, store, options);
  assert.throws(() => prepareAttachmentRetirement('owner', ready, [], { ...options, now: record.expiresAt }, 'expired-reservation'), /unfinalized/);
  assert.throws(() => prepareAttachmentRetirement('owner', ready, ['immutable-evidence-v1'], options, 'owner-delete'), /reference/);
  assert.equal(calls.deletes, 0);
  const cleanup = prepareAttachmentRetirement('owner', record, [], { ...options, now: record.expiresAt }, 'expired-reservation');
  assert.equal(cleanup.record.status, 'deleted'); assert.equal(cleanup.cleanup.storageKey, record.storageKey); assert.equal(calls.deletes, 0);
});

test('concurrent different bodies race through atomic put-if-absent with one immutable winner', async () => {
  const record = reserve(text('first')); const { store, objects } = memoryStore();
  const head = store.head.bind(store); let reads = 0; let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const racing: BlobStore = { ...store, async head(key) { const observed = await head(key); if (++reads <= 2) { if (reads === 2) release(); await gate; } return observed; } };
  const results = await Promise.allSettled([stageAttachmentUpload('owner', record, stream(text('first')), racing, options), stageAttachmentUpload('owner', record, stream(text('other')), racing, options)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected' && result.reason instanceof AttachmentReplayMismatchError).length, 1);
  assert.equal(objects.size, 1);
});

test('private R2 adapter uses conditional writes and verifies stored metadata without a public URL', async () => {
  const objects = new Map<string, { bytes: Uint8Array; metadata: BlobMetadata }>(); let conditional = 0;
  const bucket: AttachmentBucket = {
    async put(key, bytes, options) { assert.equal(options.onlyIf.etagDoesNotMatch, '*'); conditional++; if (objects.has(key)) return null; objects.set(key, { bytes: bytes.slice(), metadata: { bytes: bytes.length, sha256: options.customMetadata.sha256, mimeType: options.httpMetadata.contentType } }); return { size: bytes.length }; },
    async get(key) { const value = objects.get(key); return value ? { size: value.bytes.length, body: stream(value.bytes), httpMetadata: { contentType: value.metadata.mimeType }, customMetadata: { sha256: value.metadata.sha256 } } : null; },
    async head(key) { const value = objects.get(key); return value ? { size: value.bytes.length, httpMetadata: { contentType: value.metadata.mimeType }, customMetadata: { sha256: value.metadata.sha256 } } : null; },
    async delete(key) { objects.delete(key); },
  };
  const store = createR2BlobStore(bucket); const bytes = text('Evidence'); const record = reserve(bytes);
  assert.equal((await stageAttachmentUpload('owner', record, stream(bytes), store, options)).status, 'staged');
  assert.equal((await stageAttachmentUpload('owner', record, stream(bytes), store, options)).status, 'staged');
  assert.equal(conditional, 1);
  const immutableBytes = bytes.slice();
  const immutableMetadata = { bytes: bytes.length, sha256: await attachmentHash(bytes), mimeType: 'text/plain' };
  const nextKey = attachmentStorageKey(namespace, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  const pending = store.put(nextKey, immutableBytes, immutableMetadata);
  immutableBytes.fill(0); immutableMetadata.mimeType = 'text/html'; immutableMetadata.sha256 = '0'.repeat(64);
  assert.equal(await pending, 'stored');
  assert.deepEqual(objects.get(nextKey)!.bytes, bytes); assert.equal(objects.get(nextKey)!.metadata.mimeType, 'text/plain');
  await assert.rejects(store.put(record.storageKey, bytes, { bytes: bytes.length, sha256: '0'.repeat(64), mimeType: 'text/plain' }), /metadata/);
  await assert.rejects(store.get('../public'), /key|namespace/);
  const unavailable = await stageAttachmentUpload('owner', record, stream(bytes), createR2BlobStore(), options);
  assert.equal(unavailable.status, 'unavailable'); assert.equal(unavailable.record.status, 'reserved');
});


test('ready reads revalidate bytes and safe download headers keep private raster previews authenticated', async () => {
  const bytes = text('Evidence'); const record = reserve(bytes); const { store } = memoryStore();
  await assert.rejects(readReadyAttachment('owner', record, store, options), /ready/);
  await stageAttachmentUpload('owner', record, stream(bytes), store, options);
  const ready = await prepareAttachmentFinalization('owner', record, store, options);
  assert.deepEqual((await readReadyAttachment('owner', ready, store, options)).bytes, bytes);
  const headers = attachmentDownloadHeaders('دليل.txt', 'text/plain', true);
  assert.equal(headers['Content-Type'], 'text/plain'); assert.equal(headers['X-Content-Type-Options'], 'nosniff'); assert.equal(headers['Cache-Control'], 'private, no-store');
  assert.match(headers['Content-Disposition'], /^attachment;/); assert.match(headers['Content-Disposition'], /filename\*=UTF-8''%/);
  assert.match(attachmentDownloadHeaders('image.png', 'image/png', true)['Content-Disposition'], /^inline;/);
  assert.throws(() => attachmentDownloadHeaders('bad\r\nInjected.txt', 'text/plain'));
  assert.match(attachmentDownloadHeaders('full＂width.txt', 'text/plain')['Content-Disposition'], /filename="full_width.txt"/);
});
