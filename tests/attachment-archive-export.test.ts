import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeAttachmentArchive, attachmentArchivePath } from '../lib/attachment-archive-export.ts';
import { readStoredArchive } from '../lib/attachment-archive.ts';
import { contentHash } from '../lib/canonical-json.ts';
import { deriveAttachmentManifest } from '../lib/attachment-manifest.ts';
import { createSeedWorkspace } from '../lib/seed.ts';
import type { WorkspaceBundle } from '../lib/workspace-export.ts';
import type { AttachmentRecord } from '../lib/evidence-contract.ts';
const now = '2026-10-18T12:00:00.000Z';
async function fixture(count = 1) {
  const bytes = new TextEncoder().encode('verified original source');
  const records: AttachmentRecord[] = [];
  for (let i = 0; i < count; i++) records.push({ id: `original-id-${i}`, status: 'ready', filename: `original-${i}.txt`, mimeType: 'text/plain', expectedBytes: bytes.length, actualBytes: bytes.length, sha256: await contentHash(bytes), storageKey: `opaque-owner-location/${i}`, createdAt: now, expiresAt: now, readyAt: now, uploadMutationId: `original-mutation-${i}`, quarantineReason: null });
  const modules = { attachments: { schemaVersion: 1, records: records.map(value => ({ id: value.id, rowRevision: 1, contentHash: 'a'.repeat(64), value })) } };
  const planning = createSeedWorkspace(now);
  const bundle: WorkspaceBundle = { format: 'control-room', bundleVersion: 1, exportedAt: now, source: { workspaceRevision: 7, planningSchemaVersion: planning.schemaVersion, moduleWatermarks: {}, sourceHashes: {} }, planning, modules, attachments: deriveAttachmentManifest(modules), completeness: 'metadata-only' };
  return { bytes, records, bundle };
}
async function consume(stream: ReadableStream<Uint8Array>) { const entries = []; for await (const entry of readStoredArchive(stream)) entries.push(entry); return entries; }
test('complete archive uses deterministic ID hash paths and retains original IDs and frozen bundle', async () => {
  const f = await fixture(2), before = structuredClone(f.bundle), readIds: string[] = [];
  const stream = writeAttachmentArchive(f.bundle, f.records, async id => { readIds.push(id); return f.bytes; });
  f.bundle.planning.projects[0].name = 'Changed after export began';
  f.records[0].filename = 'mutated.txt';
  const entries = await consume(stream);
  assert.deepEqual(readIds, ['original-id-0', 'original-id-1']);
  assert.equal(entries[0].path, 'manifest.json');
  const manifest = JSON.parse(new TextDecoder().decode(entries[0].bytes)) as WorkspaceBundle;
  assert.deepEqual(manifest.planning, before.planning);
  assert.deepEqual(manifest.modules, before.modules);
  assert.equal(manifest.completeness, 'complete');
  for (const [index, value] of manifest.attachments.entries()) {
    assert.equal(value.id, before.attachments[index].id);
    assert.equal(value.archivePath, await attachmentArchivePath(value.id));
    assert.match(value.archivePath!, /^attachments\/[a-f0-9]{64}$/);
    assert.equal(value.availability, 'included');
    assert.deepEqual(entries[index + 1].bytes, f.bytes);
  }
  assert.equal(await attachmentArchivePath('original-id-0'), `attachments/${await contentHash('original-id-0')}`);
  assert.deepEqual(before.attachments.map(x => x.availability), ['excluded', 'excluded']);
});
test('byte corruption and wrong length never produce a complete archive', async () => {
  const f = await fixture();
  await assert.rejects(consume(writeAttachmentArchive(f.bundle, f.records, async () => new Uint8Array(f.bytes.length))), /digest/);
  await assert.rejects(consume(writeAttachmentArchive(f.bundle, f.records, async () => new Uint8Array())), /length/);
});
test('late source failure truncates ZIP and makes already yielded files staging only', async () => {
  const f = await fixture(2);
  const emitted: Uint8Array[] = [];
  const reader = writeAttachmentArchive(f.bundle, f.records, async id => { if (id === f.records[1].id) throw new Error('source unavailable'); return f.bytes; }).getReader();
  await assert.rejects(async () => { while (true) { const next = await reader.read(); if (next.done) break; emitted.push(next.value); } }, /source unavailable/);
  assert.ok(emitted.length >= 2);
  const partial = new ReadableStream<Uint8Array>({ start(c) { for (const chunk of emitted) c.enqueue(chunk); c.close(); } });
  await assert.rejects(consume(partial), /truncated/);
});
test('metadata mismatches, duplicate/missing supplied records and legacy metadata fail before byte reads', async () => {
  for (const variant of ['supplied', 'manifest', 'duplicate', 'missing', 'legacy'] as const) {
    const f = await fixture(); let reads = 0;
    if (variant === 'supplied') f.records = [{ ...f.records[0], filename: 'different.txt' }];
    if (variant === 'manifest') f.bundle.attachments[0].sha256 = 'b'.repeat(64);
    if (variant === 'duplicate') f.records = [f.records[0], f.records[0]];
    if (variant === 'missing') f.records = [];
    if (variant === 'legacy') { f.bundle.modules.attachments.records.push({ id: 'legacy', rowRevision: 1, contentHash: 'a'.repeat(64), value: { kind: 'legacy', physicalId: 'legacy', record: { oldField: 'unresolved' } } }); }
    await assert.rejects(consume(writeAttachmentArchive(f.bundle, f.records, async () => { reads++; return f.bytes; })));
    assert.equal(reads, 0);
  }
});
test('no-attachment export still writes a complete manifest without byte access', async () => {
  const f = await fixture(0);
  const entries = await consume(writeAttachmentArchive(f.bundle, f.records, async () => { throw new Error('unexpected read'); }));
  assert.equal(entries.length, 1);
  assert.equal(JSON.parse(new TextDecoder().decode(entries[0].bytes)).completeness, 'complete');
});
