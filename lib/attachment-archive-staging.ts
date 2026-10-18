import {privateCapacityGuard,privateRowGrowth} from './private-capacity.ts';
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
import { attachmentPriorGenerationSql } from './attachment-generation.ts';
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
  const priorGeneration = attachmentPriorGenerationSql({ owner: 'o.user_id', attachmentId: 'o.attachment_id', storageKey: 'o.storage_key', bytes: 'o.bytes', sha256: 'o.sha256' });
  let reserved = false, sourceManifestHash = '', metadataStage: ImportStage | undefined;
  try {
    const result = await inspectAttachmentArchive(stream, async (id, bytes, digest) => {
      const record = records.get(id);
      if (!record || record.sha256 !== digest) throw new Error('Unreserved archive attachment.');
      validateAttachmentContent(bytes, record.mimeType, record.expectedBytes);
      if (await contentHash(bytes) !== digest) throw new Error('Archive attachment digest differs.');
      const key = record.storageKey, token = crypto.randomUUID(), now = options.now();
      const attemptCapacity=await privateCapacityGuard(db,owner,{growth:[privateRowGrowth('attachment_upload_attempts',null,{token,attachment_id:id,storage_key:key,created_at:now,settled_at:null})]});
      const attempt = await db.prepare(`INSERT INTO attachment_upload_attempts(user_id,token,attachment_id,storage_key,created_at,settled_at)
        SELECT ?,?,?,?,?,NULL WHERE EXISTS(SELECT 1 FROM attachment_archive_stages s JOIN attachment_blob_objects o ON o.user_id=s.user_id AND o.namespace=s.namespace JOIN attachment_blob_namespaces n ON n.user_id=s.user_id AND n.namespace=s.namespace
        WHERE s.user_id=? AND s.id=? AND s.status='preparing' AND s.expires_at>? AND o.storage_key=? AND o.attachment_id=? AND o.bytes=? AND o.sha256=? AND o.verified_at IS NULL AND o.purged_at IS NULL AND n.purpose='archive-stage' AND n.source_import_id IS NULL AND o.storage_key='attachments/'||s.namespace||'/'||o.attachment_id AND ${priorGeneration})
        AND NOT EXISTS(SELECT 1 FROM attachment_archive_cleanup_claims WHERE storage_key=?) AND NOT EXISTS(SELECT 1 FROM attachment_blob_fences WHERE storage_key=?)
        AND NOT EXISTS(SELECT 1 FROM attachment_upload_attempts WHERE user_id=? AND storage_key=? AND settled_at IS NULL) AND (${attemptCapacity.sql})`)
        .bind(owner, token, id, key, now, owner, stageId, now, key, id, bytes.length, digest, key, key, owner, key,...attemptCapacity.bindings).run();
      if (attempt.meta.changes !== 1) throw new Error('Archive upload reservation is unavailable or fenced.');
      // A rejecting PUT may have outlived its request: retain its pending token.
      await options.store.put(key, bytes, { bytes: bytes.length, sha256: digest, mimeType: record.mimeType });
      if (!await finishUpload(db, owner, { token, now: options.now(), definitivelySettled: true })) throw new Error('Archive upload settlement failed.');
      await readReadyAttachment(owner, record, options.store, { ownerNamespace: namespace, now: options.now() });
      const verifiedAt=options.now(),objectBefore={storage_key:key,attachment_id:id,namespace,bytes:bytes.length,sha256:digest,created_at:createdAt,verified_at:null,purged_at:null};
      const verifiedCapacity=await privateCapacityGuard(db,owner,{growth:[privateRowGrowth('attachment_blob_objects',objectBefore,{...objectBefore,verified_at:verifiedAt})]});
      const verified = await db.prepare(`UPDATE attachment_blob_objects AS o SET verified_at=? WHERE user_id=? AND storage_key=? AND namespace=? AND attachment_id=? AND bytes=? AND sha256=? AND purged_at IS NULL AND verified_at IS NULL
        AND ${priorGeneration}
        AND EXISTS(SELECT 1 FROM attachment_archive_stages s JOIN attachment_blob_namespaces n ON n.user_id=s.user_id AND n.namespace=s.namespace WHERE s.user_id=? AND s.id=? AND s.namespace=o.namespace AND s.status='preparing' AND s.expires_at>? AND n.purpose='archive-stage' AND n.source_import_id IS NULL)
        AND NOT EXISTS(SELECT 1 FROM attachment_archive_cleanup_claims WHERE storage_key=?) AND NOT EXISTS(SELECT 1 FROM attachment_blob_fences WHERE storage_key=?) AND (${verifiedCapacity.sql})`)
        .bind(verifiedAt, owner, key, namespace, id, bytes.length, digest, owner, stageId, options.now(), key, key,...verifiedCapacity.bindings).run();
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
    const verifiedStatement = db.prepare(`UPDATE attachment_archive_stages SET status='verified',import_id=?,import_hash=? WHERE user_id=? AND id=? AND status='preparing' AND expires_at>? AND target_revision=?
      AND EXISTS(SELECT 1 FROM attachment_blob_namespaces WHERE user_id=? AND namespace=? AND purpose='archive-stage' AND source_import_id IS NULL)
      AND EXISTS(SELECT 1 FROM workspace_imports WHERE user_id=? AND id=? AND content_hash=? AND expires_at>?)
      AND EXISTS(SELECT 1 FROM workspaces WHERE user_id=? AND revision=?)
      AND (SELECT COUNT(*) FROM attachment_blob_objects WHERE user_id=? AND namespace=?)=?
      AND NOT EXISTS(SELECT 1 FROM json_each(?) expected WHERE NOT EXISTS(SELECT 1 FROM attachment_blob_objects o WHERE o.user_id=? AND o.namespace=? AND o.attachment_id=json_extract(expected.value,'$.id') AND o.storage_key=json_extract(expected.value,'$.key') AND o.bytes=json_extract(expected.value,'$.bytes') AND o.sha256=json_extract(expected.value,'$.sha256')))
      AND NOT EXISTS(SELECT 1 FROM attachment_blob_objects o WHERE o.user_id=? AND o.namespace=? AND (o.verified_at IS NULL OR o.purged_at IS NOT NULL OR o.sha256 IS NULL))
      AND NOT EXISTS(SELECT 1 FROM attachment_upload_attempts a WHERE a.user_id=? AND a.settled_at IS NULL AND (a.storage_key IN(SELECT storage_key FROM attachment_blob_objects WHERE user_id=? AND namespace=?) OR a.attachment_id IN(SELECT attachment_id FROM attachment_blob_objects WHERE user_id=? AND namespace=?)))
      AND NOT EXISTS(SELECT 1 FROM attachment_blob_objects o WHERE o.user_id=? AND o.namespace=? AND NOT ${priorGeneration})
      AND NOT EXISTS(SELECT 1 FROM attachment_blob_fences f JOIN attachment_blob_objects o ON f.storage_key=o.storage_key WHERE o.user_id=? AND o.namespace=?)
      AND NOT EXISTS(SELECT 1 FROM attachment_archive_cleanup_claims c JOIN attachment_blob_objects o ON o.storage_key=c.storage_key WHERE o.user_id=? AND o.namespace=?)`)
      .bind(metadataStage.id, metadataStage.hash, owner, stageId, now, options.targetRevision, owner, namespace, owner, metadataStage.id, metadataStage.hash, now, owner, options.targetRevision, owner, namespace, records.size, expectedObjects, owner, namespace, owner, namespace, owner, owner, namespace, owner, namespace, owner, namespace, owner, namespace, owner, namespace);
    const namespaceBefore={namespace,created_at:createdAt,purpose:'archive-stage',source_import_id:null};
    const namespaceCapacity=await privateCapacityGuard(db,owner,{growth:[privateRowGrowth('attachment_blob_namespaces',namespaceBefore,{...namespaceBefore,source_import_id:metadataStage.id})]});
    const assertionId = `archive-verified-${crypto.randomUUID()}`;
    const verified = await db.batch([verifiedStatement,
      db.prepare("UPDATE attachment_blob_namespaces SET source_import_id=? WHERE user_id=? AND namespace=? AND purpose='archive-stage' AND source_import_id IS NULL AND EXISTS(SELECT 1 FROM attachment_archive_stages WHERE user_id=? AND id=? AND status='verified' AND import_id=? AND import_hash=?) AND ("+namespaceCapacity.sql+")").bind(metadataStage.id, owner, namespace, owner, stageId, metadataStage.id, metadataStage.hash,...namespaceCapacity.bindings),
      db.prepare("INSERT INTO workspace_assertions(user_id,mutation_id,valid) SELECT ?,?,CASE WHEN EXISTS(SELECT 1 FROM attachment_archive_stages s JOIN attachment_blob_namespaces n ON n.user_id=s.user_id AND n.namespace=s.namespace WHERE s.user_id=? AND s.id=? AND s.status='verified' AND s.import_id=? AND s.import_hash=? AND n.source_import_id=s.import_id) THEN 1 ELSE 0 END").bind(owner, assertionId, owner, stageId, metadataStage.id, metadataStage.hash),
      db.prepare('DELETE FROM workspace_assertions WHERE user_id=? AND mutation_id=?').bind(owner, assertionId),
    ]).catch(cause => { throw new Error('Archive staging target changed, expired, or object verification is incomplete.', { cause }); });
    if (verified[0].meta.changes !== 1) throw new Error('Archive staging target changed, expired, or object verification is incomplete.');
    return { stage: metadataStage, archive: { id: stageId, files: records.size, bytes: [...records.values()].reduce((sum, record) => sum + record.expectedBytes, 0), expiresAt, sourceManifestHash } };
  } catch (error) {
    if (reserved) await db.prepare("UPDATE attachment_archive_stages SET status='failed' WHERE user_id=? AND id=? AND status='preparing'").bind(owner, stageId).run();
    if (metadataStage) await discardStagedImport(db, owner, metadataStage.id);
    throw error;
  }
}
