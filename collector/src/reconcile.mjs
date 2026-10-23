import { open, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
/** Full streamed fingerprint detects edits with preserved mtime/length. Offsets
 * describe physical uncompressed bytes only; compressed input always reopens. */
export async function inspectFile(path, previous, { readerVersion = '1', compressed = false, maxBytes = 512 * 1024 * 1024, signal } = {}) {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes)
        throw Error('Unsupported or oversized source file');
    const handle = await open(path, 'r'), full = createHash('sha256'), prefix = createHash('sha256');
    let offset = 0, lastCompleteOffset = 0;
    const buffer = Buffer.alloc(65536);
    try {
        for (;;) {
            signal?.throwIfAborted();
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
            if (!bytesRead)
                break;
            const chunk = buffer.subarray(0, bytesRead);
            full.update(chunk);
            if (previous && offset < previous.size)
                prefix.update(chunk.subarray(0, Math.min(bytesRead, previous.size - offset)));
            const newline = chunk.lastIndexOf(10);
            if (newline >= 0)
                lastCompleteOffset = offset + newline + 1;
            offset += bytesRead;
            if (offset > maxBytes)
                throw Error('Source changed beyond scan bound');
        }
        const after = await handle.stat();
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
            throw Error('Source changed during fingerprint');
    }
    finally {
        await handle.close();
    }
    return {
        identity: `${stat.dev}:${stat.ino}`, size: offset, sha256: full.digest('hex'), previousPrefixDigest: prefix.digest('hex'), lastCompleteOffset: compressed ? 0 : lastCompleteOffset, readerVersion, compressed
    };
}
export function classifyChange(previous, current) {
    if (!previous)
        return {
            changed: true, reason: 'discovered', from: 0
        };
    if (previous.readerVersion !== current.readerVersion)
        return {
            changed: true, reason: 'reader_changed', from: 0
        };
    if (previous.identity !== current.identity || current.size < previous.size)
        return {
            changed: true, reason: 'replaced_or_truncated', from: 0
        };
    if (previous.sha256 === current.sha256)
        return {
            changed: false, reason: 'unchanged', from: previous.lastCompleteOffset
        };
    if (current.compressed)
        return {
            changed: true, reason: 'compressed_changed', from: 0
        };
    if (current.size > previous.size && current.previousPrefixDigest === previous.sha256)
        return {
            changed: true, reason: 'appended', from: previous.lastCompleteOffset
        };
    return {
        changed: true, reason: 'rewritten', from: 0
    };
}
/** Resumable paged inventory. A partial sweep never deletes retained identities.
 * readChanged must durably spool before resolving; failures preserve its cursor.
 * Every startup/periodic sweep fingerprints, irrespective of watcher hints. */
export function createReconciler({ listPage, inspect, readChanged, readState, writeState, intervalMs = 300000, maxPages = 5, now = Date.now }) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000 || !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100)
        throw Error('Invalid reconcile bounds');
    let dirty = true, running = false;
    return { hint() {
            dirty = true;
        }, async run({ signal, force = false } = {}) {
            if (running)
                throw Error('Reconciliation already running');
            running = true;
            try {
                let state = await readState() ?? {
                    version: 1, cursor: null, files: {}, lastSweepAt: null
                };
                if (state.version !== 1)
                    throw Error('Unknown reconcile state');
                if (!force && !dirty && state.cursor === null && state.lastSweepAt !== null && now() - state.lastSweepAt < intervalMs)
                    return {
                        state, changed: 0, complete: true
                    };
                let changed = 0;
                for (let n = 0; n < maxPages; n++) {
                    signal?.throwIfAborted();
                    const page = await listPage(state.cursor, signal);
                    if (!Array.isArray(page.entries) || page.entries.length > 200 || page.nextCursor !== null && page.nextCursor === state.cursor)
                        throw Error('Invalid inventory continuation');
                    for (const entry of page.entries) {
                        const previous = state.files[entry.id], current = await inspect(entry, previous, signal), change = classifyChange(previous, current);
                        if (change.changed) {
                            await readChanged(entry, change, signal);
                            changed++;
                        }
                        state = { ...state, files: { ...state.files, [entry.id]: current } };
                        if (Object.keys(state.files).length > 10000)
                            throw Error('Reconcile inventory exceeds bound');
                        await writeState(state);
                    }
                    state = {
                        ...state, cursor: page.nextCursor, lastSweepAt: page.nextCursor === null ? now() : state.lastSweepAt
                    };
                    await writeState(state);
                    if (page.nextCursor === null) {
                        dirty = false;
                        return {
                            state, changed, complete: true
                        };
                    }
                }
                return {
                    state, changed, complete: false
                };
            }
            finally {
                running = false;
            }
        } };
}
