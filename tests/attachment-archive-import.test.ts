import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectAttachmentArchive, AttachmentArchiveImportError } from '../lib/attachment-archive-import.ts';
import { writeAttachmentArchive } from '../lib/attachment-archive-export.ts';
import { writeStoredArchive, readStoredArchive, type ArchiveEntry } from '../lib/attachment-archive.ts';
import { contentHash } from '../lib/canonical-json.ts';
import { deriveAttachmentManifest } from '../lib/attachment-manifest.ts';
import { exportWorkspaceBundle } from '../lib/workspace-export.ts';
import { database } from './helpers/sqlite.ts';
import { loadWorkspace } from '../lib/workspace-store.ts';
import { createSeedWorkspace } from '../lib/seed.ts';
import type { AttachmentRecord } from '../lib/evidence-contract.ts';
const now = '2026-10-18T12:00:00.000Z';
async function fixture() {
  const { db, sqlite } = database();
  try {
    await loadWorkspace(db, 'synthetic', () => createSeedWorkspace(now), now);
    const bundle = await exportWorkspaceBundle(db, 'synthetic', { now: () => now });
    const bytes = new TextEncoder().encode('original attachment text');
    const record: AttachmentRecord = { id: 'original-logical-id', status: 'ready', filename: 'original.txt', mimeType: 'text/plain', expectedBytes: bytes.length, actualBytes: bytes.length, sha256: await contentHash(bytes), storageKey: 'untrusted-imported-key', createdAt: now, expiresAt: now, readyAt: now, uploadMutationId: 'synthetic-upload-id', quarantineReason: null };
    bundle.modules.attachments.records = [{ id: record.id, rowRevision: 1, contentHash: await contentHash(JSON.stringify(record)), value: record }];
    bundle.modules.attachment_usage.records = [{ id: 'quota', rowRevision: 1, contentHash: 'a'.repeat(64), value: { bytes: bytes.length, files: 1 } }];
    bundle.attachments = deriveAttachmentManifest(bundle.modules);
    return { bundle, bytes, record };
  } finally { sqlite.close(); }
}
async function entriesOf(stream: ReadableStream<Uint8Array>) { const entries = []; for await (const value of readStoredArchive(stream)) entries.push(value); return entries; }
async function nativeEntries() { const f = await fixture(); return { ...f, entries: await entriesOf(writeAttachmentArchive(f.bundle, [f.record], async () => f.bytes)) }; }
function mutateManifest(entries: ArchiveEntry[], mutate: (manifest: Record<string, unknown>) => void) {
  const manifest = JSON.parse(new TextDecoder().decode(entries[0].bytes)); mutate(manifest);
  entries[0] = { path: 'manifest.json', bytes: new TextEncoder().encode(JSON.stringify(manifest)) };
}
test('native roundtrip stages verified logical IDs and returns original manifest only after exhaustion', async () => {
  const f = await nativeEntries(), stages: unknown[] = [];
  const original = JSON.parse(new TextDecoder().decode(f.entries[0].bytes));
  const result = await inspectAttachmentArchive(writeStoredArchive(f.entries), async (id, bytes, sha) => { stages.push({ id, bytes: bytes.slice(), sha }); });
  assert.deepEqual(result.manifest, original);
  assert.deepEqual(stages, [{ id: f.record.id, bytes: f.bytes, sha: f.record.sha256 }]);
  assert.equal(result.metadataBundle.completeness, 'metadata-only');
  assert.equal(result.metadataBundle.attachments[0].availability, 'excluded');
  assert.equal(result.manifest.attachments[0].availability, 'included');
  assert.equal(result.staged[0].status, 'staged');
});
test('late central directory corruption yields no verified result and exposes cleanup attempts', async () => {
  const f = await nativeEntries();
  const bytes = new Uint8Array(await new Response(writeStoredArchive(f.entries)).arrayBuffer());
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < bytes.length - 4; i++) if (view.getUint32(i, true) === 0x02014b50) { bytes[i + 16] ^= 1; break; }
  let staged = 0;
  await assert.rejects(inspectAttachmentArchive(new Response(bytes).body!, async () => { staged++; }), error => {
    assert.ok(error instanceof AttachmentArchiveImportError); assert.equal(error.staging.length, 1); assert.equal(error.staging[0].status, 'staged'); return true;
  });
  assert.equal(staged, 1);
});
test('failed staging includes attempted logical ID even if callback wrote before rejecting', async () => {
  const f = await nativeEntries();
  await assert.rejects(inspectAttachmentArchive(writeStoredArchive(f.entries), async () => { throw new Error('synthetic partially written staging'); }), error => {
    assert.ok(error instanceof AttachmentArchiveImportError); assert.equal(error.staging[0].id, f.record.id); assert.equal(error.staging[0].status, 'attempted'); return true;
  });
});
test('missing and orphan members, incorrect order and metadata identity are rejected', async () => {
  for (const variant of ['missing', 'orphan', 'order', 'identity', 'metadata', 'version', 'claim'] as const) {
    const f = await nativeEntries(); let staged = 0;
    if (variant === 'missing') f.entries.pop();
    if (variant === 'orphan') f.entries.push({ path: `attachments/${'f'.repeat(64)}`, bytes: new Uint8Array() });
    if (variant === 'order') f.entries.reverse();
    if (variant === 'identity') mutateManifest(f.entries, m => { (m.attachments as { id: string }[])[0].id = 'different-logical-id'; });
    if (variant === 'metadata') mutateManifest(f.entries, m => { (m.attachments as { filename: string }[])[0].filename = 'different.txt'; });
    if (variant === 'version') mutateManifest(f.entries, m => { m.bundleVersion = 99; });
    if (variant === 'claim') mutateManifest(f.entries, m => { (m.attachments as { availability: string }[])[0].availability = 'excluded'; });
    await assert.rejects(inspectAttachmentArchive(writeStoredArchive(f.entries), async () => { staged++; }));
    if (!['missing', 'orphan'].includes(variant)) assert.equal(staged, 0);
  }
});
test('valid ZIP CRC does not substitute for manifest SHA256 integrity', async () => {
  const f = await nativeEntries(); f.entries[1].bytes = new Uint8Array(f.bytes.length);
  let stages = 0;
  await assert.rejects(inspectAttachmentArchive(writeStoredArchive(f.entries), async () => { stages++; }), /digest/);
  assert.equal(stages, 0);
});
test('manifest hook runs exactly once before bytes with isolated original and metadata copies', async () => {
  const f = await nativeEntries(), order: string[] = [];
  const original = JSON.parse(new TextDecoder().decode(f.entries[0].bytes));
  const result = await inspectAttachmentArchive(writeStoredArchive(f.entries), async (id, bytes, digest) => {
    order.push('stage'); assert.equal(id, f.record.id); assert.deepEqual(bytes, f.bytes); assert.equal(digest, f.record.sha256);
  }, { async onManifest(manifest, metadata) {
    order.push('manifest');
    assert.equal(manifest.completeness, 'complete'); assert.equal(metadata.completeness, 'metadata-only');
    manifest.attachments[0].id = 'injected'; manifest.attachments[0].sha256 = 'f'.repeat(64);
    manifest.attachments[0].archivePath = `attachments/${'f'.repeat(64)}`;
    manifest.planning.projects[0].name = 'mutated';
    metadata.modules.attachments.records.length = 0;
    metadata.attachments.length = 0;
  } });
  assert.deepEqual(order, ['manifest', 'stage']);
  assert.deepEqual(result.manifest, original);
  assert.equal(result.metadataBundle.modules.attachments.records.length, 1);
  assert.equal(result.metadataBundle.attachments.length, 1);
});
test('manifest reservation failure prevents byte staging and reports no attempted byte writes', async () => {
  const f = await nativeEntries(); let stages = 0, hooks = 0;
  await assert.rejects(inspectAttachmentArchive(writeStoredArchive(f.entries), async () => { stages++; }, { async onManifest() { hooks++; throw new Error('quota reservation rejected'); } }), error => {
    assert.ok(error instanceof AttachmentArchiveImportError); assert.match(error.message, /quota reservation/); assert.deepEqual(error.staging, []); return true;
  });
  assert.equal(hooks, 1); assert.equal(stages, 0);
});
test('invalid manifest never invokes reservation hook and later staging failure retains attempts', async () => {
  const f = await nativeEntries(); let hooks = 0;
  mutateManifest(f.entries, m => { (m.attachments as {filename:string}[])[0].filename = 'mismatch.txt'; });
  await assert.rejects(inspectAttachmentArchive(writeStoredArchive(f.entries), async () => { throw new Error('unexpected stage'); }, { async onManifest() { hooks++; } }));
  assert.equal(hooks, 0);
  const valid = await nativeEntries();
  await assert.rejects(inspectAttachmentArchive(writeStoredArchive(valid.entries), async () => { throw new Error('stage failure'); }, { async onManifest() { hooks++; } }), error => {
    assert.ok(error instanceof AttachmentArchiveImportError); assert.equal(error.staging[0].id, valid.record.id); assert.equal(error.staging[0].status, 'attempted'); return true;
  });
  assert.equal(hooks, 1);
});
