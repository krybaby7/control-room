import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSpool } from '../src/spool.mjs';
import { openCheckpoints } from '../src/checkpoints.mjs';
const envelope = (pageId, previousCursor, nextCursor) => ({
    protocolVersion: 1, epoch: 'e', scopeRevision: 1, page: {
        codecVersion: 1, sourceId: 's', runId: 'r', pageId, previousCursor, nextCursor, inventoryExhausted: nextCursor === null, conversations: [], messages: [], segments: [], attachments: [], gaps: [], objectManifest: []
    }
});
test('acquired and acknowledged cursors are distinct, durable and cannot rewind a completed sweep', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'history-checkpoint-'));
    try {
        const spool = await openSpool(join(dir, 'spool')), source = {
            sourceId: 's', epoch: 'e', scopeRevision: 1
        }, checkpoint = await openCheckpoints(join(dir, 'cp'), source), first = await spool.acquire(envelope('one', null, 'next'), []);
        await checkpoint.acquired(first);
        assert.equal(checkpoint.read().acquired.cursor, 'next');
        assert.equal(checkpoint.read().acknowledged.cursor, null);
        await assert.rejects(checkpoint.acknowledged(first), /receipt/);
        const locked = await spool.lockDelivery(first.id, first.envelope), receipt = {
            sourceId: 's', epoch: 'e', scopeRevision: 1, pageId: 'one', pageDigest: locked.digest, committedCursor: 'next', watermark: '1', committedAt: new Date().toISOString()
        };
        await assert.rejects(spool.acknowledge(first.id, { ...receipt, pageDigest: 'a'.repeat(64) }), /match/);
        await spool.acknowledge(first.id, receipt);
        await checkpoint.acknowledged(await spool.load(first.id));
        assert.equal((await openCheckpoints(join(dir, 'cp'), source)).read().acknowledged.cursor, 'next');
        const restarted=await openCheckpoints(join(dir,'cp'),source);await restarted.recover(await spool.list(),spool);assert.equal((await spool.list()).length,0,'receipt + checkpoint persisted before crash permits safe restart cleanup');
        const second = await spool.acquire(envelope('two', 'next', null), []);
        await checkpoint.acquired(second);
        await checkpoint.acquired(first);
        assert.equal(checkpoint.read().acquired.pageId, 'two');
        assert.equal(checkpoint.read().acquired.cursor, null);
        assert.equal((await openCheckpoints(join(dir, 'cp'), { ...source, scopeRevision: 2 })).read().acquired.cursor, null);
        
        assert.equal((await spool.list()).length, 1);
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});
