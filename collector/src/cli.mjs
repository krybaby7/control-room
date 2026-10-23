import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { readConfig, writeConfig, COLLECTOR_VERSION } from './config.mjs';
import { openSpool, acquireSingleInstance, digest } from './spool.mjs';
import { openCheckpoints } from './checkpoints.mjs';
import { createTransport, retryDelay } from './transport.mjs';
import { readCredential } from './credentials.mjs';
import { watchRoots } from './watch.mjs';
export function createAssetStager({ maxBytes = 32 * 1024 * 1024 } = {}) {
    let total = 0;
    const assets = new Map();
    return {
        async stageAsset({ bytes, sha256, kind, nativeId }) {
            if (!(bytes instanceof Uint8Array) || bytes.length > 16 * 1024 * 1024 || sha256 !== digest(bytes) || !['message', 'segment', 'attachment'].includes(kind) || typeof nativeId !== 'string')
                throw Error('Invalid reader asset');
            const key = 'local:' + digest([sha256, kind, nativeId]);
            if (!assets.has(key)) {
                total += bytes.length;
                if (total > maxBytes)
                    throw Error('Acquisition object budget exhausted; checkpoint retained');
                assets.set(key, {
                    key, sha256, bytes: bytes.length, content: bytes.slice()
                });
            }
            return {
                key, sha256, bytes: bytes.length
            };
        }, release(keys) {
            for (const key of keys) {
                const asset = assets.get(key);
                if (asset) {
                    total -= asset.bytes;
                    assets.delete(key);
                }
            }
        }, assets: () => [...assets.values()]
    };
}
export async function collectorStatus(config, spool) {
    const entries = await spool.list(), blockedSources = [], continuations = [], acquisitionPaused = [];
    for (const source of config.sources) {
        const state = (await openCheckpoints(join(config.stateDirectory, 'checkpoints'), source)).read();
        if (state.blocked)
            blockedSources.push({ sourceId: source.sourceId, reason: state.blocked });
        if (state.acquisitionPaused)
            acquisitionPaused.push({ sourceId: source.sourceId, reason: state.acquisitionPaused });
        if (!state.acquired.complete || state.acquired.cursor !== null || state.acknowledged.sequence < state.acquired.sequence)
            continuations.push({
                sourceId: source.sourceId, runId: state.acquired.runId, acquiredCursor: state.acquired.cursor, acknowledgedCursor: state.acknowledged.cursor
            });
    }
    const catchUpRequired = entries.length > 0 || continuations.length > 0 || blockedSources.length > 0;
    return {
        version: COLLECTOR_VERSION, pending: entries.length, complete: !catchUpRequired, catchUpRequired, continuations, blockedSources, acquisitionPaused, oldestPendingAt: entries[0]?.acquiredAt ?? null, configuredMaxCatchUpLagMs: config.maxCatchUpLagMs, usage: await spool.usage(), liveIngress: 'not_configured', unattended: 'unverified'
    };
}
const backpressure = error => /Spool full|index full|mapping cache full|budget exhausted/.test(String(error.message ?? '')) || error.code === 'ENOSPC';
export async function runCollector(config, { once = false, signal, adapterFactory, transport, now = Date.now } = {}) {
    const release = await acquireSingleInstance(config.stateDirectory);
    let closeWatch = () => {
    };
    try {
        const spool = await openSpool(config.stateDirectory);
        await spool.recoverInterrupted();
        let hinted = true, lastSweep = 0, attempt = 0;
        closeWatch = watchRoots(config.sources.flatMap(s => s.roots), () => {
            hinted = true;
        }, { debounceMs: config.debounceMs });
        async function recover() {
            const queued = await spool.list();
            for (const source of config.sources) {
                const checkpoint = await openCheckpoints(join(config.stateDirectory, 'checkpoints'), source);
                await checkpoint.recover(queued.filter(e => e.envelope.page.sourceId === source.sourceId && e.envelope.epoch === source.epoch && e.envelope.scopeRevision === source.scopeRevision), spool);
            }
        }
        async function drain() {
            let failure = null;
            const failed = new Set();
            for (const entry of await spool.list()) {
                signal?.throwIfAborted();
                const source = config.sources.find(s => s.sourceId === entry.envelope.page.sourceId && s.epoch === entry.envelope.epoch && s.scopeRevision === entry.envelope.scopeRevision);
                if (!source || failed.has(source.sourceId))
                    continue;
                const checkpoint = await openCheckpoints(join(config.stateDirectory, 'checkpoints'), source);
                if (checkpoint.read().blocked || checkpoint.read().acknowledged.cursor !== entry.envelope.page.previousCursor)
                    continue;
                const sender = transport ?? createTransport({ origin: config.origin, credential: () => readCredential(join(config.stateDirectory, 'credentials'), source) });
                try {
                    await sender.deliver(spool, entry.id, { signal });
                    const fresh = await spool.load(entry.id);
                    await checkpoint.acknowledged(fresh);
                    await spool.pruneAcknowledged(entry.id, checkpoint.read().acknowledged);
                }
                catch (error) {
                    if (['credential_or_ingress_denied', 'reconcile_needed'].includes(error.code))
                        await checkpoint.block(error.code);
                    failed.add(source.sourceId);
                    failure ??= error;
                }
            }
            attempt = failure ? attempt + 1 : 0;
            return failure;
        }
        do {
            signal?.throwIfAborted();
            await recover();
            // Releasing acknowledged queue capacity must precede any new reader work.
            const initialFailure = await drain();
            if (once && initialFailure && ['credential_or_ingress_denied', 'reconcile_needed'].includes(initialFailure.code))
                throw initialFailure;
            if (once || hinted || now() - lastSweep >= config.reconcileIntervalMs) {
                hinted = false;
                lastSweep = now();
                for (const source of config.sources) {
                    const checkpoint = await openCheckpoints(join(config.stateDirectory, 'checkpoints'), source);
                    if (checkpoint.read().blocked)
                        continue;
                    const state = checkpoint.read(), assets = createAssetStager(), runId = state.acquired.cursor === null && state.acquired.complete !== false || state.acquired.runId === null ? randomUUID() : state.acquired.runId;
                    await checkpoint.beginAcquisition(runId);
                    let create = adapterFactory;
                    if (!create) {
                        const adapterModule = source.kind === 'codex_local' ? await import('./adapters/codex-local.mjs') : await import('./adapters/claude-code-local.mjs');
                        create = source.kind === 'codex_local' ? adapterModule.createCodexLocalAdapter : adapterModule.createClaudeCodeLocalAdapter;
                    }
                    const adapter = await create({
                        configuration: source, runId, stageAsset: assets.stageAsset
                    });
                    let cursor = checkpoint.read().acquired.cursor;
                    try {
                        for (let pages = 0; pages < 5; pages++) {
                            signal?.throwIfAborted();
                            const page = await adapter.readPage(cursor, signal), envelope = {
                                protocolVersion: 1, epoch: source.epoch, scopeRevision: source.scopeRevision, page
                            }, manifests = new Set(page.objectManifest.map(o => o.key));
                            const entry = await spool.acquire(envelope, assets.assets().filter(a => manifests.has(a.key)));
                            await checkpoint.acquired(entry);
                            assets.release(manifests);
                            cursor = page.nextCursor;
                            if (page.inventoryExhausted && cursor === null)
                                break;
                            if (pages === 4 && cursor !== null)
                                hinted = true;
                        }
                    }
                    catch (error) {
                        if (!backpressure(error))
                            throw error;
                        await checkpoint.pauseAcquisition();
                    }
                }
            }
            const finalFailure = await drain();
            if (once) {
                if (finalFailure)
                    throw finalFailure;
                break;
            }
            await new Promise((ok, no) => {
                const aborted = () => {
                    clearTimeout(timer);
                    no(signal.reason);
                };
                const timer = setTimeout(() => {
                    signal?.removeEventListener('abort', aborted);
                    ok();
                }, retryDelay(attempt));
                signal?.addEventListener('abort', aborted, { once: true });
            });
        } while (!signal?.aborted);
        return collectorStatus(config, spool);
    }
    finally {
        closeWatch();
        await release();
    }
}
export async function main(args = process.argv.slice(2)) {
    const [command, ...rest] = args;
    const options = {};
    for (let i = 0; i < rest.length; i += 2) {
        if (!['--config', '--input'].includes(rest[i]) || !rest[i + 1])
            throw Error('Expected explicit --config and optional --input');
        options[rest[i]] = resolve(rest[i + 1]);
    }
    if (!options['--config'])
        throw Error('Explicit configuration path required');
    if (command === 'configure') {
        if (!options['--input'])
            throw Error('Explicit selected source configuration required');
        const selected = await writeConfig(options['--config'], JSON.parse(await readFile(options['--input'], 'utf8')));
        for (const source of selected.sources)
            await (await openCheckpoints(join(selected.stateDirectory, 'checkpoints'), source)).clearBlock();
        return { configured: true, version: COLLECTOR_VERSION };
    }
    const config = await readConfig(options['--config']);
    if (command === 'status')
        return collectorStatus(config, await openSpool(config.stateDirectory));
    if (!['import', 'run'].includes(command))
        throw Error('Use configure, import, run or status');
    const abort = new AbortController();
    for (const name of ['SIGINT', 'SIGTERM'])
        process.once(name, () => abort.abort(Error('cancelled')));
    return runCollector(config, { once: command === 'import', signal: abort.signal });
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
    main().then(value => process.stdout.write(JSON.stringify(value) + '\n')).catch(error => {
        const message = String(error.message ?? '');
        const code = error.code === 'ENOSPC' ? 'disk_full' : /Spool full|index full|mapping cache full|budget exhausted/.test(message) ? 'backpressure' : /Corrupt|corrupt/.test(message) ? 'corrupt_state' : ['private_ingress_not_configured', 'credential_unavailable', 'reconcile_needed', 'credential_or_ingress_denied'].includes(error.code ?? error.message) ? error.code ?? error.message : 'collector_stopped';
        process.stderr.write(JSON.stringify({
            code, retained: true, liveVerified: false
        }) + '\n');
        process.exitCode = 1;
    });
