import { join } from 'node:path';
import { atomicPrivateJson, readPrivateJson, privateDirectory, digest, matchReceipt } from './spool.mjs';
export async function openCheckpoints(directory, source) {
    await privateDirectory(directory);
    const identity = {
        sourceId: source.sourceId, epoch: source.epoch, scopeRevision: source.scopeRevision
    }, path = join(directory, digest(identity) + '.json');
    let state;
    try {
        state = await readPrivateJson(path);
        if (state.version !== 1 || digest(state.identity) !== digest(identity))
            throw Error('Checkpoint identity changed');
    }
    catch (e) {
        if (e.code !== 'ENOENT')
            throw e;
        state = {
            version: 1, identity, blocked: null, acquired: {
                sequence: 0, cursor: null, pageId: null, draftDigest: null, runId: null, complete: false
            }, acknowledged: {
                sequence: 0, cursor: null, pageId: null, pageDigest: null, receipt: null
            }
        };
    }
    const save = async (next) => {
        await atomicPrivateJson(path, next);
        state = next;
        return structuredClone(state);
    };
    return {
        read: () => structuredClone(state), async beginAcquisition(runId) {
            return save({
                ...state, acquisitionPaused: null, acquired: {
                    ...state.acquired, runId, complete: false
                }
            });
        }, async pauseAcquisition() {
            return save({
                ...state, acquisitionPaused: 'backpressure', acquired: { ...state.acquired, complete: false }
            });
        }, async recover(entries, spool) {
            for (const entry of entries) {
                await this.acquired(entry);
                if (entry.receipt && state.acknowledged.pageId === entry.envelope.page.pageId && state.acknowledged.pageDigest === entry.delivery?.digest)
                    await spool.pruneAcknowledged(entry.id, state.acknowledged);
            }
            return this.read();
        }, async block(code) {
            if (!['credential_or_ingress_denied', 'reconcile_needed'].includes(code))
                throw Error('Invalid source block');
            return save({ ...state, blocked: code });
        }, async clearBlock() {
            return save({ ...state, blocked: null });
        }, async acquired(entry) {
            if (digest({
                sourceId: entry.envelope.page.sourceId, epoch: entry.envelope.epoch, scopeRevision: entry.envelope.scopeRevision
            }) !== digest(identity))
                throw Error('Foreign acquisition checkpoint');
            const page = entry.envelope.page;
            if (entry.acquisitionSequence <= state.acquired.sequence)
                return this.read();
            if (state.acquired.pageId === page.pageId && state.acquired.draftDigest === entry.draftDigest)
                return this.read();
            if (state.acquired.cursor !== page.previousCursor)
                throw Error('Acquisition cursor conflict');
            return save({ ...state, acquired: {
                    sequence: entry.acquisitionSequence, cursor: page.nextCursor, pageId: page.pageId, draftDigest: entry.draftDigest, runId: page.runId, complete: page.inventoryExhausted && page.nextCursor === null
                } });
        }, async acknowledged(entry) {
            if (!entry.delivery || !entry.receipt)
                throw Error('Durable server receipt required');
            const envelope = entry.delivery.envelope;
            matchReceipt(envelope, entry.delivery.digest, entry.receipt);
            if (digest({
                sourceId: envelope.page.sourceId, epoch: envelope.epoch, scopeRevision: envelope.scopeRevision
            }) !== digest(identity))
                throw Error('Foreign acknowledgement checkpoint');
            if (entry.acquisitionSequence <= state.acknowledged.sequence)
                return this.read();
            if (state.acknowledged.pageId === envelope.page.pageId && state.acknowledged.pageDigest === entry.delivery.digest)
                return this.read();
            if (state.acknowledged.cursor !== envelope.page.previousCursor)
                throw Error('Acknowledged cursor conflict');
            return save({ ...state, acknowledged: {
                    sequence: entry.acquisitionSequence, cursor: envelope.page.nextCursor, pageId: envelope.page.pageId, pageDigest: entry.delivery.digest, receipt: entry.receipt
                } });
        }
    };
}
