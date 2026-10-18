import type { SqlDatabase } from './workspace-store.ts';
import type { BlobStore } from './attachments.ts';
import { attachmentStorageKey, readReadyAttachment } from './attachments.ts';
import { inspectAttachmentArchive } from './attachment-archive-import.ts';
import { reserveArchiveObjects, ARCHIVE_RESERVATION_LIMITS } from './attachment-physical-quota.ts';
import { attachmentRecordSchema } from './evidence-module.ts';
import { validateAttachmentContent } from './attachment-policy.ts';
import { canonical, contentHash } from './canonical-json.ts';
import { stageImport, discardStagedImport } from './import-staging.ts';
import type { ImportStage } from './import-quarantine.ts';
import type { AttachmentRecord } from './evidence-contract.ts';
import { finishUpload } from './attachment-upload-fences.ts';

export interface StagedAttachmentArchive { stage: ImportStage; archive: { id: string; files: number; bytes: number; expiresAt: string; sourceManifestHash: string } }
/** Private provisional staging only. Authentication is the caller's responsibility.
 * Neither successful staging nor imported keys grant workspace/import authority.
 * Failed physical reservations remain charged; pending PUT tokens never time-expire. */
export async function stageAttachmentArchive(db: SqlDatabase, owner: string, stream: ReadableStream<Uint8Array>, options: { store: BlobStore; now: () => string; targetRevision: number }): Promise<StagedAttachmentArchive> {
  if (!options.store.available) throw new Error('Private attachment storage is unavailable.');
  const stageId = crypto.randomUUID(), namespace = crypto.randomUUID();
  const createdAt = options.now(), expiresAt = new Date(Date.parse(createdAt) + ARCHIVE_RESERVATION_LIMITS.ttlMs).toISOString();
  const records = new Map<string, AttachmentRecord>();
  let reserved = false, sourceManifestHash = '', metadataStage: ImportStage | undefined;
  try {
    const result = await inspectAttachmentArchive(stream, async (id, bytes, digest) => {
      const record = records.get(id);
      if (!record || record.sha256 !== digest) throw new Error('Unreserved archive attachment.');
      validateAttachmentContent(bytes, record.mimeType, record.expectedBytes);
      if (await contentHash(bytes) !== digest) throw new Error('Archive attachment digest differs.');
      const key = record.storageKey, token = crypto.randomUUID(), now = options.now();
      const attempt = await db.prepare(`INSERT INTO attachment_upload_attempts(user_id,token,attachment_id,storage_key,created_at,settled_at)
        SELECT ?,?,?,?,?,NULL WHERE EXISTS(SELECT 1 FROM attachment_archive_stages s JOIN attachment_blob_objects o ON o.user_id=s.user_id AND o.namespace=s.namespace
        WHERE s.user_id=? AND s.id=? AND s.status='preparing' AND s.expires_at>? AND o.storage_key=? AND o.attachment_id=? AND o.bytes=? AND o.sha256=? AND o.verified_at IS NULL AND o.purged_at IS NULL)
        AND NOT EXISTS(SELECT 1 FROM attachment_blob_fences WHERE (user_id=? AND attachment_id=?) OR storage_key=?)
        AND NOT EXISTS(SELECT 1 FROM attachment_upload_attempts WHERE user_id=? AND storage_key=? AND settled_at IS NULL)`)
        .bind(owner, token, id, key, now, owner, stageId, now, key, id, bytes.length, digest, owner, id, key, owner, key).run();
      if (attempt.meta.changes !== 1) throw new Error('Archive upload reservation is unavailable or fenced.');
      // A rejecting PUT may have outlived its request: retain its pending token.
      await options.store.put(key, bytes, { bytes: bytes.length, sha256: digest, mimeType: record.mimeType });
      if (!await finishUpload(db, owner, { token, now: options.now(), definitivelySettled: true })) throw new Error('Archive upload settlement failed.');
      await readReadyAttachment(owner, record, options.store, { ownerNamespace: namespace, now: options.now() });
      const verified = await db.prepare(`UPDATE attachment_blob_objects SET verified_at=? WHERE user_id=? AND storage_key=? AND namespace=? AND attachment_id=? AND bytes=? AND sha256=? AND purged_at IS NULL AND verified_at IS NULL
        AND EXISTS(SELECT 1 FROM attachment_archive_stages WHERE user_id=? AND id=? AND status='preparing' AND expires_at>?)
        AND NOT EXISTS(SELECT 1 FROM attachment_blob_fences WHERE (user_id=? AND attachment_id=?) OR storage_key=?)`)
        .bind(options.now(), owner, key, namespace, id, bytes.length, digest, owner, stageId, options.now(), owner, id, key).run();
      if (verified.meta.changes !== 1) throw new Error('Archive object verification reservation changed.');
    }, { async onManifest(manifest, metadata) {
      sourceManifestHash = await contentHash(canonical(manifest));
      for (const row of metadata.modules.attachments?.records ?? []) {
        const record = attachmentRecordSchema.parse((row as { value: unknown }).value);
        if (record.status === 'ready') records.set(record.id, { ...record, storageKey: attachmentStorageKey(namespace, record.id) });
      }
      await reserveArchiveObjects(db, owner, { stageId, namespace, sourceManifestHash, manifestJson: JSON.stringify(manifest), createdAt, expiresAt, targetRevision: options.targetRevision, records: [...records.values()].map(record => ({ id: record.id, bytes: record.expectedBytes, sha256: record.sha256! })) });
      reserved = true;
    } });
    const bundle = structuredClone(result.metadataBundle);
    for (const raw of bundle.modules.attachments?.records ?? []) {
      const row = raw as { id: string; value: unknown; contentHash: string };
      const replacement = records.get(row.id);
      if (replacement) { row.value = replacement; row.contentHash = await contentHash(canonical(replacement)); }
    }
    if (bundle.modules.attachments) {
      const hash = await contentHash(canonical(bundle.modules.attachments.records));
      bundle.source.sourceHashes.attachments = hash; bundle.source.moduleWatermarks.attachments = hash;
    }
    metadataStage = await stageImport(db, owner, new TextEncoder().encode(JSON.stringify(bundle)), options.now());
    if (!metadataStage.bundle || metadataStage.diagnostics.some(item => item.code)) throw new Error('Rewritten archive metadata failed import validation.');
    const now = options.now();
    const expectedObjects = JSON.stringify([...records.values()].map(record => ({ id: record.id, key: record.storageKey, bytes: record.expectedBytes, sha256: record.sha256 })));
    const verified = await db.prepare(`UPDATE attachment_archive_stages SET status='verified',import_id=?,import_hash=? WHERE user_id=? AND id=? AND status='preparing' AND expires_at>? AND target_revision=?
      AND EXISTS(SELECT 1 FROM workspace_imports WHERE user_id=? AND id=? AND content_hash=? AND expires_at>?)
      AND EXISTS(SELECT 1 FROM workspaces WHERE user_id=? AND revision=?)
      AND (SELECT COUNT(*) FROM attachment_blob_objects WHERE user_id=? AND namespace=?)=?
      AND NOT EXISTS(SELECT 1 FROM json_each(?) expected WHERE NOT EXISTS(SELECT 1 FROM attachment_blob_objects o WHERE o.user_id=? AND o.namespace=? AND o.attachment_id=json_extract(expected.value,'$.id') AND o.storage_key=json_extract(expected.value,'$.key') AND o.bytes=json_extract(expected.value,'$.bytes') AND o.sha256=json_extract(expected.value,'$.sha256')))
      AND NOT EXISTS(SELECT 1 FROM attachment_blob_objects o WHERE o.user_id=? AND o.namespace=? AND (o.verified_at IS NULL OR o.purged_at IS NOT NULL OR o.sha256 IS NULL))
      AND NOT EXISTS(SELECT 1 FROM attachment_upload_attempts a WHERE a.user_id=? AND a.settled_at IS NULL AND (a.storage_key IN(SELECT storage_key FROM attachment_blob_objects WHERE user_id=? AND namespace=?) OR a.attachment_id IN(SELECT attachment_id FROM attachment_blob_objects WHERE user_id=? AND namespace=?)))
      AND NOT EXISTS(SELECT 1 FROM attachment_blob_fences f JOIN attachment_blob_objects o ON f.storage_key=o.storage_key OR (f.user_id=o.user_id AND f.attachment_id=o.attachment_id) WHERE o.user_id=? AND o.namespace=?)`)
      .bind(metadataStage.id, metadataStage.hash, owner, stageId, now, options.targetRevision, owner, metadataStage.id, metadataStage.hash, now, owner, options.targetRevision, owner, namespace, records.size, expectedObjects, owner, namespace, owner, namespace, owner, owner, namespace, owner, namespace, owner, namespace).run();
    if (verified.meta.changes !== 1) throw new Error('Archive staging target changed, expired, or object verification is incomplete.');
    return { stage: metadataStage, archive: { id: stageId, files: records.size, bytes: [...records.values()].reduce((sum, record) => sum + record.expectedBytes, 0), expiresAt, sourceManifestHash } };
  } catch (error) {
    if (reserved) await db.prepare("UPDATE attachment_archive_stages SET status='failed' WHERE user_id=? AND id=? AND status='preparing'").bind(owner, stageId).run();
    if (metadataStage) await discardStagedImport(db, owner, metadataStage.id);
    throw error;
  }
}
