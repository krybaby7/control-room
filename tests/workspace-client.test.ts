import assert from 'node:assert/strict';
import test from 'node:test';
import { readWorkspaceResponse, SessionExpiredError, submissionFor } from '../lib/workspace-client.ts';

test('an uncertain unchanged submission keeps its mutation ID after revision refresh', () => {
  let sequence = 0;
  const createId = () => `mutation-${++sequence}`;
  const first = submissionFor(null, { type: 'capture.create', capture: { title: 'Keep me' } }, createId);
  const retry = submissionFor(first, { capture: { title: 'Keep me' }, type: 'capture.create' }, createId);
  assert.equal(retry.mutationId, first.mutationId);
  assert.equal(sequence, 1);
});

test('changing a command or acknowledging it creates a fresh submission', () => {
  let sequence = 0;
  const createId = () => `mutation-${++sequence}`;
  const first = submissionFor(null, { title: 'Original' }, createId);
  const changed = submissionFor(first, { title: 'Changed' }, createId);
  assert.notEqual(changed.mutationId, first.mutationId);
  assert.notEqual(submissionFor(null, { title: 'Changed' }, createId).mutationId, changed.mutationId);
});

test('a 401 is explicitly classified before decoding an invalid body', async () => {
  await assert.rejects(readWorkspaceResponse(new Response('Expired', { status: 401 })), SessionExpiredError);
});

test('an incomplete success stays uncertain instead of acknowledging the mutation', async () => {
  await assert.rejects(readWorkspaceResponse(Response.json({ revision: 2 })), /incomplete/);
});

test('a valid workspace response preserves the saved time separately from receipt time', async () => {
  const body = { workspace: { schemaVersion: 2 }, revision: 4, updatedAt: '2026-10-10T08:00:00Z' };
  assert.deepEqual(await readWorkspaceResponse(Response.json(body)), body);
});
