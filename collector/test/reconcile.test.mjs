import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, appendFile, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectFile, classifyChange, createReconciler } from '../src/reconcile.mjs';
test('full fingerprints catch preserved timestamps, resumed partial writes and truncate/rotate', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'history-reconcile-'));
    try {
        const path = join(dir, 'chat.jsonl');
        await writeFile(path, '{"a":1}\n{"b":');
        const first = await inspectFile(path, null);
        assert.equal(first.lastCompleteOffset, 8);
        await appendFile(path, '2}\n');
        const next = await inspectFile(path, first);
        assert.deepEqual(classifyChange(first, next), {
            changed: true, reason: 'appended', from: 8
        });
        const metadata = await stat(path);
        await writeFile(path, '{"a":9}\n{"b":2}\n');
        await utimes(path, metadata.atime, metadata.mtime);
        const rewritten = await inspectFile(path, next);
        assert.equal(classifyChange(next, rewritten).reason, 'rewritten');
        await writeFile(path, '{}\n');
        assert.equal(classifyChange(rewritten, await inspectFile(path, rewritten)).reason, 'replaced_or_truncated');
        assert.equal(classifyChange(next, {
            ...next, sha256: 'changed', compressed: true
        }).from, 0);
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});
test('startup and periodic sweeps catch missed hints; retries preserve prior file checkpoint', async () => {
    let state = null, version = 'one', calls = 0, clock = 0, fail = false;
    const reconciler = createReconciler({
        intervalMs: 1000, now: () => clock, listPage: async () => ({ entries: [{ id: 'old-chat' }], nextCursor: null }), inspect: async () => ({
            identity: 'stable', size: 1, sha256: version, lastCompleteOffset: 1, readerVersion: '1', compressed: false
        }), readChanged: async () => {
            if (fail)
                throw Error('offline spool full');
            calls++;
        }, readState: async () => state, writeState: async (next) => {
            state = structuredClone(next);
        }
    });
    await reconciler.run();
    assert.equal(calls, 1);
    reconciler.hint();
    reconciler.hint();
    await reconciler.run();
    assert.equal(calls, 1);
    version = 'two';
    clock = 2000;
    await reconciler.run();
    assert.equal(calls, 2);
    version = 'three';
    clock = 4000;
    fail = true;
    await assert.rejects(reconciler.run(), /spool/);
    assert.equal(state.files['old-chat'].sha256, 'two');
    fail = false;
    await reconciler.run();
    assert.equal(state.files['old-chat'].sha256, 'three');
});
