import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSpool, digest } from '../src/spool.mjs';
import { createTransport, retryDelay } from '../src/transport.mjs';
import { canonicalEnvelopeDigest } from '../../lib/history/validation.ts';
const origin = 'https://example.invalid', serverKey = 'history/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222';
async function setup() {
    const dir = await mkdtemp(join(tmpdir(), 'history-transport-')), spool = await openSpool(dir), content = Buffer.from('Synthetic body'), sha256 = digest(content), asset = {
        key: 'local:test', sha256, bytes: content.length, content
    };
    const envelope = {
        protocolVersion: 1, epoch: 'e', scopeRevision: 1, page: {
            codecVersion: 1, sourceId: 's', runId: 'r', pageId: 'p', previousCursor: null, nextCursor: 'next', inventoryExhausted: false, conversations: [], messages: [{
                    id: 'message', conversationId: 'chat', nativeMessageId: 'native', parentNativeMessageId: null, role: 'user', sequence: 0, revisionDigest: sha256, observedAt: '2026-10-22T00:00:00.000Z', bodyObjectKey: asset.key
                }], segments: [], attachments: [], gaps: [], objectManifest: [{
                    key: asset.key, sha256, bytes: asset.bytes
                }]
        }
    };
    const entry = await spool.acquire(envelope, [asset]);
    return {
        dir, spool, entry, asset
    };
}
const options = {
    origin, allowedOrigins: [origin], credential: async () => ({
        sourceId: 's', epoch: 'e', scopeRevision: 1, token: 'crh_' + 'a'.repeat(64), expiresAt: new Date(Date.now() + 3600000).toISOString()
    }), privateIngress: async () => ({ 'Authorization': 'Synthetic private gateway proof' })
};
function receipt(envelope) {
    return {
        sourceId: 's', epoch: 'e', scopeRevision: 1, pageId: envelope.page.pageId, pageDigest: digest(envelope), committedCursor: envelope.page.nextCursor, watermark: '1', committedAt: '2026-10-22T00:00:00.000Z'
    };
}
test('server object remapping is durable before send; lost response retries byte-identical envelope without reupload', async () => {
    const f = await setup();
    try {
        let uploads = 0;
        const sent = [];
        const sender = createTransport({ ...options, fetchImpl: async (url, input) => {
                assert.equal(input.redirect, 'error');
                assert.equal(input.credentials, 'omit');
                if (url.endsWith('/objects')) {
                    uploads++;
                    return Response.json({
                        key: serverKey, sha256: f.asset.sha256, bytes: f.asset.bytes
                    });
                }
                const envelope = JSON.parse(input.body);
                assert.equal(envelope.page.messages[0].bodyObjectKey, serverKey);
                assert.equal((await f.spool.load(f.entry.id)).delivery.digest, digest(envelope));
                assert.equal(await canonicalEnvelopeDigest(envelope), digest(envelope));
                sent.push(input.body);
                if (sent.length === 1)
                    throw Error('response lost after commit');
                return Response.json({ receipt: receipt(envelope) });
            } });
        await assert.rejects(sender.deliver(f.spool, f.entry.id), /response_unknown/);
        assert.equal((await f.spool.load(f.entry.id)).receipt, null);
        await sender.deliver(await openSpool(f.dir), f.entry.id);
        assert.equal(uploads, 1);
        assert.equal(sent.length, 2);
        assert.equal(sent[0], sent[1]);
        assert.ok((await f.spool.load(f.entry.id)).receipt);
    }
    finally {
        await rm(f.dir, { recursive: true, force: true });
    }
});
test('unconfigured ingress, foreign credential, mismatched finalized object and wrong receipt fail closed', async () => {
    const f = await setup();
    try {
        let calls = 0;
        const fetchImpl = async () => {
            calls++;
            return Response.json({
                key: serverKey, sha256: 'b'.repeat(64), bytes: f.asset.bytes
            });
        };
        await assert.rejects(createTransport({
            ...options, privateIngress: undefined, fetchImpl
        }).deliver(f.spool, f.entry.id), /private_ingress/);
        assert.equal(calls, 0);
        await assert.rejects(createTransport({
            ...options, credential: async () => ({ ...await options.credential(), sourceId: 'foreign' }), fetchImpl
        }).deliver(f.spool, f.entry.id), /credential/);
        assert.equal(calls, 0);
        await assert.rejects(createTransport({ ...options, fetchImpl }).deliver(f.spool, f.entry.id), /mismatch/);
        assert.equal((await f.spool.load(f.entry.id)).delivery, null);
        assert.throws(() => createTransport({ ...options, origin: 'http://example.invalid' }), /origin/);
        assert.ok(retryDelay(3, { random: () => 0, retryAfterMs: 20000 }) >= 20000);
    }
    finally {
        await rm(f.dir, { recursive: true, force: true });
    }
});
test('finalized server keys persist across pages/runs and first immutable metadata is retained', async () => {
    const f = await setup();
    try {
        let uploads = 0;
        const sent = [];
        const sender = createTransport({ ...options, fetchImpl: async (url, input) => {
                if (url.endsWith('/objects')) {
                    uploads++;
                    return Response.json({
                        key: serverKey, sha256: f.asset.sha256, bytes: f.asset.bytes
                    });
                }
                const envelope = JSON.parse(input.body);
                sent.push(envelope);
                return Response.json({ receipt: receipt(envelope) });
            } });
        await sender.deliver(f.spool, f.entry.id);
        const next = structuredClone(f.entry.envelope);
        next.page.pageId = 'p2';
        next.page.runId = 'r2';
        next.page.previousCursor = 'next';
        next.page.nextCursor = null;
        next.page.messages[0].observedAt = '2026-10-22T12:00:00.000Z';
        next.page.messages[0].sequence = 99;
        const second = await (await openSpool(f.dir)).acquire(next, [f.asset]);
        await sender.deliver(await openSpool(f.dir), second.id);
        assert.equal(uploads, 1);
        assert.equal(sent[0].page.messages[0].bodyObjectKey, sent[1].page.messages[0].bodyObjectKey);
        assert.equal(sent[0].page.messages[0].observedAt, sent[1].page.messages[0].observedAt);
        assert.equal(sent[0].page.messages[0].sequence, sent[1].page.messages[0].sequence);
    }
    finally {
        await rm(f.dir, { recursive: true, force: true });
    }
});
test('crash after finalized upload but before delivery rename cannot send or change page on recovery', async () => {
    const f = await setup();
    try {
        let uploads = 0, sends = 0, crash = true;
        const spool = await openSpool(f.dir, { failpoint: async (stage) => {
                if (stage === 'before-delivery-rename' && crash) {
                    crash = false;
                    throw Error('crash before resolved-envelope rename');
                }
            } }), sender = createTransport({ ...options, fetchImpl: async (url, input) => {
                if (url.endsWith('/objects')) {
                    uploads++;
                    return Response.json({
                        key: serverKey, sha256: f.asset.sha256, bytes: f.asset.bytes
                    });
                }
                sends++;
                return Response.json({ receipt: receipt(JSON.parse(input.body)) });
            } });
        await assert.rejects(sender.deliver(spool, f.entry.id), /crash/);
        assert.equal(sends, 0);
        await sender.deliver(await openSpool(f.dir), f.entry.id);
        assert.equal(uploads, 1);
        assert.equal(sends, 1);
    }
    finally {
        await rm(f.dir, { recursive: true, force: true });
    }
});

test('asset replacement after draft verification is rejected before any network send', async () => {
    const f = await setup();
    const outside = await mkdtemp(join(tmpdir(), 'history-outside-'));
    try {
        const { writeFile, symlink } = await import('node:fs/promises');
        const target = join(outside, 'private-body');
        await writeFile(target, f.asset.content, { mode: 0o600 });
        let calls = 0, replaced = false;
        const spool = new Proxy(f.spool, { get(object, key) {
            if (key !== 'load') return object[key];
            return async id => {
                const entry = await object.load(id);
                if (!replaced) {
                    replaced = true;
                    const path = join(entry.path, entry.assets[0].file);
                    await rm(path);
                    await symlink(target, path);
                }
                return entry;
            };
        } });
        const sender = createTransport({ ...options, fetchImpl: async () => { calls++; throw Error('unexpected network'); } });
        await assert.rejects(sender.deliver(spool, f.entry.id), /private|asset|file/i);
        assert.equal(calls, 0);
        await assert.rejects(f.spool.load(f.entry.id), /private|asset|file/i);
    } finally {
        await rm(f.dir, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
    }
});

test('lost upload response retries the persisted upload ID; only settled failed attempts rotate it', async () => {
    const f = await setup();
    try {
        const ids = [];
        let attempt = 0;
        const sender = createTransport({ ...options, fetchImpl: async (url, input) => {
            if (!url.endsWith('/objects')) return Response.json({ receipt: receipt(JSON.parse(input.body)) });
            const id = input.headers.get('X-History-Upload-Id');
            assert.match(id ?? '', /^upload_[a-f0-9]{64}$/);
            ids.push(id);
            attempt++;
            if (attempt === 1) throw Error('lost upload response');
            if (attempt === 2) return Response.json({diagnostic:'object_upload_pending'}, {status:409});
            if (attempt === 3) return Response.json({diagnostic:'object_upload_attempt_failed'}, {status:410});
            return Response.json({key:serverKey,sha256:f.asset.sha256,bytes:f.asset.bytes});
        } });
        await assert.rejects(sender.deliver(f.spool, f.entry.id), /response_unknown/);
        await assert.rejects(sender.deliver(await openSpool(f.dir), f.entry.id), /object_upload_pending/);
        await assert.rejects(sender.deliver(await openSpool(f.dir), f.entry.id), /object_upload_attempt_failed/);
        await sender.deliver(await openSpool(f.dir), f.entry.id);
        assert.equal(ids[0],ids[1]);
        assert.equal(ids[1],ids[2]);
        assert.notEqual(ids[2],ids[3]);
    } finally { await rm(f.dir, {recursive:true,force:true}); }
});

test('verified discarded keys clear only matching finalized cache without changing the locked receipt or envelope', async () => {
    const f = await setup();
    try {
        const other = {...f.asset,key:'local:other'};
        const otherKey = serverKey.replace(/22222222/g,'33333333');
        await f.spool.finalizedAsset(f.entry.envelope,other,{key:otherKey,sha256:f.asset.sha256,bytes:f.asset.bytes});
        let body;
        const sender = createTransport({...options,fetchImpl:async(url,input)=> {
            if(url.endsWith('/objects')) return Response.json({key:serverKey,sha256:f.asset.sha256,bytes:f.asset.bytes});
            body=input.body;
            return Response.json({receipt:receipt(JSON.parse(body)),discardedObjectKeys:[serverKey]});
        }});
        await sender.deliver(f.spool,f.entry.id);
        assert.equal(await f.spool.finalizedAsset(f.entry.envelope,f.asset),null);
        assert.equal((await f.spool.finalizedAsset(f.entry.envelope,other)).key,otherKey);
        const saved=await f.spool.load(f.entry.id);
        assert.deepEqual(saved.receipt,receipt(JSON.parse(body)));
        assert.equal(digest(saved.delivery.envelope),digest(JSON.parse(body)));
    } finally {await rm(f.dir,{recursive:true,force:true});}
});

test('foreign discard keys reject the response before acknowledging or clearing valid cache', async()=>{
    const f=await setup();
    try{
        const sender=createTransport({...options,fetchImpl:async(url,input)=>url.endsWith('/objects')?
            Response.json({key:serverKey,sha256:f.asset.sha256,bytes:f.asset.bytes}):
            Response.json({receipt:receipt(JSON.parse(input.body)),discardedObjectKeys:['foreign']})});
        await assert.rejects(sender.deliver(f.spool,f.entry.id),/invalid_discarded_objects/);
        assert.equal((await f.spool.load(f.entry.id)).receipt,null);
        assert.equal((await f.spool.finalizedAsset(f.entry.envelope,f.asset)).key,serverKey);
    }finally{await rm(f.dir,{recursive:true,force:true});}
});
test('later pages reusing discarded assets have independent upload identities without walking earlier failed attempts',async()=>{
    const f=await setup();
    try{
        const states=new Map(),uploadIds=[],counts={uploads:0,metadata:0};
        const sender=createTransport({...options,fetchImpl:async(url,input)=>{
            if(url.endsWith('/objects')){
                counts.uploads++;
                const id=input.headers.get('X-History-Upload-Id');uploadIds.push(id);
                const prior=states.get(id);
                if(prior?.abandoned)return Response.json({diagnostic:'object_upload_attempt_failed'},{status:410});
                const manifest=prior?.manifest??{key:`history/${crypto.randomUUID()}/${crypto.randomUUID()}`,sha256:f.asset.sha256,bytes:f.asset.bytes};
                states.set(id,{manifest,abandoned:false});return Response.json(manifest);
            }
            counts.metadata++;
            const envelope=JSON.parse(input.body),keys=envelope.page.objectManifest.map(row=>row.key);
            for(const state of states.values())if(keys.includes(state.manifest.key))state.abandoned=true;
            return Response.json({receipt:receipt(envelope),discardedObjectKeys:keys});
        }});
        for(let index=0;index<3;index++){
            const spool=await openSpool(f.dir),envelope=structuredClone(f.entry.envelope);
            envelope.page.pageId=index===0?f.entry.envelope.page.pageId:'repeated-discard-'+index;
            envelope.page.previousCursor=index===0?null:index===1?'next':'continuation-'+(index-1);
            envelope.page.nextCursor=index===2?null:index===0?'next':'continuation-'+index;
            envelope.page.inventoryExhausted=index===2;
            const entry=index===0?await spool.load(f.entry.id):await spool.acquire(envelope,[f.asset]);
            await sender.deliver(spool,entry.id);
            assert.ok((await spool.load(entry.id)).receipt);
            assert.equal(await spool.finalizedAsset(envelope,f.asset),null);
        }
        assert.deepEqual(counts,{uploads:3,metadata:3});assert.equal(new Set(uploadIds).size,3);
    }finally{await rm(f.dir,{recursive:true,force:true});}
});
