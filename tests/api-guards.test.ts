import test from 'node:test';
import assert from 'node:assert/strict';
import { readMutation } from '../lib/api-guards.ts';
function request(body = JSON.stringify({ revision: 1, command: { type: 'task.create' } }), origin = 'https://app.example', type = 'application/json') {
  return new Request('https://app.example/api/workspace', { method: 'POST', headers: { origin, 'content-type': type }, body });
}
test('accepts an explicit same-origin JSON mutation with a revision', async () => {
  assert.deepEqual(await readMutation(request()), { revision: 1, command: { type: 'task.create' } });
});
test('rejects a cross-origin request before parsing its payload', async () => {
  await assert.rejects(readMutation(request('invalid', 'https://elsewhere.example')), { status: 403 });
});
test('rejects form submissions and invalid or oversized JSON', async () => {
  await assert.rejects(readMutation(request('{}', 'https://app.example', 'text/plain')), { status: 415 });
  await assert.rejects(readMutation(request('not json')), { status: 400 });
  await assert.rejects(readMutation(request('x'.repeat(65_537))), { status: 413 });
});
test('rejects absent, fractional and untrusted revision values', async () => {
  for (const revision of [undefined, -1, 0, 1.2, '1', Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(readMutation(request(JSON.stringify({ revision, command: {} }))), { status: 400 });
  }
});
