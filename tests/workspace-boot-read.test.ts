import assert from 'node:assert/strict';
import test from 'node:test';
import { BOOT_READ_GLOBAL, BOOT_READ_MAX_AGE_MS, BOOT_READ_SCRIPT, takeBootWorkspaceRead } from '../lib/workspace-boot-read.ts';
import { boundedRequest } from '../lib/save-controller.ts';
import { readWorkspaceResponse } from '../lib/workspace-client.ts';

const envelope = { workspace: { projects: [] }, revision: 4, updatedAt: '2026-10-26T00:00:00.000Z' };
function page(at: number, fetcher: typeof fetch) {
  const holder: Record<string, unknown> = {};
  new Function('window', 'fetch', 'performance', BOOT_READ_SCRIPT)(holder, fetcher, { now: () => at });
  return holder;
}
async function withWindow<T>(holder: Record<string, unknown>, run: () => Promise<T>): Promise<T> {
  const global = globalThis as unknown as Record<string, unknown>;
  global.window = holder;
  try { return await run(); } finally { delete global.window; }
}

test('the page script starts one same-origin uncached workspace read', () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const holder = page(5, async (input, init) => { requests.push({ url: String(input), init }); return Response.json(envelope); });
  assert.deepEqual(requests, [{ url: '/api/workspace', init: { credentials: 'same-origin', cache: 'no-store' } }]);
  assert.equal((holder[BOOT_READ_GLOBAL] as { startedAt: number }).startedAt, 5);
});

test('the first read takes the early response once; later reads go to the network', async () => {
  const holder = page(0, async () => Response.json(envelope));
  await withWindow(holder, async () => {
    let network = 0;
    const fetcher: typeof fetch = () => takeBootWorkspaceRead(() => 100) ?? (network++, Promise.resolve(Response.json({ ...envelope, revision: 5 })));
    assert.equal((await boundedRequest('/api/workspace', {}, readWorkspaceResponse, { fetch: fetcher })).revision, 4);
    assert.equal(network, 0);
    assert.equal(BOOT_READ_GLOBAL in holder, false);
    assert.equal((await boundedRequest('/api/workspace', {}, readWorkspaceResponse, { fetch: fetcher })).revision, 5);
    assert.equal(network, 1);
  });
});

test('a stale, missing or malformed early read is discarded', async () => {
  await withWindow(page(0, async () => Response.json(envelope)), async () => {
    assert.equal(takeBootWorkspaceRead(() => BOOT_READ_MAX_AGE_MS + 1), null);
    assert.equal(takeBootWorkspaceRead(() => 0), null);
  });
  await withWindow({ [BOOT_READ_GLOBAL]: { startedAt: 0, response: 'not a promise' } }, async () => assert.equal(takeBootWorkspaceRead(() => 0), null));
  assert.equal(takeBootWorkspaceRead(() => 0), null);
});

test('a failed early read surfaces through the read that takes it', async () => {
  const holder = page(0, async () => { throw new TypeError('offline'); });
  await withWindow(holder, async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
    const early = takeBootWorkspaceRead(() => 0);
    assert.ok(early);
    await assert.rejects(boundedRequest('/api/workspace', {}, readWorkspaceResponse, { fetch: () => early }), /offline/);
  });
});
