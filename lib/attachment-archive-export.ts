import type { AttachmentRecord } from './evidence-contract.ts';
import type { WorkspaceBundle } from './workspace-export.ts';
import { inspectAttachmentManifest, validateAttachmentManifest } from './attachment-manifest.ts';
import { attachmentRecordSchema } from './evidence-module.ts';
import { canonical, contentHash } from './canonical-json.ts';
import { writeStoredArchive } from './attachment-archive.ts';

/** The byte resolver must enforce owner/storage access itself. Logical IDs, never
 * imported storage keys, are passed to it. Returned bytes are independently hashed. */
export type VerifiedAttachmentReader = (id: string) => Promise<Uint8Array>;
export async function attachmentArchivePath(originalId: string): Promise<string> {
  return `attachments/${await contentHash(originalId)}`;
}
/** Snapshot a frozen export, then stream a provisional manifest followed by verified files.
 * A late read/integrity failure errors the stream before ZIP directory/EOCD, so
 * the incomplete download cannot be accepted as a valid native archive.
 * This is a serializer, not bundle/reference validation or storage authorization. */
export function writeAttachmentArchive(
  bundle: WorkspaceBundle,
  readyRecords: readonly AttachmentRecord[],
  readVerifiedBytes: VerifiedAttachmentReader,
): ReadableStream<Uint8Array> {
  const snapshot = structuredClone(bundle);
  const records = structuredClone(readyRecords);
  async function* entries() {
    const inspection = inspectAttachmentManifest(snapshot.modules);
    if (inspection.unresolvedLegacy) throw new Error('Complete archive requires resolved typed attachment metadata.');
    validateAttachmentManifest(snapshot.attachments, snapshot.modules);
    const supplied = new Map<string, AttachmentRecord>();
    for (const value of records) {
      const record = attachmentRecordSchema.parse(value);
      if (record.status !== 'ready' || supplied.has(record.id)) throw new Error('Expected unique ready attachment records.');
      supplied.set(record.id, record);
    }
    if (supplied.size !== inspection.entries.length) throw new Error('Ready attachment records differ from frozen bundle.');
    // Exact comparison binds even fields outside the portable manifest, without
    // ever using a storage key as authority to read an object.
    const moduleRecords = snapshot.modules.attachments?.records ?? [];
    for (const row of moduleRecords) {
      const wrapper = row as { id: string; value: unknown };
      const record = supplied.get(wrapper.id);
      if (record && canonical(wrapper.value) !== canonical(record)) throw new Error('Ready attachment metadata differs from frozen bundle.');
    }
    const included: WorkspaceBundle['attachments'] = [];
    for (const metadata of inspection.entries) included.push({ ...metadata, archivePath: await attachmentArchivePath(metadata.id), availability: 'included' });
    // Claims are provisional until the complete ZIP is validated by its reader.
    const manifest: WorkspaceBundle = { ...snapshot, attachments: included, completeness: 'complete' };
    yield { path: 'manifest.json', bytes: new TextEncoder().encode(JSON.stringify(manifest)) };
    for (const metadata of inspection.entries) {
      const record = supplied.get(metadata.id);
      if (!record || record.actualBytes !== metadata.bytes || record.sha256 !== metadata.sha256) throw new Error('Ready attachment metadata differs from manifest.');
      const received = await readVerifiedBytes(metadata.id);
      if (!(received instanceof Uint8Array) || received.byteLength !== metadata.bytes) throw new Error('Attachment byte length differs from frozen metadata.');
      const bytes = received.slice();
      if (await contentHash(bytes) !== metadata.sha256) throw new Error('Attachment digest differs from frozen metadata.');
      const path = await attachmentArchivePath(metadata.id);
      yield { path, bytes };
    }
  }
  return writeStoredArchive(entries());
}
