import assert from 'node:assert/strict';
import { test } from 'node:test';
import { database } from './helpers/sqlite.ts';
import { loadWorkspace } from '../lib/workspace-store.ts';
import { createSeedWorkspace } from '../lib/seed.ts';
import { exportWorkspaceBundle } from '../lib/workspace-export.ts';
import { contentHash, canonical } from '../lib/canonical-json.ts';
import { deriveAttachmentManifest } from '../lib/attachment-manifest.ts';
import { writeAttachmentArchive } from '../lib/attachment-archive-export.ts';
import { stageAttachmentArchive } from '../lib/attachment-archive-staging.ts';
import { readStagedImport } from '../lib/import-staging.ts';
import type { BlobStore, BlobMetadata } from '../lib/attachments.ts';
import type { AttachmentRecord } from '../lib/evidence-contract.ts';
const now = '2026-10-18T12:00:00.000Z';
/** Labelled synthetic in-memory blob store: no private bucket or owner data. */
class SyntheticBlobStore implements BlobStore {
 available = true; objects = new Map<string, { bytes: Uint8Array; metadata: BlobMetadata }>(); puts = 0; afterPut?: () => void;
 corrupt = false; rejectAfterWrite = false;
 async put(key: string, bytes: Uint8Array, metadata: BlobMetadata): Promise<'stored' | 'exists'> { this.puts++; if (this.objects.has(key)) return 'exists'; this.objects.set(key, { bytes: this.corrupt ? new Uint8Array(bytes.length) : bytes.slice(), metadata: { ...metadata } }); this.afterPut?.(); if (this.rejectAfterWrite) throw new Error('ambiguous synthetic PUT'); return 'stored'; }
 async head(key: string) { return this.objects.get(key)?.metadata ?? null; }
 async get(key: string) { const object = this.objects.get(key); return object ? { metadata: { ...object.metadata }, body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(object.bytes); c.close(); } }) } : null; }
 async delete() { throw new Error('staging must never delete objects'); }
}
async function fixture() {
 const f = database(); await loadWorkspace(f.db, 'synthetic', () => createSeedWorkspace(now), now);
 const bundle = await exportWorkspaceBundle(f.db, 'synthetic', { now: () => now });
 const bytes = new TextEncoder().encode('synthetic archive source');
 const record: AttachmentRecord = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', status: 'ready', filename: 'original.txt', mimeType: 'text/plain', expectedBytes: bytes.length, actualBytes: bytes.length, sha256: await contentHash(bytes), storageKey: 'attachments/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', createdAt: now, expiresAt: now, readyAt: now, uploadMutationId: 'synthetic-original-upload', quarantineReason: null };
 bundle.modules.attachments.records = [{ id: record.id, rowRevision: 7, contentHash: await contentHash(canonical(record)), value: record }];
 bundle.modules.attachment_usage.records = [{ id: 'quota', rowRevision: 1, contentHash: 'a'.repeat(64), value: { files: 1, bytes: bytes.length } }];
 bundle.attachments = deriveAttachmentManifest(bundle.modules);
 const store = new SyntheticBlobStore();
 return { ...f, bundle, bytes, record, store, stream: () => writeAttachmentArchive(bundle, [record], async () => bytes), options: { store, now: () => now, targetRevision: 1 } };
}
test('full native staging reserves before PUT, rewrites only ready keys and leaves active owner records unchanged', async () => {
 const f = await fixture(); try {
 const before = f.sqlite.prepare('SELECT * FROM workspaces').all(), original = structuredClone(f.bundle);
 f.store.afterPut = () => { assert.equal(f.sqlite.prepare("SELECT status FROM attachment_archive_stages").get()!.status, 'preparing'); assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM attachment_upload_attempts WHERE settled_at IS NULL').get()!.n, 1); };
 const result = await stageAttachmentArchive(f.db, 'synthetic', f.stream(), f.options);
 assert.equal(result.archive.files, 1); assert.equal(result.archive.bytes, f.bytes.length);
 assert.equal(f.sqlite.prepare('SELECT status FROM attachment_archive_stages').get()!.status, 'verified');
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM attachment_upload_attempts WHERE settled_at IS NULL').get()!.n, 0);
 const stored = await readStagedImport(f.db, 'synthetic', result.stage.id, now), bundle = stored.stage.bundle!;
 const row = bundle.modules.attachments.records[0] as { value: AttachmentRecord; contentHash: string; rowRevision: number };
 assert.notEqual(row.value.storageKey, f.record.storageKey); assert.equal(row.rowRevision, 7);
 assert.deepEqual({ ...row.value, storageKey: f.record.storageKey }, f.record);
 assert.equal(row.contentHash, await contentHash(canonical(row.value)));
 assert.equal(bundle.source.sourceHashes.attachments, await contentHash(canonical(bundle.modules.attachments.records)));
 assert.deepEqual(bundle.planning, original.planning); assert.deepEqual(f.bundle, original);
 assert.deepEqual(f.sqlite.prepare('SELECT * FROM workspaces').all(), before);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM attachments').get()!.n, 0);
 } finally { f.sqlite.close(); }
});
test('late revision conflict fails stage and keeps verified physical bytes charged without metadata import', async () => {
 const f = await fixture(); try { f.store.afterPut = () => { f.sqlite.exec('UPDATE workspaces SET revision=2'); };
 await assert.rejects(stageAttachmentArchive(f.db, 'synthetic', f.stream(), f.options), /target changed/);
 assert.equal(f.sqlite.prepare('SELECT status FROM attachment_archive_stages').get()!.status, 'failed');
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_imports').get()!.n, 0);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM attachment_blob_objects WHERE purged_at IS NULL').get()!.n, 1);
 } finally { f.sqlite.close(); }
});
test('corrupt stored bytes and malformed late ZIP cannot create verified stage', async () => {
 for (const variant of ['blob', 'zip'] as const) { const f = await fixture(); try {
 let stream = f.stream();
 if (variant === 'blob') f.store.corrupt = true;
 else { const bytes = new Uint8Array(await new Response(stream).arrayBuffer()); bytes[bytes.length - 1] = 1; stream = new Response(bytes).body!; }
 await assert.rejects(stageAttachmentArchive(f.db, 'synthetic', stream, f.options));
 assert.equal(f.sqlite.prepare('SELECT status FROM attachment_archive_stages').get()!.status, 'failed');
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_imports').get()!.n, 0);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM attachment_blob_objects').get()!.n, 1);
 } finally { f.sqlite.close(); } }
});
test('ambiguous PUT rejection retains durable pending attempt and quota for cleanup fencing', async () => {
 const f = await fixture(); try { f.store.rejectAfterWrite = true;
 await assert.rejects(stageAttachmentArchive(f.db, 'synthetic', f.stream(), f.options), /ambiguous/);
 assert.equal(f.store.objects.size, 1);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM attachment_upload_attempts WHERE settled_at IS NULL').get()!.n, 1);
 assert.equal(f.sqlite.prepare('SELECT verified_at FROM attachment_blob_objects').get()!.verified_at, null);
 assert.equal(f.sqlite.prepare('SELECT status FROM attachment_archive_stages').get()!.status, 'failed');
 } finally { f.sqlite.close(); }
});
test('physical headroom is reserved as a whole before any PUT and owner isolation rejects foreign revision', async () => {
 const f = await fixture(); try {
 for (let i = 0; i < 500; i++) f.sqlite.prepare('INSERT INTO attachment_blob_objects(user_id,storage_key,attachment_id,namespace,bytes,sha256,created_at) VALUES(?,?,?,?,0,NULL,?)').run('synthetic', `synthetic-${i}`, String(i), 'prior-stage', now);
 await assert.rejects(stageAttachmentArchive(f.db, 'synthetic', f.stream(), f.options)); assert.equal(f.store.puts, 0);
 await assert.rejects(stageAttachmentArchive(f.db, 'foreign', f.stream(), f.options)); assert.equal(f.store.puts, 0);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM attachment_archive_stages').get()!.n, 0);
 } finally { f.sqlite.close(); }
});
test('final CAS rejects physical digest changes and newly pending uploads after metadata preparation', async () => {
 for (const variant of ['digest', 'pending'] as const) { const f = await fixture(); try {
 const action = variant === 'digest' ? "UPDATE attachment_blob_objects SET sha256='ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';" : `INSERT INTO attachment_upload_attempts(user_id,token,attachment_id,storage_key,created_at,settled_at) SELECT user_id,'cccccccc-cccc-4ccc-8ccc-cccccccccccc',attachment_id,storage_key,'${now}',NULL FROM attachment_blob_objects;`;
 f.sqlite.exec(`CREATE TRIGGER synthetic_after_metadata AFTER INSERT ON workspace_imports BEGIN ${action} END;`);
 await assert.rejects(stageAttachmentArchive(f.db, 'synthetic', f.stream(), f.options), /target changed/);
 assert.equal(f.sqlite.prepare('SELECT status FROM attachment_archive_stages').get()!.status, 'failed');
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_imports').get()!.n, 0);
 } finally { f.sqlite.close(); } }
});
test('same-ID archive after definitive purge stages new namespace while old key stays permanently fenced', async () => {
 const f = await fixture(); try {
 const namespace='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 f.sqlite.prepare('INSERT INTO attachment_blob_objects(user_id,storage_key,attachment_id,namespace,bytes,sha256,created_at,verified_at,purged_at) VALUES(?,?,?,?,?,?,?,?,?)').run('synthetic',f.record.storageKey,f.record.id,namespace,f.bytes.length,f.record.sha256,now,now,now);
 f.sqlite.prepare('INSERT INTO attachment_blob_fences(user_id,storage_key,attachment_id,namespace,token,created_at,purged_at) VALUES(?,?,?,?,?,?,?)').run('synthetic',f.record.storageKey,f.record.id,namespace,crypto.randomUUID(),now,now);
 const result=await stageAttachmentArchive(f.db,'synthetic',f.stream(),f.options);
 const row=result.stage.bundle!.modules.attachments.records[0] as {value:AttachmentRecord};
 assert.notEqual(row.value.storageKey,f.record.storageKey);assert.equal(row.value.id,f.record.id);
 assert.equal(f.store.objects.has(f.record.storageKey),false);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM attachment_blob_fences WHERE storage_key=?').get(f.record.storageKey)!.n,1);
 const registered=f.sqlite.prepare("SELECT source_import_id FROM attachment_blob_namespaces WHERE purpose='archive-stage'").get()!;
 assert.equal(registered.source_import_id,result.stage.id);
 }finally{f.sqlite.close();}
});
test('namespace import linkage and verified stage commit atomically', async () => {
 const f=await fixture();try{
 f.sqlite.exec("CREATE TRIGGER synthetic_namespace_link_failure BEFORE UPDATE OF source_import_id ON attachment_blob_namespaces BEGIN SELECT RAISE(ABORT,'synthetic link failure'); END;");
 await assert.rejects(stageAttachmentArchive(f.db,'synthetic',f.stream(),f.options),/target changed/);
 assert.equal(f.sqlite.prepare('SELECT status,import_id FROM attachment_archive_stages').get()!.status,'failed');
 assert.equal(f.sqlite.prepare('SELECT import_id FROM attachment_archive_stages').get()!.import_id,null);
 assert.equal(f.sqlite.prepare('SELECT source_import_id FROM attachment_blob_namespaces').get()!.source_import_id,null);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_imports').get()!.n,0);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM attachment_blob_objects WHERE purged_at IS NULL').get()!.n,1);
 }finally{f.sqlite.close();}
});
