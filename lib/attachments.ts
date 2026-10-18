import type { AttachmentRecord } from './evidence-contract.ts';
import { ATTACHMENT_POLICY, AttachmentPolicyError, readAttachmentStream, validateAttachmentContent, validateAttachmentMetadata } from './attachment-policy.ts';

export interface BlobMetadata { bytes: number; sha256: string; mimeType: string }
export interface StoredBlob { metadata: BlobMetadata; body: ReadableStream<Uint8Array> }
/** put MUST be atomic put-if-absent. Existing keys are immutable, including metadata. */
export interface BlobStore {
  readonly available: boolean;
  put(key: string, bytes: Uint8Array, metadata: BlobMetadata): Promise<'stored' | 'exists'>;
  get(key: string): Promise<StoredBlob | null>;
  head(key: string): Promise<BlobMetadata | null>;
  delete(key: string): Promise<void>;
}
export class AttachmentStorageUnavailableError extends Error {}
export class AttachmentIntegrityError extends Error {}
export class AttachmentReplayMismatchError extends Error {}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
export function attachmentStorageKey(ownerNamespace: string, id: string): string {
  if (!uuid.test(ownerNamespace) || !uuid.test(id)) throw new AttachmentPolicyError('namespace_invalid', 'A registered opaque namespace and attachment UUID are required.');
  return `attachments/${ownerNamespace}/${id}`;
}
function keyCheck(key: string) {
  const parts = key.split('/');
  if (parts.length !== 3 || parts[0] !== 'attachments' || key !== attachmentStorageKey(parts[1], parts[2])) throw new AttachmentIntegrityError('Invalid private attachment key.');
}
function metadataCheck(value: BlobMetadata): void {
  if (!value || !Number.isSafeInteger(value.bytes) || value.bytes < 0 || value.bytes > ATTACHMENT_POLICY.fileBytes || !digest.test(value.sha256) || !ATTACHMENT_POLICY.allowedMime.some(mime => mime === value.mimeType)) throw new AttachmentIntegrityError('Invalid attachment object metadata.');
}
export async function attachmentHash(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource)), byte => byte.toString(16).padStart(2, '0')).join('');
}
/** Structural private R2 subset; declaring this adapter does not provision a binding. */
export interface AttachmentBucket {
  put(key: string, bytes: Uint8Array, options: { onlyIf: { etagDoesNotMatch: string }; httpMetadata: { contentType: string }; customMetadata: { sha256: string } }): Promise<{ size: number } | null>;
  get(key: string): Promise<{ size: number; body: ReadableStream<Uint8Array>; httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> } | null>;
  head(key: string): Promise<{ size: number; httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> } | null>;
  delete(key: string): Promise<void>;
}
export function createR2BlobStore(bucket?: AttachmentBucket | null): BlobStore {
  const required = () => { if (!bucket) throw new AttachmentStorageUnavailableError('Private attachment object storage is unavailable.'); return bucket; };
  const metadata = (object: { size: number; httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): BlobMetadata => {
    const value = { bytes: object.size, sha256: object.customMetadata?.sha256 ?? '', mimeType: object.httpMetadata?.contentType ?? '' };
    metadataCheck(value); return value;
  };
  return {
    available: !!bucket,
    async put(key, bytes, value) {
      keyCheck(key); const immutableMetadata = { ...value }; metadataCheck(immutableMetadata);
      const snapshot = bytes.slice();
      if (snapshot.byteLength !== immutableMetadata.bytes || await attachmentHash(snapshot) !== immutableMetadata.sha256) throw new AttachmentIntegrityError('Upload bytes do not match immutable metadata.');
      return await required().put(key, snapshot, { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: immutableMetadata.mimeType }, customMetadata: { sha256: immutableMetadata.sha256 } }) ? 'stored' : 'exists';
    },
    async get(key) { keyCheck(key); const object = await required().get(key); return object ? { metadata: metadata(object), body: object.body } : null; },
    async head(key) { keyCheck(key); const object = await required().head(key); return object ? metadata(object) : null; },
    async delete(key) { keyCheck(key); await required().delete(key); },
  };
}
export interface AttachmentOwnerOptions {
  /** Required, persisted, server-generated namespace. The root binds it to the authenticated owner. */
  ownerNamespace: string;
  now?: string;
  deadlineMs?: number;
}
function access(ownerId: string, record: AttachmentRecord, options: AttachmentOwnerOptions): string {
  if (typeof ownerId !== 'string' || !ownerId || ownerId.length > 256) throw new Error('Authenticated attachment owner required.');
  if (record.storageKey !== attachmentStorageKey(options.ownerNamespace, record.id)) throw new Error('Attachment is unavailable for this owner namespace.');
  validateAttachmentMetadata(record);
  const now = options.now ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(now)) || !Number.isFinite(Date.parse(record.expiresAt))) throw new Error('Invalid attachment reservation time.');
  return now;
}
export interface AttachmentReservationInput { filename: string; mimeType: string; expectedBytes: number; uploadMutationId: string }
/** A proposal only: the owner ledger and unique upload ID must be asserted atomically by D1. */
export function prepareAttachmentReservation(ownerId: string, input: AttachmentReservationInput, usage: { bytes: number; files: number }, options: AttachmentOwnerOptions & { createId?: () => string }): AttachmentRecord {
  if (!ownerId || ownerId.length > 256) throw new Error('Authenticated attachment owner required.');
  const metadata = validateAttachmentMetadata(input);
  if (!Number.isSafeInteger(usage.bytes) || usage.bytes < 0 || !Number.isSafeInteger(usage.files) || usage.files < 0 || usage.bytes + metadata.expectedBytes > ATTACHMENT_POLICY.ownerBytes || usage.files + 1 > ATTACHMENT_POLICY.ownerFiles) throw new AttachmentPolicyError('owner_quota_exceeded', 'Attachment storage is limited to 200 MiB and 500 ready or staged files.');
  if (typeof input.uploadMutationId !== 'string' || !input.uploadMutationId || input.uploadMutationId.length > 160) throw new Error('Original upload mutation ID required.');
  const now = options.now ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(now))) throw new Error('Invalid reservation time.');
  const id = (options.createId ?? (() => crypto.randomUUID()))();
  return { id, ...metadata, status: 'reserved', actualBytes: null, sha256: null, storageKey: attachmentStorageKey(options.ownerNamespace, id), createdAt: now, expiresAt: new Date(Date.parse(now) + ATTACHMENT_POLICY.reservationMinutes * 60_000).toISOString(), readyAt: null, uploadMutationId: input.uploadMutationId, quarantineReason: null };
}
export interface AttachmentCleanupIntent { attachmentId: string; storageKey: string; sha256: string | null; reason: 'invalid-upload' | 'expired-reservation' | 'owner-delete' }
export type AttachmentStageResult =
  | { status: 'staged'; record: AttachmentRecord; blob: BlobMetadata; replayed: boolean }
  | { status: 'quarantined'; record: AttachmentRecord; cleanup: AttachmentCleanupIntent }
  | { status: 'unavailable'; record: AttachmentRecord; reason: 'storage_unavailable' | 'verification_unavailable' };
function quarantine(record: AttachmentRecord, code: string): AttachmentStageResult {
  return { status: 'quarantined', record: { ...record, status: 'quarantined', readyAt: null, quarantineReason: code }, cleanup: { attachmentId: record.id, storageKey: record.storageKey, sha256: record.sha256, reason: 'invalid-upload' } };
}
function same(left: BlobMetadata, right: BlobMetadata) { return left.bytes === right.bytes && left.sha256 === right.sha256 && left.mimeType === right.mimeType; }
async function verifiedContent(record: AttachmentRecord, store: BlobStore, options: AttachmentOwnerOptions): Promise<{ metadata: BlobMetadata; bytes: Uint8Array }> {
  const head = await store.head(record.storageKey);
  if (!head) throw new AttachmentIntegrityError('Staged attachment is missing.');
  metadataCheck(head);
  if (head.bytes !== record.expectedBytes || head.mimeType !== record.mimeType || record.sha256 !== null && head.sha256 !== record.sha256) throw new AttachmentIntegrityError('Staged attachment metadata changed.');
  const object = await store.get(record.storageKey);
  if (!object || !same(head, object.metadata)) throw new AttachmentIntegrityError('Staged object metadata does not match.');
  const bytes = await readAttachmentStream(object.body, { maxBytes: record.expectedBytes, deadlineMs: options.deadlineMs });
  validateAttachmentContent(bytes, record.mimeType, record.expectedBytes);
  if (await attachmentHash(bytes) !== head.sha256) throw new AttachmentIntegrityError('Staged attachment digest does not match its bytes.');
  return { metadata: head, bytes };
}
async function verifiedBlob(record: AttachmentRecord, store: BlobStore, options: AttachmentOwnerOptions): Promise<BlobMetadata> { return (await verifiedContent(record, store, options)).metadata; }
/** Writes an immutable blob; never changes authoritative metadata or declares D1 finalization. */
export async function stageAttachmentUpload(ownerId: string, record: AttachmentRecord, body: ReadableStream<Uint8Array>, store: BlobStore, options: AttachmentOwnerOptions): Promise<AttachmentStageResult> {
  record = structuredClone(record); options = { ...options };
  const now = access(ownerId, record, options);
  if (record.status !== 'reserved') throw new Error('Only an active reserved attachment can receive an upload.');
  if (Date.parse(now) >= Date.parse(record.expiresAt)) throw new Error('The attachment reservation expired.');
  if (!store.available) { void body.cancel().catch(() => {}); return { status: 'unavailable', record: { ...record }, reason: 'storage_unavailable' }; }
  const bytes = await readAttachmentStream(body, { maxBytes: record.expectedBytes, deadlineMs: options.deadlineMs });
  const hash = await attachmentHash(bytes);
  const expected: BlobMetadata = { bytes: bytes.byteLength, sha256: hash, mimeType: record.mimeType };
  let staged = record;
  try {
    const existing = await store.head(record.storageKey);
    if (existing) {
      if (!same(existing, expected)) throw new AttachmentReplayMismatchError('A different body already occupies this upload reservation.');
      const blob = await verifiedBlob({ ...record, sha256: hash }, store, options);
      return { status: 'staged', record: { ...record, actualBytes: blob.bytes, sha256: blob.sha256 }, blob, replayed: true };
    }
    try { validateAttachmentContent(bytes, record.mimeType, record.expectedBytes); }
    catch (error) { if (error instanceof AttachmentPolicyError) return quarantine(record, error.code); throw error; }
    if (record.sha256 !== null && record.sha256 !== hash) throw new AttachmentReplayMismatchError('Retry the exact original upload body.');
    staged = { ...record, actualBytes: bytes.byteLength, sha256: hash };
    const result = await store.put(record.storageKey, bytes, expected);
    if (result === 'exists') {
      const winner = await store.head(record.storageKey);
      if (!winner || !same(winner, expected)) throw new AttachmentReplayMismatchError('A different concurrent body won this immutable reservation.');
    }
    const blob = await verifiedBlob(staged, store, options);
    return { status: 'staged', record: staged, blob, replayed: result === 'exists' };
  } catch (error) {
    if (error instanceof AttachmentReplayMismatchError) throw error;
    if (error instanceof AttachmentIntegrityError || error instanceof AttachmentPolicyError) return quarantine(staged, 'blob_verification_failed');
    return { status: 'unavailable', record: { ...staged, status: 'reserved', readyAt: null }, reason: 'verification_unavailable' };
  }
}
/** Read-only ready proposal. Root must still CAS reserved status/row revision and quota in D1. */
export async function prepareAttachmentFinalization(ownerId: string, record: AttachmentRecord, store: BlobStore, options: AttachmentOwnerOptions): Promise<AttachmentRecord> {
  record = structuredClone(record); options = { ...options };
  const now = access(ownerId, record, options);
  if (record.status !== 'reserved' || Date.parse(now) >= Date.parse(record.expiresAt)) throw new Error('Attachment reservation is no longer finalizable.');
  const blob = await verifiedBlob(record, store, options);
  return { ...record, status: 'ready', actualBytes: blob.bytes, sha256: blob.sha256, readyAt: now, quarantineReason: null };
}
/** Returns validated ready bytes only; authenticated owner-to-namespace binding stays with the route. */
export async function readReadyAttachment(ownerId: string, record: AttachmentRecord, store: BlobStore, options: AttachmentOwnerOptions): Promise<{ metadata: BlobMetadata; bytes: Uint8Array }> {
  record = structuredClone(record); options = { ...options };
  access(ownerId, record, options);
  if (record.status !== 'ready' || record.actualBytes !== record.expectedBytes || !record.sha256 || !record.readyAt || !Number.isFinite(Date.parse(record.readyAt))) throw new Error('Only a verified ready attachment can be downloaded.');
  return verifiedContent(record, store, options);
}
/** Metadata/job proposal only. The deletion job must recheck deleted/quarantined status and all live/backup references. */
export function prepareAttachmentRetirement(ownerId: string, record: AttachmentRecord, references: readonly string[], options: AttachmentOwnerOptions, reason: 'expired-reservation' | 'owner-delete'): { record: AttachmentRecord; cleanup: AttachmentCleanupIntent } {
  record = structuredClone(record); options = { ...options };
  const now = access(ownerId, record, options);
  if (!['expired-reservation', 'owner-delete'].includes(reason)) throw new Error('Invalid attachment retirement reason.');
  if (references.length) throw new Error('Retained evidence, acceptance or backup records still reference this attachment.');
  if (record.status === 'deleted') throw new Error('Attachment is already deleted.');
  if (reason === 'expired-reservation' && (record.status === 'ready' || Date.parse(now) < Date.parse(record.expiresAt))) throw new Error('Only an expired unfinalized reservation can be cleaned up.');
  return { record: { ...record, status: 'deleted' }, cleanup: { attachmentId: record.id, storageKey: record.storageKey, sha256: record.sha256, reason } };
}
