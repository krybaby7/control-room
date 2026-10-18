import assert from 'node:assert/strict';
import test from 'node:test';
import { boundedRequest, issueSubmissionId, lookupMutationOutcome, OutcomeUnknownError, reconcileSubmission, SaveSessionGeneration, sendCommand, StaleSessionError } from '../lib/save-controller.ts';
import { SessionExpiredError } from '../lib/workspace-client.ts';

const mutationId = 'original-id';
const committed = { status: 'committed', receipt: { mutationId, commandHash: 'hash', appliedRevision: 2 }, currentRevision: 3 };
const noBackoff = async () => {};
const hanging = () => new Promise<never>(() => {});

test('response loss reconciles the original ID without another POST', async () => {
  const requests: Array<{ url: string; method: string }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), method: init?.method ?? 'GET' });
    if (init?.method === 'POST') throw new Error('response lost after commit');
    return Response.json(committed);
  };
  await assert.rejects(sendCommand({ mutationId, revision: 1, command: { type: 'capture.create' } }, { fetch: fetcher }));
  assert.deepEqual(await reconcileSubmission(mutationId, { fetch: fetcher }), committed);
  assert.deepEqual(requests.map(request => request.method), ['POST', 'GET']);
  assert.equal(requests[1].url, '/api/workspace/mutations/original-id');
});

test('deadline bounds fetch even when abort is ignored', async () => {
  await assert.rejects(boundedRequest('/test', {}, async response => response.json(), { fetch: hanging, deadlineMs: 10 }), OutcomeUnknownError);
});

test('deadline includes hanging response body consumption', async () => {
  const fetcher: typeof fetch = async () => ({ status: 200, ok: true, json: hanging }) as unknown as Response;
  await assert.rejects(sendCommand({ revision: 1, mutationId, command: {} }, { fetch: fetcher, deadlineMs: 10 }), OutcomeUnknownError);
});

test('401 is classified without touching its body during lookup', async () => {
  const fetcher: typeof fetch = async () => ({ status: 401, json: () => assert.fail('body must not be read') }) as unknown as Response;
  await assert.rejects(reconcileSubmission(mutationId, { fetch: fetcher }), SessionExpiredError);
});

test('not-found may precede a later commit of the original request', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => Response.json(++calls === 1 ? { status: 'not-found', currentRevision: 1 } : committed);
  assert.deepEqual(await reconcileSubmission(mutationId, { fetch: fetcher, backoff: noBackoff }), committed);
  assert.equal(calls, 2);
});

test('not-found and failed lookups stop after three reads without execution', async () => {
  for (const fails of [false, true]) {
    let calls = 0;
    const fetcher: typeof fetch = async (_, init) => {
      assert.equal(init?.method, undefined);
      calls += 1;
      if (fails) throw new Error('offline');
      return Response.json({ status: 'not-found', currentRevision: 1 });
    };
    const result = await reconcileSubmission(mutationId, { fetch: fetcher, backoff: noBackoff });
    assert.equal(result.status, fails ? 'uncertain' : 'not-found');
    assert.equal(calls, 3);
  }
});

test('retired outcomes prevent retry and stop immediately', async () => {
  let calls = 0;
  const result = await reconcileSubmission(mutationId, { fetch: async () => { calls += 1; return Response.json({ status: 'retired', retryAllowed: false }); } });
  assert.deepEqual(result, { status: 'retired', retryAllowed: false });
  assert.equal(calls, 1);
});

test('a replaced session invalidates an outstanding reconciliation response', async () => {
  const session = new SaveSessionGeneration();
  let resolve!: (response: Response) => void;
  const pending = reconcileSubmission(mutationId, { session, fetch: () => new Promise<Response>(done => { resolve = done; }) });
  await Promise.resolve();
  session.invalidate();
  resolve(Response.json(committed));
  await assert.rejects(pending, StaleSessionError);
});

test('mismatched receipt IDs and malformed success remain unknown', async () => {
  for (const body of [{ ...committed, receipt: { ...committed.receipt, mutationId: 'other' } }, { status: 'committed' }]) {
    await assert.rejects(lookupMutationOutcome(mutationId, { fetch: async () => Response.json(body) }), OutcomeUnknownError);
  }
});


const issuedId = `m1_${'a'.repeat(32)}_${'b'.repeat(32)}`;

test('submission IDs are issued by a bounded private JSON request without a fallback', async () => {
  let calls = 0;
  const result = await issueSubmissionId({ fetch: async (url, init) => {
    calls += 1;
    assert.equal(url, '/api/workspace/mutation-ids');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.credentials, 'same-origin');
    assert.equal(init?.cache, 'no-store');
    assert.equal(new Headers(init?.headers).get('Content-Type'), 'application/json');
    assert.equal(init?.body, '{}');
    assert.ok(init?.signal instanceof AbortSignal);
    return Response.json({ mutationId: issuedId });
  } });
  assert.equal(result, issuedId);
  assert.equal(calls, 1);
});

test('malformed or failed submission ID responses never produce a client ID', async () => {
  for (const body of [null, [], {}, { mutationId: 'random-uuid' }, { mutationId: issuedId.toUpperCase() }, { mutationId: `${issuedId}extra` }, { mutationId: issuedId, owner: 'untrusted' }]) {
    let calls = 0;
    await assert.rejects(issueSubmissionId({ fetch: async () => { calls += 1; return Response.json(body); } }), /submission ID response was invalid/);
    assert.equal(calls, 1);
  }
  await assert.rejects(issueSubmissionId({ fetch: async () => new Response('invalid-json') }), /submission ID response was invalid/);
  await assert.rejects(issueSubmissionId({ fetch: async () => Response.json({ mutationId: issuedId }, { status: 503 }) }), /could not be issued/);
});

test('submission ID authentication failure does not consume its body', async () => {
  const fetcher: typeof fetch = async () => ({ status: 401, json: () => assert.fail('body must not be read') }) as unknown as Response;
  await assert.rejects(issueSubmissionId({ fetch: fetcher }), SessionExpiredError);
});

test('submission ID fetch and body deadlines hold even without abort support', async () => {
  for (const fetcher of [hanging, async () => ({ status: 200, ok: true, json: hanging }) as unknown as Response]) {
    await assert.rejects(issueSubmissionId({ fetch: fetcher, deadlineMs: 10 }), OutcomeUnknownError);
  }
});

test('session replacement rejects late issued IDs and prevents stale requests', async () => {
  const session = new SaveSessionGeneration();
  const generation = session.capture();
  let resolve!: (response: Response) => void;
  const pending = issueSubmissionId({ session, generation, fetch: () => new Promise<Response>(done => { resolve = done; }) });
  await Promise.resolve();
  session.invalidate();
  resolve(Response.json({ mutationId: issuedId }));
  await assert.rejects(pending, StaleSessionError);
  await assert.rejects(issueSubmissionId({ session, generation, fetch: async () => assert.fail('stale request must not be sent') }), StaleSessionError);
});

test('reviewed import commands use their named endpoint without changing submission bytes', async () => {
  const selection = Object.freeze({ projects: Object.freeze(['project']), milestones: Object.freeze([]), tasks: Object.freeze(['task']), captures: Object.freeze([]), activity: Object.freeze([]) });
  const command = Object.freeze({ type: 'workspace.import.commit', importId: 'file/with ?#', hash: 'a'.repeat(64), targetRevision: 7, mode: 'merge', selection });
  const submission = Object.freeze({ revision: 7, mutationId: issuedId, command });
  const original = JSON.stringify(submission);
  let calls = 0;
  await sendCommand(submission, { fetch: async (url, init) => {
    calls += 1;
    assert.equal(url, '/api/workspace/imports/file%2Fwith%20%3F%23/commit');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.body, original);
    return Response.json({ workspace: { schemaVersion: 3 }, revision: 8, updatedAt: '2026-10-18T00:00:00Z' });
  } });
  assert.equal(JSON.stringify(submission), original);
  assert.equal(calls, 1);
});

test('ordinary commands retain the workspace endpoint and exact body', async () => {
  const submission = Object.freeze({ revision: 7, mutationId: issuedId, command: Object.freeze({ type: 'capture.create', capture: Object.freeze({ title: 'Keep me' }) }) });
  const original = JSON.stringify(submission);
  await sendCommand(submission, { fetch: async (url, init) => {
    assert.equal(url, '/api/workspace');
    assert.equal(init?.body, original);
    return Response.json({ workspace: { schemaVersion: 3 }, revision: 8, updatedAt: '2026-10-18T00:00:00Z' });
  } });
  assert.equal(JSON.stringify(submission), original);
});
