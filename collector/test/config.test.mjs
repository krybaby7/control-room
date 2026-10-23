import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateConfig, writeConfig, readConfig } from '../src/config.mjs';
import { writeCredential, readCredential } from '../src/credentials.mjs';
import { digest } from '../src/spool.mjs';
test('explicit source/history scopes and trusted HTTPS origin; credentials stay separate and protected', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'history-config-'));
    try {
        const source = {
            codecVersion: 1, sourceId: 's', kind: 'codex_local', epoch: 'e', scopeRevision: 1, roots: [dir], accountId: null, deviceId: null, includeArchived: true, exclusions: [], parserVersion: '1', normalizationVersion: '1'
        }, config = {
            codecVersion: 1, origin: 'https://example.invalid', stateDirectory: dir, sources: [source], scopes: ['history.read', 'history.ingest'], reconcileIntervalMs: 300000, debounceMs: 5000, maxCatchUpLagMs: 600000
        }, options = { allowedOrigins: [config.origin] };
        assert.throws(() => validateConfig({ ...config, token: 'secret' }, options));
        assert.throws(() => validateConfig({ ...config, scopes: ['telemetry.write'] }, options));
        assert.throws(() => validateConfig({ ...config, origin: 'https://other.invalid' }, options));
        await writeConfig(join(dir, 'config.json'), config, options);
        assert.deepEqual(await readConfig(join(dir, 'config.json'), options), config);
        const credentials = join(dir, 'credentials');
        await writeCredential(credentials, {
            version: 1, ...Object.fromEntries(['sourceId', 'epoch', 'scopeRevision'].map(k => [k, source[k]])), token: 'crh_' + 'a'.repeat(64), expiresAt: new Date(Date.now() + 60000).toISOString()
        });
        if (process.platform !== 'win32') {
            assert.ok(await readCredential(credentials, source));
            await assert.rejects(readCredential(credentials, { ...source, epoch: 'rotated' }));
            const other = join(dir, 'other');
            await symlink(join(credentials, digest('s') + '.json'), other);
            await assert.rejects(readConfig(other, options));
        }
        assert.equal(JSON.stringify(config).includes('crh_'), false);
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});
import { copyFile } from 'node:fs/promises';
import { runCollector } from '../src/cli.mjs';
import { createTransport } from '../src/transport.mjs';
import { canonicalEnvelopeDigest, validateCollectionEnvelope } from '../../lib/history/validation.ts';
test('CLI orchestration imports a synthetic retained reader page through locked delivery and durable ack', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'history-cli-'));
    try {
        await copyFile(new URL('./fixtures/codex/retained.jsonl', import.meta.url), join(dir, 'synthetic.jsonl'));
        const source = {
            codecVersion: 1, sourceId: 'synthetic-cli', kind: 'codex_local', epoch: 'e', scopeRevision: 1, roots: [dir], accountId: null, deviceId: null, includeArchived: true, exclusions: [], parserVersion: '1', normalizationVersion: 'unicode-v1'
        }, config = {
            codecVersion: 1, origin: 'https://example.invalid', stateDirectory: join(dir, 'state'), sources: [source], scopes: ['history.read', 'history.ingest'], reconcileIntervalMs: 300000, debounceMs: 5000, maxCatchUpLagMs: 600000
        };
        let objects = 0, pages = 0;
        const sender = createTransport({
            origin: config.origin, allowedOrigins: [config.origin], credential: async () => ({
                version: 1, sourceId: source.sourceId, epoch: source.epoch, scopeRevision: 1, token: 'crh_' + 'a'.repeat(64), expiresAt: new Date(Date.now() + 60000).toISOString()
            }), privateIngress: async () => ({ 'Authorization': 'synthetic-independent-ingress' }), fetchImpl: async (url, input) => {
                if (url.endsWith('/objects'))
                    return Response.json({
                        key: `history/11111111-1111-4111-8111-111111111111/${String(++objects).padStart(8, '0')}-2222-4222-8222-222222222222`, sha256: input.headers.get('X-History-SHA256'), bytes: input.body.length
                    });
                const envelope = JSON.parse(input.body);
                validateCollectionEnvelope(envelope, envelope.page.objectManifest.map(object => ({ ...object, verified: true })));
                pages++;
                return Response.json({ receipt: {
                        sourceId: source.sourceId, epoch: source.epoch, scopeRevision: 1, pageId: envelope.page.pageId, pageDigest: await canonicalEnvelopeDigest(envelope), committedCursor: envelope.page.nextCursor, watermark: String(pages), committedAt: new Date().toISOString()
                    } });
            }
        });
        const first = await runCollector(config, { once: true, transport: sender });
        assert.equal(first.pending, 0);
        assert.ok(objects > 0);
        assert.ok(pages > 0);
        const uploaded = objects;
        const second = await runCollector(config, { once: true, transport: sender });
        assert.equal(second.pending, 0);
        assert.equal(objects, uploaded, 'unchanged revisions reuse finalized keys on the next run');
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});
import { HistoryTransportError } from '../src/transport.mjs';
import { openCheckpoints } from '../src/checkpoints.mjs';
test('server authorization denial durably blocks further source reads until explicit reconfiguration', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'history-denied-'));
    try {
        const source = {
            codecVersion: 1, sourceId: 's', kind: 'codex_local', epoch: 'e', scopeRevision: 1, roots: [dir], accountId: null, deviceId: null, includeArchived: true, exclusions: [], parserVersion: '1', normalizationVersion: '1'
        }, config = {
            codecVersion: 1, origin: 'https://example.invalid', stateDirectory: join(dir, 'state'), sources: [source], scopes: ['history.read', 'history.ingest'], reconcileIntervalMs: 300000, debounceMs: 5000, maxCatchUpLagMs: 600000
        };
        let reads = 0;
        const adapterFactory = async ({ runId }) => ({ async readPage() {
                reads++;
                return {
                    codecVersion: 1, sourceId: 's', runId, pageId: 'page', previousCursor: null, nextCursor: null, inventoryExhausted: true, conversations: [], messages: [], segments: [], attachments: [], gaps: [], objectManifest: []
                };
            } }), transport = { async deliver() {
                throw new HistoryTransportError('credential_or_ingress_denied');
            } };
        await assert.rejects(runCollector(config, {
            once: true, adapterFactory, transport
        }), /denied/);
        assert.equal((await openCheckpoints(join(config.stateDirectory, 'checkpoints'), source)).read().blocked, 'credential_or_ingress_denied');
        const resumed = await runCollector(config, {
            once: true, adapterFactory, transport
        });
        assert.equal(reads, 1);
        assert.equal(resumed.pending, 1);
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});
import { openSpool } from '../src/spool.mjs';
import { main } from '../src/cli.mjs';
import { TRUSTED_HISTORY_ORIGIN } from '../src/config.mjs';
import { writeFile } from 'node:fs/promises';
function regressionConfig(dir) {
    return {
        codecVersion: 1, origin: TRUSTED_HISTORY_ORIGIN, stateDirectory: join(dir, 'state'), sources: [{
                codecVersion: 1, sourceId: 's', kind: 'codex_local', epoch: 'e', scopeRevision: 1, roots: [dir], accountId: null, deviceId: null, includeArchived: true, exclusions: [], parserVersion: '1', normalizationVersion: 'unicode-v1'
            }], scopes: ['history.read', 'history.ingest'], reconcileIntervalMs: 300000, debounceMs: 5000, maxCatchUpLagMs: 600000
    };
}
function localAcknowledgingSender(onDelivery = () => {
}) {
    return { async deliver(spool, id) {
            const entry = await spool.load(id), delivery = await spool.lockDelivery(id, entry.envelope);
            const receipt = {
                sourceId: entry.envelope.page.sourceId, epoch: entry.envelope.epoch, scopeRevision: entry.envelope.scopeRevision, pageId: entry.envelope.page.pageId, pageDigest: delivery.digest, committedCursor: entry.envelope.page.nextCursor, watermark: 'synthetic', committedAt: new Date().toISOString()
            };
            await spool.acknowledge(id, receipt);
            onDelivery(entry);
            return receipt;
        } };
}
test('1500-message bounded import reports unfinished acquisition with zero queued packets and resumes truthfully', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'history-continued-'));
    try {
        const config = regressionConfig(dir), path = join(dir, 'config.json');
        await writeConfig(path, config);
        const rows = [{ type: 'session_meta', payload: { id: 'thread', segment_id: 'segment' } }, ...Array.from({ length: 1500 }, (_, i) => ({ type: 'response_item', payload: {
                    type: 'message', id: `message-${i}`, role: 'assistant', content: [{ type: 'output_text', text: `body-${i}` }]
                } }))];
        await writeFile(join(dir, 'retained.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
        let messages = 0;
        const sender = localAcknowledgingSender(entry => {
            messages += entry.envelope.page.messages.length;
        });
        const first = await runCollector(config, { once: true, transport: sender });
        assert.equal(first.pending, 0);
        assert.ok(messages < 1500);
        assert.equal(first.catchUpRequired, true);
        assert.ok(first.continuations.some(c => c.acquiredCursor !== null));
        assert.equal((await main(['status', '--config', path])).catchUpRequired, true);
        const second = await runCollector(config, { once: true, transport: sender });
        assert.equal(messages, 1500);
        assert.equal(second.pending, 0);
        assert.equal(second.catchUpRequired, false);
        assert.equal((await main(['status', '--config', path])).catchUpRequired, false);
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});
test('a full durable spool drains before acquisition instead of wedging every restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'history-drain-first-'));
    try {
        const config = regressionConfig(dir), spool = await openSpool(config.stateDirectory), checkpoint = await openCheckpoints(join(config.stateDirectory, 'checkpoints'), config.sources[0]);
        let cursor = null, filled = 0;
        for (let i = 0; i < 100; i++) {
            const page = {
                codecVersion: 1, sourceId: 's', runId: 'run', pageId: `pending-${i}`, previousCursor: cursor, nextCursor: `cursor-${i}`, inventoryExhausted: false, conversations: [], messages: [], segments: [], attachments: [], gaps: [], objectManifest: []
            };
            try {
                const entry = await spool.acquire({
                    protocolVersion: 1, epoch: 'e', scopeRevision: 1, page
                }, []);
                await checkpoint.acquired(entry);
                filled++;
                cursor = page.nextCursor;
            }
            catch (error) {
                assert.match(error.message, /Spool full/);
                break;
            }
        }
        assert.ok(filled > 50);
        let delivered = 0, acquired = false;
        const sender = localAcknowledgingSender(() => {
            delivered++;
        }), factory = async ({ runId }) => ({ async readPage(previousCursor) {
                acquired = true;
                return {
                    codecVersion: 1, sourceId: 's', runId, pageId: 'after-drain', previousCursor, nextCursor: null, inventoryExhausted: true, conversations: [], messages: [], segments: [], attachments: [], gaps: [], objectManifest: []
                };
            } });
        const result = await runCollector(config, {
            once: true, transport: sender, adapterFactory: factory
        });
        assert.ok(delivered >= filled);
        assert.equal(acquired, true);
        assert.equal(result.pending, 0);
        assert.equal(result.catchUpRequired, false);
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});
