import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { readStoredArchive, writeStoredArchive } from '../lib/attachment-archive.ts';
const path = `attachments/${'a'.repeat(64)}`;
const entries = [{ path: 'manifest.json', bytes: new TextEncoder().encode('{"version":1}') }, { path, bytes: new Uint8Array([1, 2, 3, 255]) }];
async function archive(input = entries) { return new Uint8Array(await new Response(writeStoredArchive(input)).arrayBuffer()); }
function stream(bytes: Uint8Array, chunkSize = 7) {
  let offset = 0;
  return new ReadableStream<Uint8Array>({ pull(c) { if (offset === bytes.length) c.close(); else { c.enqueue(bytes.subarray(offset, offset + chunkSize)); offset = Math.min(bytes.length, offset + chunkSize); } } });
}
async function decode(bytes: Uint8Array) { const result = []; for await (const entry of readStoredArchive(stream(bytes))) result.push(entry); return result; }
function location(bytes: Uint8Array, signature: number) { const v = new DataView(bytes.buffer); for (let i = 0; i <= bytes.length - 4; i++) if (v.getUint32(i, true) === signature) return i; throw new Error('signature missing'); }
test('stored archive roundtrip across small stream chunks and standard Python ZIP reader', async () => {
  const bytes = await archive();
  assert.deepEqual(await decode(bytes), entries);
  const python = spawnSync('python3', ['-c', 'import sys,zipfile,io,json; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); assert z.testzip() is None; print(json.dumps([(x.filename,x.compress_type,x.flag_bits) for x in z.infolist()]))'], { input: bytes, encoding: 'utf8' });
  assert.equal(python.status, 0, python.stderr);
  assert.deepEqual(JSON.parse(python.stdout), entries.map(x => [x.path, 0, 2048]));
});
test('writer rejects duplicate, missing manifest, invalid paths, and overlarge entries', async () => {
  for (const input of [[entries[0], entries[0]], [entries[1]], [{ path: '../manifest.json', bytes: new Uint8Array() }], [{ path: 'manifest.json', bytes: new Uint8Array(8_000_001) }], [{ path, bytes: new Uint8Array(20 * 1024 * 1024 + 1) }]]) await assert.rejects(archive(input));
  for (const bad of ['/manifest.json', 'attachments/../x', 'attachments\\x', `attachments/${'A'.repeat(64)}`, 'other.json']) await assert.rejects(archive([{ path: bad, bytes: new Uint8Array() }]));
});
test('CRC, truncation, trailing junk, local/central metadata and EOCD are checked', async () => {
  const source = await archive();
  for (const cut of [0, 3, 29, 50, source.length - 1, source.length - 22]) await assert.rejects(decode(source.slice(0, cut)));
  for (const mutate of [
    (b: Uint8Array) => { b[43] ^= 1; },
    (b: Uint8Array) => { b[location(b, 0x02014b50) + 16] ^= 1; },
    (b: Uint8Array) => { b[location(b, 0x02014b50) + 42] ^= 1; },
    (b: Uint8Array) => { b[location(b, 0x06054b50) + 8] ^= 1; },
  ]) { const b = source.slice(); mutate(b); await assert.rejects(decode(b)); }
  const appended = new Uint8Array(source.length + 1); appended.set(source); await assert.rejects(decode(appended));
});
test('reader rejects non-native ZIP features and oversized declared payload before allocation/read', async () => {
  const source = await archive();
  for (const [offset, value] of [[6, 0x801], [6, 0x808], [8, 8], [4, 45], [28, 1], [26, 65535]] as const) {
    const b = source.slice(); new DataView(b.buffer).setUint16(offset, value, true); await assert.rejects(decode(b));
  }
  for (const offset of [18, 22]) { const b = source.slice(); new DataView(b.buffer).setUint32(offset, 0xffffffff, true); await assert.rejects(decode(b)); }
  const b = source.slice(0, 43); const v = new DataView(b.buffer); v.setUint32(18, 8_000_001, true); v.setUint32(22, 8_000_001, true);
  let pulls = 0;
  const input = new ReadableStream<Uint8Array>({ pull(c) { pulls++; if (pulls === 1) c.enqueue(b); else c.error(new Error('must reject before reading payload')); } }, { highWaterMark: 0 });
  await assert.rejects(async () => { for await (const entry of readStoredArchive(input)) void entry; }, /size limit/);
  assert.equal(pulls, 1);
  for (const offset of [30, 32, 34, 36, 38]) { const bad = source.slice(); new DataView(bad.buffer).setUint16(location(bad, 0x02014b50) + offset, 1, true); await assert.rejects(decode(bad)); }
});
test('entries remain staging until directory validation; cancellation releases input', async () => {
  const b = await archive(); b[location(b, 0x02014b50) + 16] ^= 1;
  const iterator = readStoredArchive(stream(b));
  assert.deepEqual((await iterator.next()).value, entries[0]);
  assert.deepEqual((await iterator.next()).value, entries[1]);
  await assert.rejects(iterator.next(), /metadata mismatch/);
  let cancelled = false;
  const input = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(b); }, cancel() { cancelled = true; } });
  const early = readStoredArchive(input); await early.next(); await early.return(undefined); assert.equal(cancelled, true);
});
test('entry count and attachment aggregate are bounded', async () => {
  async function* many() { yield entries[0]; for (let i = 0; i < 501; i++) yield { path: `attachments/${i.toString(16).padStart(64, '0')}`, bytes: new Uint8Array() }; }
  await assert.rejects(new Response(writeStoredArchive(many())).arrayBuffer(), /count/);
  async function* large() { yield entries[0]; const bytes = new Uint8Array(20 * 1024 * 1024); for (let i = 0; i < 11; i++) yield { path: `attachments/${i.toString(16).padStart(64, '0')}`, bytes }; }
  const reader = writeStoredArchive(large()).getReader();
  await assert.rejects(async () => { while (!(await reader.read()).done) { /* discard each chunk rather than aggregate */ } }, /total limit/);
});
test('reader independently rejects duplicate and unsafe paths even with ordinary ZIP headers', async () => {
  const source = await archive([entries[0], entries[1], { path: `attachments/${'b'.repeat(64)}`, bytes: new Uint8Array() }]);
  const original = new TextEncoder().encode(`attachments/${'b'.repeat(64)}`);
  const replacement = new TextEncoder().encode(path);
  for (let i = 0; i <= source.length - original.length; i++) {
    if (original.every((byte, j) => source[i + j] === byte)) source.set(replacement, i);
  }
  await assert.rejects(decode(source), /duplicate/);
  const unsafe = await archive(); unsafe.set(new TextEncoder().encode('../evil.json!'), 30);
  await assert.rejects(decode(unsafe), /unsupported member path/);
});
