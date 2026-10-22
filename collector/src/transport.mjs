import { join } from 'node:path';
import { readPrivateAsset, canonical, digest, matchReceipt, atomicPrivateJson, readPrivateJson } from './spool.mjs';
import { trustedOrigin } from './config.mjs';
import { unavailablePrivateIngress } from './credentials.mjs';
export class HistoryTransportError extends Error {
    constructor(code, { retryAfterMs = 0, uncertain = false } = {}) {
        super(code);
        this.code = code;
        this.retryAfterMs = retryAfterMs;
        this.uncertain = uncertain;
    }
}
export function retryDelay(attempt, { retryAfterMs = 0, random = Math.random } = {}) {
    return Math.min(300000, Math.max(retryAfterMs, Math.floor(Math.min(60000, 1000 * 2 ** Math.min(attempt, 6)) * (0.5 + random() * 0.5))));
}
async function boundedJson(response, maxBytes = 65536) {
    const reader = response.body?.getReader();
    if (!reader)
        throw new HistoryTransportError('invalid_response');
    let length = 0;
    const chunks = [];
    for (;;) {
        const { done, value } = await reader.read();
        if (done)
            break;
        length += value.length;
        if (length > maxBytes) {
            await reader.cancel();
            throw new HistoryTransportError('oversized_response');
        }
        chunks.push(value);
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    catch {
        throw new HistoryTransportError('invalid_response');
    }
}
/** No redirects, cookies, arbitrary endpoints or fallback public ingress. */
export function createTransport({ origin, allowedOrigins, fetchImpl = fetch, credential, privateIngress = unavailablePrivateIngress, timeoutMs = 15000 }) {
    trustedOrigin(origin, allowedOrigins);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
        throw Error('Invalid request timeout');
    async function request(path, envelope, body, contentType, extra = {}, signal) {
        const enrolled = await credential({
            sourceId: envelope.page.sourceId, epoch: envelope.epoch, scopeRevision: envelope.scopeRevision
        });
        if (!enrolled || !/^crh_[a-f0-9]{64}$/.test(enrolled.token) || !Number.isFinite(Date.parse(enrolled.expiresAt)) || Date.parse(enrolled.expiresAt) <= Date.now() || enrolled.sourceId !== envelope.page.sourceId || enrolled.epoch !== envelope.epoch || enrolled.scopeRevision !== envelope.scopeRevision)
            throw new HistoryTransportError('credential_unavailable');
        const ingress = await privateIngress({
            origin, path, signal
        });
        if (!ingress || typeof ingress !== 'object' || !Object.keys(ingress).length)
            throw new HistoryTransportError('private_ingress_not_configured');
        const headers = new Headers(ingress);
        for (const name of ['cookie', 'x-control-room-history', 'x-history-source', 'x-history-epoch', 'x-history-scope-revision', 'host'])
            if (headers.has(name))
                throw new HistoryTransportError('unsafe_ingress_headers');
        headers.set('X-Control-Room-History', enrolled.token);
        headers.set('Content-Type', contentType);
        for (const [key, value] of Object.entries(extra))
            headers.set(key, String(value));
        let response;
        try {
            response = await fetchImpl(origin + path, {
                method: 'POST', headers, body, credentials: 'omit', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
            });
        }
        catch {
            throw new HistoryTransportError('response_unknown', { uncertain: true });
        }
        if (!response.ok) {
            const raw = response.headers.get('Retry-After'), wait = raw ? /^\d+$/.test(raw) ? Number(raw) * 1000 : Math.max(0, Date.parse(raw) - Date.now()) : 0;
            if (path === '/api/history/objects' && [409, 410].includes(response.status)) {
                const detail = await boundedJson(response);
                if (response.status === 409 && detail.diagnostic === 'object_upload_pending' || response.status === 410 && detail.diagnostic === 'object_upload_attempt_failed')
                    throw new HistoryTransportError(detail.diagnostic, { retryAfterMs: Number.isFinite(wait) ? wait : 0 });
            } else await response.body?.cancel();
            throw new HistoryTransportError(response.status === 409 ? 'reconcile_needed' : [401, 403].includes(response.status) ? 'credential_or_ingress_denied' : 'server_unavailable', { retryAfterMs: Number.isFinite(wait) ? wait : 0, uncertain: response.status >= 500 });
        }
        return boundedJson(response, path === '/api/history/ingest' ? 128 * 1024 : 65536);
    }
    return { async deliver(spool, id, { signal } = {}) {
            let entry = await spool.load(id);
            if (entry.receipt)
                return entry.receipt;
            if (!entry.delivery) {
                let uploaded = { version: 1, mapping: {}, attempts: {} };
                try {
                    uploaded = await readPrivateJson(join(entry.path, 'uploads.json'));
                    if (uploaded.version !== 1)
                        throw Error('Invalid upload state');
                }
                catch (e) {
                    if (e.code !== 'ENOENT')
                        throw e;
                }
                uploaded.attempts ??= {};
                if (typeof uploaded.attempts !== 'object' || uploaded.attempts === null || Array.isArray(uploaded.attempts)) throw Error('Invalid upload attempts');
                for (const asset of entry.assets) {
                    const cached = await spool.finalizedAsset(entry.envelope, asset);
                    if (cached) {
                        uploaded.mapping[asset.key] = cached;
                        continue;
                    }
                    if (uploaded.mapping[asset.key]) {
                        await spool.finalizedAsset(entry.envelope, asset, uploaded.mapping[asset.key]);
                        continue;
                    }
                    const content = await readPrivateAsset(join(entry.path, asset.file), asset.bytes, asset.sha256);
                    if (content.length !== asset.bytes || digest(content) !== asset.sha256)
                        throw Error('Corrupt acquisition asset');
                    const attempt = uploaded.attempts[asset.key] ?? 0;
                    if (!Number.isSafeInteger(attempt) || attempt < 0 || attempt >= Number.MAX_SAFE_INTEGER) throw Error('Invalid upload attempt counter');
                    uploaded.attempts[asset.key] = attempt;
                    await atomicPrivateJson(join(entry.path, 'uploads.json'), uploaded);
                    const uploadId = 'upload_' + digest([entry.envelope.page.sourceId, entry.envelope.epoch, entry.envelope.scopeRevision, asset.key, asset.sha256, attempt]);
                    let manifest;
                    try { manifest = await request('/api/history/objects', entry.envelope, content, 'application/octet-stream', {
                        'X-History-Source': entry.envelope.page.sourceId, 'X-History-Epoch': entry.envelope.epoch, 'X-History-Scope-Revision': entry.envelope.scopeRevision, 'X-History-SHA256': asset.sha256, 'X-History-Upload-Id': uploadId
                    }, signal);
                    } catch (error) {
                        if (error instanceof HistoryTransportError && error.code === 'object_upload_attempt_failed') {
                            uploaded.attempts[asset.key] = attempt + 1;
                            await atomicPrivateJson(join(entry.path, 'uploads.json'), uploaded);
                        }
                        throw error;
                    }
                    if (Object.keys(manifest).sort().join(',') !== 'bytes,key,sha256' || !/^history\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/.test(manifest.key) || manifest.sha256 !== asset.sha256 || manifest.bytes !== asset.bytes)
                        throw new HistoryTransportError('finalized_object_mismatch');
                    await spool.finalizedAsset(entry.envelope, asset, manifest);
                    uploaded.mapping[asset.key] = manifest;
                    await atomicPrivateJson(join(entry.path, 'uploads.json'), uploaded);
                }
                const envelope = structuredClone(entry.envelope);
                for (const row of [...envelope.page.messages, ...envelope.page.segments, ...envelope.page.attachments])
                    for (const field of ['bodyObjectKey', 'objectKey'])
                        if (row[field] !== null && uploaded.mapping[row[field]])
                            row[field] = uploaded.mapping[row[field]].key;
                envelope.page.objectManifest = envelope.page.objectManifest.map(o => {
                    const value = uploaded.mapping[o.key];
                    if (!value || value.sha256 !== o.sha256 || value.bytes !== o.bytes)
                        throw Error('Finalized object manifest differs');
                    return value;
                });
                await spool.lockDelivery(id, envelope);
                entry = await spool.load(id);
            }
            const body = canonical(entry.delivery.envelope), value = await request('/api/history/ingest', entry.delivery.envelope, body, 'application/json', {}, signal);
            if (!['receipt', 'discardedObjectKeys,receipt'].includes(Object.keys(value).sort().join(',')))
                throw new HistoryTransportError('invalid_receipt');
            matchReceipt(entry.delivery.envelope, entry.delivery.digest, value.receipt);
            const discarded = value.discardedObjectKeys ?? [];
            const manifestKeys = new Set(entry.delivery.envelope.page.objectManifest.map(item => item.key));
            if (!Array.isArray(discarded) || discarded.length > 1000 || new Set(discarded).size !== discarded.length || discarded.some(key => typeof key !== 'string' || !manifestKeys.has(key)))
                throw new HistoryTransportError('invalid_discarded_objects');
            // Clear before persisting the receipt: interruption safely replays the locked page.
            if (discarded.length) await spool.discardFinalizedAssets(entry.delivery.envelope, discarded);
            await spool.acknowledge(id, value.receipt);
            return value.receipt;
        } };
}
