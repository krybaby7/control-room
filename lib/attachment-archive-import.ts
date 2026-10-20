import { z } from 'zod';
import { readStoredArchive } from './attachment-archive.ts';
import { attachmentArchivePath } from './attachment-archive-export.ts';
import { inspectAttachmentManifest, attachmentManifestEntrySchema } from './attachment-manifest.ts';
import { parseWorkspaceBundle, type WorkspaceBundle } from './workspace-export.ts';
import { contentHash } from './canonical-json.ts';

export interface ArchiveStagingAttempt { id: string; path: string; sha256: string; status: 'attempted' | 'staged' }
/** Includes attempted writes: a rejecting callback might already have written data.
 * Cleanup must use its own isolated staging namespace, never imported storage keys. */
export class AttachmentArchiveImportError extends Error {
  readonly staging: readonly ArchiveStagingAttempt[];
  constructor(cause: unknown, staging: readonly ArchiveStagingAttempt[]) {
    super(cause instanceof Error ? cause.message : 'Native archive inspection failed.', { cause });
    this.name = 'AttachmentArchiveImportError';
    this.staging = staging.map(value => ({ ...value }));
  }
}
export interface AttachmentArchiveInspection {
  /** Exact manifest JSON structure, with original included claims retained. */
  manifest: WorkspaceBundle;
  /** Separately parsed metadata-only copy; carries no imported byte authority. */
  metadataBundle: WorkspaceBundle;
  staged: readonly ArchiveStagingAttempt[];
}
export type AttachmentArchiveStage = (id: string, bytes: Uint8Array, expectedDigest: string) => Promise<void>;
export interface AttachmentArchiveImportOptions {
  /** Provisional reservation hook, called after strict validation and before any
   * byte staging. Receives isolated copies and conveys no completed import authority. */
  onManifest?: (manifest: WorkspaceBundle, metadataBundle: WorkspaceBundle) => Promise<void>;
}
const includedSchema = attachmentManifestEntrySchema.innerType().extend({
  archivePath: z.string().regex(/^attachments\/[a-f0-9]{64}$/),
  availability: z.literal('included'),
}).strict();

/** Stage callbacks are provisional. Only successful completion of this promise
 * proves ZIP exhaustion, manifest consistency and every byte digest. It does not
 * accept imports, authorize owner writes, or commit D1/storage metadata. */
export async function inspectAttachmentArchive(
  stream: ReadableStream<Uint8Array>,
  stage: AttachmentArchiveStage,
  options: AttachmentArchiveImportOptions = {},
): Promise<AttachmentArchiveInspection> {
  const staging: ArchiveStagingAttempt[] = [];
  try {
    let manifest: WorkspaceBundle | undefined;
    let metadataBundle: WorkspaceBundle | undefined;
    const expected = new Map<string, WorkspaceBundle['attachments'][number]>();
    const observed = new Set<string>();
    for await (const entry of readStoredArchive(stream)) {
      if (!manifest) {
        if (entry.path !== 'manifest.json') throw new Error('Native archive manifest must be first.');
        const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(entry.bytes));
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid native archive manifest.');
        const original = raw as WorkspaceBundle;
        if (original.completeness !== 'complete') throw new Error('Native archive requires a complete provisional manifest.');
        const claims = z.array(includedSchema).max(500).parse(original.attachments);
        const inspection = inspectAttachmentManifest(original.modules);
        if (inspection.unresolvedLegacy) throw new Error('Native archive contains unresolved legacy attachment metadata.');
        if (claims.length !== inspection.entries.length) throw new Error('Native archive attachment claims omit or invent ready metadata.');
        const ids = new Set<string>();
        for (const claim of claims) {
          if (ids.has(claim.id)) throw new Error('Duplicate attachment manifest ID.');
          ids.add(claim.id);
          if (claim.archivePath !== await attachmentArchivePath(claim.id)) throw new Error('Attachment archive path differs from logical identity.');
          expected.set(claim.archivePath, claim);
        }
        const metadataOnly = structuredClone(original);
        metadataOnly.attachments = claims.map(claim => ({ ...claim, archivePath: null, availability: 'excluded' }));
        metadataOnly.completeness = 'metadata-only';
        // Shared parser performs exact metadata comparison and every registered
        // module/schema/reference check on this copy, never altering original.
        metadataBundle = parseWorkspaceBundle(metadataOnly);
        manifest = original;
        await options.onManifest?.(structuredClone(manifest), structuredClone(metadataBundle));
        continue;
      }
      if (entry.path === 'manifest.json') throw new Error('Native archive has multiple manifests.');
      const claim = expected.get(entry.path);
      if (!claim || observed.has(entry.path)) throw new Error('Unexpected or duplicate attachment member.');
      if (entry.bytes.length !== claim.bytes || await contentHash(entry.bytes) !== claim.sha256) throw new Error('Attachment bytes differ from manifest digest or length.');
      observed.add(entry.path);
      const attempt: ArchiveStagingAttempt = { id: claim.id, path: entry.path, sha256: claim.sha256, status: 'attempted' };
      staging.push(attempt);
      await stage(claim.id, entry.bytes, claim.sha256);
      attempt.status = 'staged';
    }
    if (!manifest || !metadataBundle || observed.size !== expected.size) throw new Error('Native archive is missing declared attachment members.');
    return { manifest, metadataBundle, staged: staging.map(value => ({ ...value })) };
  } catch (error) { throw new AttachmentArchiveImportError(error, staging); }
}
