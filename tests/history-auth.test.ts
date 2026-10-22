import test from 'node:test';
import assert from 'node:assert/strict';
import { authenticateHistoryIngest } from '../lib/history/auth.ts';
import { database } from './helpers/sqlite.ts';
test('history ingress is closed without an independently verified boundary', async () => {
    const { db, sqlite } = database();
    try {
        assert.equal(await authenticateHistoryIngest(new Request('https://example.invalid/api/history/ingest', { headers: { 'X-Control-Room-History': 'crh_' + 'a'.repeat(64) } }), db, { now: '2026-10-22T00:00:00.000Z' }), null);
    }
    finally {
        sqlite.close();
    }
});
import { enrollHistoryIngestCredential, historyAuthorityGuard, HISTORY_CREDENTIAL_LIMIT } from '../lib/history/auth.ts';
import { canonical, contentHash } from '../lib/canonical-json.ts';
import { historyRecordId } from '../lib/history/record.ts';
import type { PrivateIngressVerifier } from '../lib/devices/contracts.ts';
const now = '2026-10-22T00:00:00.000Z', expiresAt = '2026-10-22T01:00:00.000Z';
// Synthetic trusted dependency only; no production gateway is asserted verified.
const ingress: PrivateIngressVerifier = { async verify() { return { serviceIdentity: 'synthetic-verified-boundary' }; } };
async function fixture() {
    const { db, sqlite } = database();
    const sourceId = 'source', physical = await historyRecordId('source', sourceId);
    const configuration = {
        codecVersion: 1, sourceId, kind: 'codex_local', epoch: 'epoch', scopeRevision: 1, roots: [], accountId: null, deviceId: null, includeArchived: true, exclusions: [], parserVersion: '1', normalizationVersion: '1'
    };
    const source = {
        id: sourceId, configuration, capability: {
            sourceId, kind: 'codex_local', scopeLabel: 'Synthetic', inventory: 'unverified', contentRead: 'unverified', unattendedRead: false, verifiedAt: null, proofRef: null, limitation: null
        }, epoch: 'epoch', scopeRevision: 1, executionEpoch: 0, paused: false, removedAt: null as string | null
    };
    async function writeSource(value = source, ownerId = 'owner-a') { const record = {
        id: physical, kind: 'source', value
    }; sqlite.prepare('INSERT INTO project_history(user_id,id,row_revision,payload_json,content_hash) VALUES(?,?,1,?,?) ON CONFLICT(user_id,id) DO UPDATE SET row_revision=row_revision+1,payload_json=excluded.payload_json,content_hash=excluded.content_hash').run(ownerId, physical, canonical(record), await contentHash(canonical(record))); }
    await writeSource();
    const context = { authenticatedOwnerId: 'owner-a', authorizeOwner: async () => true };
    const request = (token: string, headers: Record<string, string> = {}) => new Request('https://example.invalid/api/history/ingest', { method: 'POST', headers: { 'X-Control-Room-History': token, ...headers } });
    return {
        db, sqlite, source, sourceId, writeSource, context, request, async enroll() { return enrollHistoryIngestCredential(db, context, { sourceId, expiresAt }, now); }
    };
}
test('owner enrollment stores hashes only; tokens cannot override owner or source scope', async () => {
    const f = await fixture();
    try {
        await assert.rejects(enrollHistoryIngestCredential(f.db, { ...f.context, authorizeOwner: async () => false }, { sourceId: f.sourceId, expiresAt }, now), /owner/i);
        await assert.rejects(enrollHistoryIngestCredential(f.db, { ...f.context, authenticatedOwnerId: 'owner-b' }, { sourceId: f.sourceId, expiresAt }, now), /source/i);
        const credential = await f.enroll(), row = f.sqlite.prepare('SELECT * FROM history_ingest_credentials WHERE user_id=?').get('owner-a')!;
        assert.notEqual(row.secret_hash, credential.token);
        assert.equal(row.secret_hash, await contentHash(credential.token));
        assert.equal(JSON.stringify(row).includes(credential.token), false);
        assert.match(credential.token, /^crh_[a-f0-9]{64}$/);
        const result = await authenticateHistoryIngest(f.request(credential.token, { 'X-Control-Room-Owner': 'owner-b' }), f.db, { now, privateIngress: ingress });
        assert.ok(result);
        assert.equal(result.principal.ownerId, 'owner-a');
        assert.equal(result.principal.sourceId, 'source');
        assert.ok(await f.db.prepare('SELECT 1 WHERE ' + result.guard.sql).bind(...result.guard.params).first());
        assert.equal(await historyAuthorityGuard(f.db, { ...result.principal, ownerId: 'owner-b' }, now), null);
        assert.equal(await authenticateHistoryIngest(f.request('crh_' + '0'.repeat(64)), f.db, { now, privateIngress: ingress }), null);
    }
    finally {
        f.sqlite.close();
    }
});
test('independent ingress, finite lifetime and token expiry remain mandatory', async () => {
    const f = await fixture();
    try {
        for (const expiry of [now, '2026-10-23T00:00:00.001Z', 'invalid'])
            await assert.rejects(enrollHistoryIngestCredential(f.db, f.context, { sourceId: f.sourceId, expiresAt: expiry }, now));
        const credential = await f.enroll();
        assert.equal(await authenticateHistoryIngest(f.request(credential.token), f.db, { now }), null);
        assert.equal(await authenticateHistoryIngest(f.request(credential.token), f.db, { now, privateIngress: { async verify() { return null; } } }), null);
        assert.equal(await authenticateHistoryIngest(f.request(credential.token), f.db, { now, privateIngress: { async verify() { throw Error('Ingress unavailable'); } } }), null);
        assert.equal(await authenticateHistoryIngest(f.request(credential.token, { 'Cookie': 'owner=session' }), f.db, { now, privateIngress: ingress }), null);
        assert.equal(await authenticateHistoryIngest(f.request(credential.token, { 'X-Control-Room-Ingress-Verdict': 'trusted' }), f.db, { now, privateIngress: ingress }), null);
        assert.equal(await authenticateHistoryIngest(f.request(credential.token), f.db, { now: expiresAt, privateIngress: ingress }), null);
    }
    finally {
        f.sqlite.close();
    }
});
test('scope, pause, removal, revocation and global epoch invalidate principal guards atomically', async () => {
    const f = await fixture();
    try {
        const credential = await f.enroll(), result = await authenticateHistoryIngest(f.request(credential.token), f.db, { now, privateIngress: ingress });
        assert.ok(result);
        const guardValid = async () => !!await f.db.prepare('SELECT 1 WHERE ' + result.guard.sql).bind(...result.guard.params).first();
        await f.writeSource({ ...f.source, paused: true });
        assert.equal(await historyAuthorityGuard(f.db, result.principal, now), null);
        assert.equal(await guardValid(), false);
        await assert.rejects(f.enroll(), /disabled/i);
        await f.writeSource({ ...f.source, removedAt: now });
        assert.equal(await authenticateHistoryIngest(f.request(credential.token), f.db, { now, privateIngress: ingress }), null);
        await f.writeSource({
            ...f.source, epoch: 'new-epoch', scopeRevision: 2, configuration: {
                ...f.source.configuration, epoch: 'new-epoch', scopeRevision: 2
            }
        });
        assert.equal(await guardValid(), false);
        assert.equal(await historyAuthorityGuard(f.db, result.principal, now), null);
        await f.writeSource();
        f.sqlite.prepare('INSERT INTO workspace_execution_state(user_id,epoch,restored_at) VALUES(?,1,?)').run('owner-a', now);
        assert.equal(await historyAuthorityGuard(f.db, result.principal, now), null);
        assert.equal(await guardValid(), false);
        await assert.rejects(f.enroll(), /stale/i);
        f.sqlite.prepare('UPDATE workspace_execution_state SET epoch=0 WHERE user_id=?').run('owner-a');
        f.sqlite.prepare('UPDATE history_ingest_credentials SET revoked_at=? WHERE user_id=?').run(now, 'owner-a');
        assert.equal(await historyAuthorityGuard(f.db, result.principal, now), null);
    }
    finally {
        f.sqlite.close();
    }
});
test('separate finite authority storage enforces owner cap under concurrent enrollment', async () => {
    const f = await fixture();
    try {
        for (let i = 0; i < HISTORY_CREDENTIAL_LIMIT - 1; i++)
            f.sqlite.prepare('INSERT INTO history_ingest_credentials(user_id,id,secret_hash,source_id,epoch,scope_revision,execution_epoch,expires_at,revoked_at) VALUES(?,?,?,?,?,1,0,?,NULL)').run('owner-a', `synthetic-${i}`, await contentHash(`synthetic-secret-${i}`), 'source', 'epoch', expiresAt);
        const results = await Promise.allSettled([f.enroll(), f.enroll()]);
        assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
        assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM history_ingest_credentials WHERE user_id=?').get('owner-a')!.n, HISTORY_CREDENTIAL_LIMIT);
        await f.writeSource(f.source, 'owner-b');
        assert.ok(await enrollHistoryIngestCredential(f.db, { ...f.context, authenticatedOwnerId: 'owner-b' }, { sourceId: 'source', expiresAt }, now));
        f.sqlite.prepare('UPDATE history_ingest_credentials SET revoked_at=? WHERE user_id=?').run(now, 'owner-a');
        assert.ok(await f.enroll());
        assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM history_ingest_credentials WHERE user_id=?').get('owner-a')!.n, 1);
    }
    finally {
        f.sqlite.close();
    }
});
test('enrollment source CAS rejects a rotation between owner verification and insertion', async () => {
    const f = await fixture();
    try {
        let calls = 0;
        await assert.rejects(enrollHistoryIngestCredential(f.db, { ...f.context, async authorizeOwner() { if (++calls === 2)
                await f.writeSource({ ...f.source, paused: true }); return true; } }, { sourceId: 'source', expiresAt }, now), /source changed/i);
        assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM history_ingest_credentials').get()!.n, 0);
    }
    finally {
        f.sqlite.close();
    }
});
import {revokeHistoryIngestCredential} from '../lib/history/auth.ts';
test('credential revocation is explicit owner-only and idempotent',async()=>{
 const f=await fixture();try{
  const credential=await f.enroll();
  assert.equal(await revokeHistoryIngestCredential(f.db,{...f.context,authenticatedOwnerId:'owner-b'},credential.credentialId,now),false);
  await assert.rejects(revokeHistoryIngestCredential(f.db,{...f.context,authorizeOwner:async()=>false},credential.credentialId,now),/owner/);
  assert.equal(await revokeHistoryIngestCredential(f.db,f.context,credential.credentialId,now),true);
  assert.equal(await revokeHistoryIngestCredential(f.db,f.context,credential.credentialId,now),false);
  assert.equal(await authenticateHistoryIngest(f.request(credential.token),f.db,{now,privateIngress:ingress}),null);
 }finally{f.sqlite.close();}
});
