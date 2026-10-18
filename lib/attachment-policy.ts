export const ATTACHMENT_POLICY = Object.freeze({
  fileBytes: 20 * 1024 * 1024, ownerBytes: 200 * 1024 * 1024, ownerFiles: 500,
  reservationMinutes: 30,
  allowedMime: ['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'text/plain', 'text/csv', 'application/json'] as const,
});
export type AttachmentMime = typeof ATTACHMENT_POLICY.allowedMime[number];
export class AttachmentPolicyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
const extensions: Record<AttachmentMime, readonly string[]> = {
  'application/pdf': ['pdf'], 'image/png': ['png'], 'image/jpeg': ['jpg', 'jpeg'], 'image/webp': ['webp'],
  'text/plain': ['txt', 'log', 'md'], 'text/csv': ['csv'], 'application/json': ['json'],
};
export function normalizeAttachmentMime(value: string): AttachmentMime {
  if (typeof value !== 'string') throw new AttachmentPolicyError('mime_invalid', 'Choose a supported file type.');
  const mime = value.toLowerCase();
  if (!(ATTACHMENT_POLICY.allowedMime as readonly string[]).includes(mime)) throw new AttachmentPolicyError('mime_invalid', 'Choose PDF, PNG, JPEG, WebP, UTF-8 text, CSV or JSON.');
  return mime as AttachmentMime;
}
export function validateAttachmentMetadata(value: { filename: string; mimeType: string; expectedBytes: number }): { filename: string; mimeType: AttachmentMime; expectedBytes: number } {
  const mimeType = normalizeAttachmentMime(value.mimeType);
  const filename = value.filename;
  if (typeof filename !== 'string' || !filename || filename !== filename.trim() || filename.startsWith('.') || filename.endsWith('.') || new TextDecoder().decode(new TextEncoder().encode(filename)) !== filename || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(filename) || new TextEncoder().encode(filename).byteLength > 240 || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069/\\<>:"|?*]/u.test(filename) || /\.(?:exe|dll|com|bat|cmd|ps1|sh|msi|scr|js|mjs|cjs|vbs|jar|html?|xhtml|svg)(?:\.|$)/i.test(filename)) throw new AttachmentPolicyError('filename_invalid', 'Use a plain filename without paths, controls or executable extensions.');
  const extension = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
  if (!extensions[mimeType].includes(extension) || !filename.includes('.')) throw new AttachmentPolicyError('filename_mime_mismatch', 'The filename extension must match the selected file type.');
  if (!Number.isSafeInteger(value.expectedBytes) || value.expectedBytes < 0 || value.expectedBytes > ATTACHMENT_POLICY.fileBytes) throw new AttachmentPolicyError('file_too_large', 'Each file must be no larger than 20 MiB.');
  return { filename, mimeType, expectedBytes: value.expectedBytes };
}
export function hasExpectedSignature(bytes: Uint8Array, mime: string): boolean {
  const starts = (...prefix: number[]) => prefix.every((byte, index) => bytes[index] === byte);
  if (mime === 'application/pdf') return starts(0x25, 0x50, 0x44, 0x46, 0x2d);
  if (mime === 'image/png') return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  if (mime === 'image/jpeg') return starts(0xff, 0xd8, 0xff);
  if (mime === 'image/webp') return bytes.length >= 12 && starts(0x52, 0x49, 0x46, 0x46) && [0x57, 0x45, 0x42, 0x50].every((byte, index) => bytes[index + 8] === byte);
  if (!['text/plain', 'text/csv', 'application/json'].includes(mime)) return false;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) return false;
    const beginning = text.trimStart();
    if (/^(?:#!|<!--|<\?xml\b|<!doctype\b|<\/?[a-z][a-z0-9]*(?:\s|>|\/))/i.test(beginning)) return false;
    if (mime === 'application/json') {
      const visit = (value: unknown, depth = 0): boolean => depth <= 40 && (typeof value === 'number' ? Number.isFinite(value) : Array.isArray(value) ? value.every(item => visit(item, depth + 1)) : value !== null && typeof value === 'object' ? Object.values(value).every(item => visit(item, depth + 1)) : true);
      return visit(JSON.parse(text));
    }
    return true;
  } catch { return false; }
}
export function validateAttachmentContent(bytes: Uint8Array, mimeType: string, expectedBytes: number): void {
  const normalized = normalizeAttachmentMime(mimeType);
  if (!(bytes instanceof Uint8Array) || !Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > ATTACHMENT_POLICY.fileBytes || bytes.byteLength !== expectedBytes) throw new AttachmentPolicyError('length_mismatch', 'The uploaded length does not match its reservation.');
  if (!hasExpectedSignature(bytes, normalized)) throw new AttachmentPolicyError('signature_mismatch', 'The actual file content does not match its permitted type.');
}
/** One deadline covers all reads. Oversize/deadline cancellation never waits on a hostile cancel promise. */
export async function readAttachmentStream(stream: ReadableStream<Uint8Array>, options: { maxBytes?: number; deadlineMs?: number } = {}): Promise<Uint8Array> {
  const limit = options.maxBytes ?? ATTACHMENT_POLICY.fileBytes;
  const deadline = options.deadlineMs ?? 30_000;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > ATTACHMENT_POLICY.fileBytes || !Number.isFinite(deadline) || deadline <= 0) throw new AttachmentPolicyError('read_bound_invalid', 'Invalid attachment read limit.');
  const reader = stream.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new AttachmentPolicyError('upload_timeout', 'The attachment upload timed out. Its reservation is retained.')); cancel(); }, deadline); });
  try {
    const chunks: Uint8Array[] = []; let length = 0;
    for (;;) {
      const item = await Promise.race([reader.read(), timeout]);
      if (item.done) break;
      if (!(item.value instanceof Uint8Array)) { cancel(); throw new AttachmentPolicyError('stream_invalid', 'Attachment streams must contain bytes.'); }
      if (item.value.byteLength > limit - length) { cancel(); throw new AttachmentPolicyError('file_too_large', 'The uploaded file exceeds its reserved size.'); }
      length += item.value.byteLength; chunks.push(item.value.slice());
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } catch (error) { cancel(); throw error; }
  finally { clearTimeout(timer); reader.releaseLock(); }
}

/** Call only after owner/ready/content checks. Never redirects to a bucket URL. */
export function attachmentDownloadHeaders(filename: string, mimeType: string, inlineRaster = false): Record<string, string> {
  const metadata = validateAttachmentMetadata({ filename, mimeType, expectedBytes: 0 });
  const fallback = filename.normalize('NFKD').replace(/[^a-zA-Z0-9._ -]/g, '_');
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  const disposition = inlineRaster && ['image/png', 'image/jpeg', 'image/webp'].includes(metadata.mimeType) ? 'inline' : 'attachment';
  return { 'Content-Type': metadata.mimeType, 'Content-Disposition': `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
}
