/** Native portable archive v1: stored ZIP only. Yielded entries are staging data,
 * never import authority: callers must exhaust the iterator successfully before
 * accepting them, and discard staged data if a later directory check fails. */
export interface ArchiveEntry { path: string; bytes: Uint8Array }
const MANIFEST_LIMIT = 8_000_000;
const FILE_LIMIT = 20 * 1024 * 1024;
const TOTAL_LIMIT = 200 * 1024 * 1024;
const DIRECTORY_LIMIT = 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
function fail(message: string): never { throw new Error(`Invalid native attachment archive: ${message}`); }
function pathLimit(path: string): number {
  if (path === 'manifest.json') return MANIFEST_LIMIT;
  if (/^attachments\/[a-f0-9]{64}$/.test(path)) return FILE_LIMIT;
  return fail('unsupported member path');
}
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function header(length: number): { bytes: Uint8Array; view: DataView } {
  const bytes = new Uint8Array(length);
  return { bytes, view: new DataView(bytes.buffer) };
}
interface Metadata { path: string; crc: number; size: number; offset: number; time: number; date: number }
function tracker() {
  const paths = new Set<string>();
  let total = 0;
  return {
    add(path: string, size: number) {
      const limit = pathLimit(path);
      if (paths.has(path)) fail('duplicate member');
      if (paths.size >= 501 || size > limit) fail('entry count or size limit exceeded');
      paths.add(path);
      if (path !== 'manifest.json') total += size;
      if (total > TOTAL_LIMIT) fail('attachment total limit exceeded');
    },
    finish() { if (!paths.has('manifest.json')) fail('manifest.json is required'); },
  };
}
/** Emits standard ZIP local records, central directory and EOCD without compression. */
export function writeStoredArchive(entries: AsyncIterable<ArchiveEntry> | Iterable<ArchiveEntry>): ReadableStream<Uint8Array> {
  async function* encode() {
    const seen = tracker();
    const records: Metadata[] = [];
    let offset = 0;
    for await (const entry of entries) {
      if (!(entry.bytes instanceof Uint8Array)) fail('entry bytes must be Uint8Array');
      seen.add(entry.path, entry.bytes.byteLength);
      // Snapshot the entry: caller mutation cannot make directory CRC inconsistent.
      const bytes = entry.bytes.slice();
      const name = encoder.encode(entry.path);
      const crc = crc32(bytes);
      const h = header(30 + name.length);
      h.view.setUint32(0, 0x04034b50, true); h.view.setUint16(4, 20, true);
      h.view.setUint16(6, 0x800, true); h.view.setUint16(12, 0x21, true);
      h.view.setUint32(14, crc, true); h.view.setUint32(18, bytes.length, true); h.view.setUint32(22, bytes.length, true);
      h.view.setUint16(26, name.length, true); h.bytes.set(name, 30);
      records.push({ path: entry.path, crc, size: bytes.length, offset, time: 0, date: 0x21 });
      offset += h.bytes.length + bytes.length;
      yield h.bytes; yield bytes;
    }
    seen.finish();
    const start = offset;
    for (const record of records) {
      const name = encoder.encode(record.path);
      const h = header(46 + name.length);
      h.view.setUint32(0, 0x02014b50, true); h.view.setUint16(4, 20, true); h.view.setUint16(6, 20, true);
      h.view.setUint16(8, 0x800, true); h.view.setUint16(14, record.date, true);
      h.view.setUint32(16, record.crc, true); h.view.setUint32(20, record.size, true); h.view.setUint32(24, record.size, true);
      h.view.setUint16(28, name.length, true); h.view.setUint32(42, record.offset, true); h.bytes.set(name, 46);
      offset += h.bytes.length; yield h.bytes;
    }
    const end = header(22);
    end.view.setUint32(0, 0x06054b50, true); end.view.setUint16(8, records.length, true); end.view.setUint16(10, records.length, true);
    end.view.setUint32(12, offset - start, true); end.view.setUint32(16, start, true);
    yield end.bytes;
  }
  const iterator = encode();
  return new ReadableStream({
    async pull(controller) {
      try { const next = await iterator.next(); if (next.done) controller.close(); else controller.enqueue(next.value); }
      catch (error) { controller.error(error); await iterator.return(undefined); }
    },
    async cancel() { await iterator.return(undefined); },
  });
}

/** Bounded payload buffering; complete validation requires successful exhaustion. */
export async function* readStoredArchive(stream: ReadableStream<Uint8Array>): AsyncGenerator<ArchiveEntry> {
  const reader = stream.getReader();
  let chunk: Uint8Array = new Uint8Array(0);
  let position = 0, offset = 0, done = false;
  async function read(length: number): Promise<Uint8Array> {
    const result = new Uint8Array(length);
    let written = 0;
    while (written < length) {
      if (position === chunk.length) {
        const next = await reader.read();
        if (next.done) { done = true; fail('truncated archive'); }
        if (!(next.value instanceof Uint8Array)) fail('invalid stream chunk');
        chunk = next.value; position = 0;
        if (!chunk.length) continue;
      }
      const count = Math.min(length - written, chunk.length - position);
      result.set(chunk.subarray(position, position + count), written);
      written += count; position += count; offset += count;
    }
    return result;
  }
  const u16 = (v: DataView, at: number) => v.getUint16(at, true);
  const u32 = (v: DataView, at: number) => v.getUint32(at, true);
  const seen = tracker(), records: Metadata[] = [];
  try {
    let signature = new DataView((await read(4)).buffer).getUint32(0, true);
    while (signature === 0x04034b50) {
      const start = offset - 4;
      const h = new DataView((await read(26)).buffer);
      const size = u32(h, 18), nameLength = u16(h, 22);
      if (![10, 20].includes(u16(h, 0)) || u16(h, 2) !== 0x800 || u16(h, 4) !== 0 || u16(h, 24) !== 0) fail('unsupported local ZIP features');
      if (size === 0xffffffff || u32(h, 14) !== size || nameLength > 76 || nameLength === 0) fail('invalid local lengths');
      const path = decoder.decode(await read(nameLength));
      seen.add(path, size);
      const bytes = await read(size), crc = u32(h, 10);
      if (crc32(bytes) !== crc) fail('CRC32 mismatch');
      records.push({ path, size, crc, offset: start, time: u16(h, 6), date: u16(h, 8) });
      yield { path, bytes };
      signature = new DataView((await read(4)).buffer).getUint32(0, true);
    }
    seen.finish();
    const directoryStart = offset - 4;
    let index = 0;
    while (signature === 0x02014b50) {
      if (index >= records.length || offset - directoryStart > DIRECTORY_LIMIT) fail('central directory limit or count mismatch');
      const h = new DataView((await read(42)).buffer);
      const record = records[index++], nameLength = u16(h, 24);
      if (![10, 20].includes(u16(h, 2)) || u16(h, 4) !== 0x800 || u16(h, 6) !== 0 || u16(h, 26) !== 0 || u16(h, 28) !== 0 || u16(h, 30) !== 0 || u16(h, 32) !== 0 || u32(h, 34) !== 0) fail('unsupported central ZIP features');
      if (nameLength > 76 || nameLength === 0) fail('invalid central name');
      const path = decoder.decode(await read(nameLength));
      if (path !== record.path || u32(h, 12) !== record.crc || u32(h, 16) !== record.size || u32(h, 20) !== record.size || u32(h, 38) !== record.offset || u16(h, 8) !== record.time || u16(h, 10) !== record.date) fail('central/local metadata mismatch');
      if (offset - directoryStart > DIRECTORY_LIMIT) fail('central directory limit exceeded');
      signature = new DataView((await read(4)).buffer).getUint32(0, true);
    }
    if (signature !== 0x06054b50 || index !== records.length) fail('missing central directory or EOCD');
    const directorySize = offset - 4 - directoryStart;
    const end = new DataView((await read(18)).buffer);
    if (u16(end, 0) !== 0 || u16(end, 2) !== 0 || u16(end, 4) !== records.length || u16(end, 6) !== records.length || u32(end, 8) !== directorySize || u32(end, 12) !== directoryStart || u16(end, 16) !== 0) fail('invalid EOCD');
    if (position < chunk.length) fail('trailing data');
    while (!done) {
      const next = await reader.read();
      if (next.done) done = true;
      else if (!(next.value instanceof Uint8Array) || next.value.length) fail('trailing data');
    }
  } finally { try { await reader.cancel(); } finally { reader.releaseLock(); } }
}
