import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { open, mkdir, rename, readdir, rm, lstat } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
export const canonical = value => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value))
        return JSON.stringify(value);
    if (Array.isArray(value))
        return '[' + value.map(canonical).join(',') + ']';
    if (value && Object.getPrototypeOf(value) === Object.prototype)
        return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
    throw Error('Non-JSON collector data');
};
export const digest = value => createHash('sha256').update(typeof value === 'string' || value instanceof Uint8Array ? value : canonical(value)).digest('hex');
async function assertWindowsPrivate(path) {
    if (process.platform === 'win32')
        await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', fileURLToPath(new URL('../windows/check-private-path.ps1', import.meta.url)), '-Path', path], {
            windowsHide: true, maxBuffer: 1024, timeout: 5000
        });
}
export async function privateDirectory(path) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || process.platform !== 'win32' && (stat.mode & 0o077))
        throw Error('Collector directory must be private to current user');
    await assertWindowsPrivate(path);
}
async function flushDirectory(path) {
    try {
        const handle = await open(path, 'r');
        try {
            await handle.sync();
        }
        finally {
            await handle.close();
        }
    }
    catch (error) {
        if (process.platform !== 'win32' || !['EPERM', 'EISDIR', 'EINVAL'].includes(error.code))
            throw error;
    }
}
export async function atomicPrivateJson(path, value, { beforeRename } = {}) {
    const temp = path + '.tmp-' + randomUUID();
    const handle = await open(temp, 'wx', 0o600);
    try {
        await handle.writeFile(canonical(value));
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    await beforeRename?.();
    await rename(temp, path);
    await flushDirectory(resolve(path, '..'));
}
async function readPrivateBytes(path, maxBytes, exactBytes) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
        throw Error('Invalid private file bound');
    // Reject linked ancestors as well as the final file. Windows ACL/reparse checks
    // are an additional platform gate; native Windows acceptance remains unverified.
    let parent = dirname(resolve(path));
    for (;;) {
        const stat = await lstat(parent);
        if (!stat.isDirectory() || stat.isSymbolicLink())
            throw Error('Unsafe private file parent link');
        if (dirname(parent) === parent) break;
        parent = dirname(parent);
    }
    const before = await lstat(path);
    const safe = stat => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 &&
        stat.size <= maxBytes && (exactBytes === undefined || stat.size === exactBytes) &&
        (process.platform === 'win32' || !(stat.mode & 0o077) && stat.uid === process.getuid());
    if (!safe(before)) throw Error('Unsafe private file or oversized asset size');
    await assertWindowsPrivate(path);
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
        const stat = await handle.stat();
        if (!safe(stat) || stat.dev !== before.dev || stat.ino !== before.ino)
            throw Error('Private file changed before bounded read');
        const bytes = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < bytes.length) {
            const result = await handle.read(bytes, offset, bytes.length - offset, offset);
            if (!result.bytesRead) throw Error('Private file truncated during read');
            offset += result.bytesRead;
        }
        const extra = await handle.read(Buffer.alloc(1), 0, 1, offset);
        const after = await handle.stat();
        if (extra.bytesRead || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs)
            throw Error('Private file changed during bounded read');
        return bytes;
    } finally { await handle.close(); }
}
export async function readPrivateAsset(path, bytes, sha256) {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 16 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(sha256))
        throw Error('Invalid private asset bound');
    const content = await readPrivateBytes(path, 16 * 1024 * 1024, bytes);
    if (digest(content) !== sha256) throw Error('Corrupt private asset digest');
    return content;
}
export async function readPrivateJson(path, maxBytes = 4 * 1024 * 1024) {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readPrivateBytes(path, maxBytes)));
}
export function validateEnvelope(envelope) {
    if (!envelope || Object.keys(envelope).sort().join(',') !== 'epoch,page,protocolVersion,scopeRevision' || envelope.protocolVersion !== 1 || typeof envelope.epoch !== 'string' || !envelope.epoch || envelope.epoch.length > 4096 || !Number.isSafeInteger(envelope.scopeRevision) || envelope.scopeRevision < 1 || envelope.page?.codecVersion !== 1 || !envelope.page.sourceId || !envelope.page.pageId || !Array.isArray(envelope.page.objectManifest) || envelope.page.objectManifest.length > 1000 || Object.keys(envelope.page).sort().join(',') !== 'attachments,codecVersion,conversations,gaps,inventoryExhausted,messages,nextCursor,objectManifest,pageId,previousCursor,runId,segments,sourceId' || ['conversations', 'messages', 'segments', 'attachments', 'gaps', 'objectManifest'].some(k => !Array.isArray(envelope.page[k])) || typeof envelope.page.inventoryExhausted !== 'boolean' || ['previousCursor', 'nextCursor'].some(k => envelope.page[k] !== null && (typeof envelope.page[k] !== 'string' || !envelope.page[k])) || envelope.page.messages?.length > 250 || Buffer.byteLength(canonical(envelope.page)) > 2 * 1024 * 1024)
        throw Error('Invalid or oversized collection envelope');
    return envelope;
}
export const pageIdentity = envelope => digest([envelope.page.sourceId, envelope.epoch, envelope.scopeRevision, envelope.page.pageId]);
export function matchReceipt(envelope, pageDigest, receipt) {
    if (!receipt || receipt.sourceId !== envelope.page.sourceId || receipt.epoch !== envelope.epoch || receipt.scopeRevision !== envelope.scopeRevision || receipt.pageId !== envelope.page.pageId || receipt.pageDigest !== pageDigest || receipt.committedCursor !== envelope.page.nextCursor || !receipt.watermark || !Number.isFinite(Date.parse(receipt.committedAt)))
        throw Error('Receipt does not match exact delivered envelope');
    return receipt;
}
/** Kernel-held loopback listener grants no actions and releases on process death.
 * Avoids stale PID-file races; port collisions fail closed. Scheduler also uses IgnoreNew. */
const instanceDirectories = new Set();
export async function acquireSingleInstance(directory) {
    const port = 40000 + parseInt(digest(resolve(directory)).slice(0, 8), 16) % 20000, server = createServer(socket => socket.destroy());
    await new Promise((ok, no) => {
        server.once('error', () => no(Error('Collector already running or instance lock unavailable')));
        server.listen({
            host: '127.0.0.1', port, exclusive: true
        }, ok);
    });
    instanceDirectories.add(resolve(directory));
    return () => new Promise((ok, no) => server.close(error => {
        instanceDirectories.delete(resolve(directory));
        if (error)
            no(error);
        else
            ok();
    }));
}
export async function openSpool(directory, { maxBytes = 128 * 1024 * 1024, maxEntries = 1000, failpoint } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxEntries) || maxEntries < 1)
        throw Error('Invalid spool limits');
    await privateDirectory(directory);
    const pages = join(directory, 'pages');
    await privateDirectory(pages);
    let sequence = 0;
    try {
        const state = await readPrivateJson(join(directory, 'sequence.json'));
        if (state.version !== 1 || !Number.isSafeInteger(state.value) || state.value < 0)
            throw Error('Corrupt acquisition sequence');
        sequence = state.value;
    }
    catch (e) {
        if (e.code !== 'ENOENT')
            throw e;
    }
    let busy = Promise.resolve();
    const serial = fn => {
        const result = busy.then(fn);
        busy = result.catch(() => {
        });
        return result;
    };
    async function load(id) {
        if (!/^[a-f0-9]{64}$/.test(id))
            throw Error('Invalid spool identity');
        const path = join(pages, id), draft = await readPrivateJson(join(path, 'draft.json'));
        validateEnvelope(draft.envelope);
        if (draft.version !== 1 || !Number.isSafeInteger(draft.acquisitionSequence) || draft.acquisitionSequence < 1 || pageIdentity(draft.envelope) !== id || draft.draftDigest !== digest(draft.envelope))
            throw Error('Corrupt spool draft');
        for (const asset of draft.assets) {
            if (!/^asset-[0-9]+\.bin$/.test(asset.file) || !Number.isSafeInteger(asset.bytes) || asset.bytes < 0 || asset.bytes > 16 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(asset.sha256))
                throw Error('Corrupt spool asset descriptor');
            const bytes = await readPrivateAsset(join(path, asset.file), asset.bytes, asset.sha256);
            if (bytes.length !== asset.bytes || digest(bytes) !== asset.sha256)
                throw Error('Corrupt spool asset');
        }
        let delivery = null, receipt = null;
        try {
            delivery = await readPrivateJson(join(path, 'delivery.json'));
            if (delivery.version !== 1 || delivery.digest !== digest(delivery.envelope) || pageIdentity(delivery.envelope) !== id)
                throw Error('Corrupt spool delivery');
            validateEnvelope(delivery.envelope);
        }
        catch (e) {
            if (e.code !== 'ENOENT')
                throw e;
        }
        try {
            receipt = await readPrivateJson(join(path, 'receipt.json'));
            if (!delivery)
                throw Error('Receipt without locked delivery');
            matchReceipt(delivery.envelope, delivery.digest, receipt);
        }
        catch (e) {
            if (e.code !== 'ENOENT')
                throw e;
        }
        return {
            id, path, ...draft, delivery, receipt
        };
    }
    async function list() {
        const names = await readdir(pages);
        const entries = [];
        for (const name of names.sort()) {
            if (name.startsWith('.tmp-'))
                continue;
            if (!/^[a-f0-9]{64}$/.test(name))
                throw Error('Unknown spool entry; operator review required');
            entries.push(await load(name));
        }
        return entries.sort((a, b) => a.acquisitionSequence - b.acquisitionSequence);
    }
    async function usage() {
        let bytes = 0, entries = 0;
        for (const name of await readdir(directory))
            if (/^(?:sequence|(?:finalized|observed)-[a-f0-9]{64})\.json(?:\.tmp-[a-f0-9-]+)?$/.test(name)) {
                const stat = await lstat(join(directory, name));
                if (!stat.isFile() || stat.isSymbolicLink())
                    throw Error('Unsafe finalized map');
                bytes += stat.size;
            }
        for (const entry of await readdir(pages, { withFileTypes: true })) {
            if (!entry.isDirectory())
                throw Error('Unsafe spool item');
            for (const name of await readdir(join(pages, entry.name))) {
                const stat = await lstat(join(pages, entry.name, name));
                if (!stat.isFile() || stat.isSymbolicLink())
                    throw Error('Unsafe spool item');
                bytes += stat.size;
            }
            entries++;
        }
        return {
            bytes, entries, allocatedBytes: bytes + entries * (2 * 1024 * 1024 + 16384)
        };
    }
    return {
        load, list, usage,
        finalizedAsset(envelope, asset, manifest) {
            return serial(async () => {
                const path = join(directory, 'finalized-' + digest([envelope.page.sourceId, envelope.epoch, envelope.scopeRevision]) + '.json');
                let cache = { version: 1, mapping: {} };
                try {
                    cache = await readPrivateJson(path, 4 * 1024 * 1024);
                    if (cache.version !== 1)
                        throw Error('Corrupt finalized map');
                }
                catch (e) {
                    if (e.code !== 'ENOENT')
                        throw e;
                }
                const key = digest([asset.key, asset.sha256, asset.bytes]), prior = cache.mapping[key];
                if (prior) {
                    if (manifest && canonical(prior) !== canonical(manifest))
                        throw Error('Finalized mapping cannot change');
                    return prior;
                }
                if (!manifest)
                    return null;
                if (Object.keys(cache.mapping).length >= 10000)
                    throw Error('Finalized mapping cache full: acquisition paused');
                const before = Buffer.byteLength(canonical(cache));
                cache.mapping[key] = manifest;
                const after = Buffer.byteLength(canonical(cache)), current = await usage();
                if (after > 4 * 1024 * 1024 || current.allocatedBytes + after - before > maxBytes)
                    throw Error('Spool full: finalized mapping retained');
                await atomicPrivateJson(path, cache);
                return manifest;
            });
        },
        discardFinalizedAssets(envelope, keys) {
            return serial(async () => {
                const path = join(directory, 'finalized-' + digest([envelope.page.sourceId, envelope.epoch, envelope.scopeRevision]) + '.json');
                let cache;
                try { cache = await readPrivateJson(path, 4 * 1024 * 1024); }
                catch (error) { if (error.code === 'ENOENT') return; throw error; }
                if (cache.version !== 1) throw Error('Corrupt finalized map');
                const discarded = new Set(keys);
                for (const [key, manifest] of Object.entries(cache.mapping))
                    if (discarded.has(manifest.key)) delete cache.mapping[key];
                await atomicPrivateJson(path, cache);
            });
        },
        recoverInterrupted() {
            return serial(async () => {
                if (!instanceDirectories.has(resolve(directory)))
                    throw Error('Exclusive collector instance lease required for recovery');
                for (const name of await readdir(directory))
                    if (/^(sequence|(?:finalized|observed)-[a-f0-9]{64})\.json\.tmp-/.test(name))
                        await rm(join(directory, name));
                for (const name of await readdir(pages)) {
                    if (name.startsWith('.tmp-'))
                        await rm(join(pages, name), { recursive: true });
                    else if (/^[a-f0-9]{64}$/.test(name))
                        for (const file of await readdir(join(pages, name)))
                            if (/^(draft|delivery|receipt|uploads)\.json\.tmp-/.test(file))
                                await rm(join(pages, name, file));
                }
                await flushDirectory(pages);
            });
        },
        acquire(envelope, assets) {
            return serial(async () => {
                validateEnvelope(envelope);
                envelope = structuredClone(envelope);
                const observedPath = join(directory, 'observed-' + digest(envelope.page.sourceId) + '.json');
                let observed = {
                    version: 1, messages: {}, gaps: {}
                };
                try {
                    observed = await readPrivateJson(observedPath, 4 * 1024 * 1024);
                    if (observed.version !== 1)
                        throw Error('Corrupt acquisition observation index');
                }
                catch (e) {
                    if (e.code !== 'ENOENT')
                        throw e;
                }
                const beforeObserved = Buffer.byteLength(canonical(observed));
                let changedObserved = false;
                for (const message of envelope.page.messages) {
                    if (typeof message.id !== 'string' || typeof message.revisionDigest !== 'string' || !Number.isFinite(Date.parse(message.observedAt)))
                        throw Error('Immutable message observation missing');
                    const key = digest([message.id, message.revisionDigest]), prior = observed.messages[key];
                    if (prior) {
                        if (prior.role !== message.role || prior.parentNativeMessageId !== message.parentNativeMessageId || prior.nativeMessageId !== message.nativeMessageId || prior.conversationId !== message.conversationId)
                            throw Error('Immutable message core changed; explicit provenance required');
                        message.observedAt = prior.observedAt;
                        message.sequence = prior.sequence;
                    }
                    else {
                        if (Object.keys(observed.messages).length >= 10000)
                            throw Error('Acquisition observation index full');
                        observed.messages[key] = {
                            revisionDigest: message.revisionDigest, observedAt: message.observedAt, sequence: message.sequence ?? 0, role: message.role ?? null, parentNativeMessageId: message.parentNativeMessageId ?? null, nativeMessageId: message.nativeMessageId ?? null, conversationId: message.conversationId ?? null
                        };
                        changedObserved = true;
                    }
                }
                for (const gap of envelope.page.gaps) {
                    if (typeof gap.id !== 'string' || !Number.isFinite(Date.parse(gap.detectedAt)))
                        throw Error('History gap observation missing');
                    observed.gaps ??= {};
                    const prior = observed.gaps[gap.id];
                    if (prior) {
                        if (prior.explanation !== gap.explanation || prior.kind !== gap.kind || prior.conversationId !== gap.conversationId)
                            throw Error('Changed gap requires a new provenance identity');
                        gap.detectedAt = prior.detectedAt;
                    }
                    else {
                        if (Object.keys(observed.gaps).length >= 10000)
                            throw Error('Gap observation index full');
                        observed.gaps[gap.id] = {
                            detectedAt: gap.detectedAt, explanation: gap.explanation, kind: gap.kind, conversationId: gap.conversationId
                        };
                        changedObserved = true;
                    }
                }
                if (changedObserved) {
                    const bytes = Buffer.byteLength(canonical(observed));
                    if (bytes > 4 * 1024 * 1024 || (await usage()).allocatedBytes + bytes - beforeObserved > maxBytes)
                        throw Error('Spool full: acquisition observation index retained');
                    await atomicPrivateJson(observedPath, observed);
                }
                const id = pageIdentity(envelope), path = join(pages, id);
                try {
                    const prior = await load(id);
                    if (prior.draftDigest !== digest(envelope))
                        throw Error('Changed bytes for existing spool identity');
                    return prior;
                }
                catch (e) {
                    if (e.code !== 'ENOENT')
                        throw e;
                }
                const unique = new Map();
                for (const asset of assets) {
                    if (!(asset.content instanceof Uint8Array) || asset.content.length > 16 * 1024 * 1024 || asset.sha256 !== digest(asset.content) || asset.bytes !== asset.content.length || unique.has(asset.key))
                        throw Error('Invalid acquisition asset');
                    unique.set(asset.key, asset);
                }
                for (const manifest of envelope.page.objectManifest) {
                    const asset = unique.get(manifest.key);
                    if (!asset || asset.sha256 !== manifest.sha256 || asset.bytes !== manifest.bytes)
                        throw Error('Acquisition manifest lacks verified local asset');
                }
                if (!Number.isSafeInteger(sequence + 1))
                    throw Error('Acquisition sequence exhausted');
                const draft = {
                    version: 1, acquisitionSequence: sequence + 1, acquiredAt: new Date().toISOString(), envelope, draftDigest: digest(envelope), assets: [...unique.values()].map((a, i) => ({
                        key: a.key, sha256: a.sha256, bytes: a.bytes, file: `asset-${i}.bin`
                    }))
                };
                const current = await usage(), needed = Buffer.byteLength(canonical(draft)) + assets.reduce((n, a) => n + a.bytes, 0) + 65536;
                if (current.entries >= maxEntries || current.allocatedBytes + needed + 2 * 1024 * 1024 > maxBytes)
                    throw Error('Spool full: acquisition paused; catch-up required');
                const temporary = join(pages, '.tmp-' + randomUUID());
                await atomicPrivateJson(join(directory, 'sequence.json'), { version: 1, value: ++sequence });
                await privateDirectory(temporary);
                for (const [i, asset] of assets.entries()) {
                    const handle = await open(join(temporary, `asset-${i}.bin`), 'wx', 0o600);
                    try {
                        await handle.writeFile(asset.content);
                        await handle.sync();
                    }
                    finally {
                        await handle.close();
                    }
                }
                await atomicPrivateJson(join(temporary, 'draft.json'), draft);
                await failpoint?.('before-acquisition-rename');
                await rename(temporary, path);
                await flushDirectory(pages);
                return load(id);
            });
        },
        lockDelivery(id, envelope) {
            return serial(async () => {
                const entry = await load(id);
                validateEnvelope(envelope);
                if (pageIdentity(envelope) !== id)
                    throw Error('Delivery identity changed');
                const value = {
                    version: 1, envelope, digest: digest(envelope)
                };
                if (entry.delivery) {
                    if (entry.delivery.digest !== value.digest)
                        throw Error('Locked delivery cannot change');
                    return entry.delivery;
                }
                await atomicPrivateJson(join(entry.path, 'delivery.json'), value, { beforeRename: () => failpoint?.('before-delivery-rename') });
                return value;
            });
        },
        acknowledge(id, receipt) {
            return serial(async () => {
                const entry = await load(id);
                if (!entry.delivery)
                    throw Error('Delivery not locked');
                matchReceipt(entry.delivery.envelope, entry.delivery.digest, receipt);
                if (entry.receipt && canonical(entry.receipt) !== canonical(receipt))
                    throw Error('Acknowledgement changed');
                await atomicPrivateJson(join(entry.path, 'receipt.json'), receipt);
                return receipt;
            });
        },
        pruneAcknowledged(id, checkpoint) {
            return serial(async () => {
                const entry = await load(id);
                if (!entry.receipt || checkpoint?.pageId !== entry.envelope.page.pageId || checkpoint?.pageDigest !== entry.delivery.digest)
                    throw Error('Durable acknowledged checkpoint required');
                await rm(entry.path, { recursive: true });
                await flushDirectory(pages);
            });
        },
    };
}
