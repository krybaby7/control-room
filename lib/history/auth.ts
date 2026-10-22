import type { SqlDatabase } from '../workspace-store.ts';
import type { PrivateIngressVerifier } from '../devices/contracts.ts';
import { privateIngressBoundaryKey } from '../devices/private-ingress.ts';
import { contentHash, canonical } from '../canonical-json.ts';
import { readHistoryRecord } from './store.ts';
import { z } from 'zod';
export const HISTORY_CREDENTIAL_LIMIT = 64;
export const MAX_HISTORY_CREDENTIAL_LIFETIME_MS = 24 * 60 * 60 * 1000;
const clock = z.string().datetime({ offset: true });
const owner = z.string().min(1).max(256), id = z.string().min(1).max(128);
/** Server-only owner session context. Never construct this from an ingest token,
 * agent/device credential, request body, or caller-supplied owner ID. */
export interface HistoryOwnerEnrollmentContext {
    authenticatedOwnerId: string;
    authorizeOwner(): Promise<boolean>;
}
export interface HistoryIngestPrincipal {
    readonly ownerId: string;
    readonly credentialId: string;
    readonly sourceId: string;
    readonly epoch: string;
    readonly scopeRevision: number;
    readonly executionEpoch: number;
    readonly expiresAt: string;
}
/** Same shape as the object-store guard; adapt params to store.authorityGuard.
 * Recompute using a fresh server clock before each delayed operation. */
export interface HistoryPrincipalGuard {
    sql: string;
    params: (string | number | null)[];
}
export interface HistoryAuthentication {
    principal: HistoryIngestPrincipal;
    guard: HistoryPrincipalGuard;
}
interface CredentialRow {
    user_id: string;
    id: string;
    secret_hash: string;
    source_id: string;
    epoch: string;
    scope_revision: number;
    execution_epoch: number;
    expires_at: string;
    revoked_at: string | null;
}
const credentials = new WeakMap<HistoryIngestPrincipal, string>();
function equalDigest(left: string, right: string): boolean { if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right))
    return false; let difference = 0; for (let i = 0; i < 64; i++)
    difference |= left.charCodeAt(i) ^ right.charCodeAt(i); return difference === 0; }
async function enabledSource(db: SqlDatabase, ownerId: string, sourceId: string) {
    if (!owner.safeParse(ownerId).success || !id.safeParse(sourceId).success)
        return null;
    const stored = await readHistoryRecord(db, ownerId, 'source', sourceId);
    if (!stored || stored.record.value.paused || stored.record.value.removedAt !== null)
        return null;
    if (!id.safeParse(stored.record.value.epoch).success)
        return null;
    const global = (await db.prepare('SELECT epoch FROM workspace_execution_state WHERE user_id=?').bind(ownerId).first<{
        epoch: number;
    }>())?.epoch ?? 0;
    if (!Number.isSafeInteger(global) || global < 0 || stored.record.value.executionEpoch !== global)
        return null;
    return { stored, global };
}
function sourceGuard(ownerId: string, source: NonNullable<Awaited<ReturnType<typeof enabledSource>>>): HistoryPrincipalGuard {
    const { stored, global } = source;
    return { sql: "EXISTS(SELECT 1 FROM project_history hs WHERE hs.user_id=? AND hs.id=? AND hs.row_revision=? AND hs.content_hash=? AND hs.payload_json=? AND COALESCE((SELECT epoch FROM workspace_execution_state WHERE user_id=hs.user_id),0)=?)", params: [ownerId, stored.record.id, stored.rowRevision, stored.contentHash, canonical(stored.record), global] };
}
/** Credentials are separate finite authentication storage, never portable data
 * or private recovery inventory. Only hashes are persisted; restoration's global
 * execution epoch invalidates every prior credential. Enrollment charges an
 * atomic owner-bound hard cap of 64 fixed-size rows, including concurrent calls.
 * Expired/revoked rows can be removed without restoring any authority. */
export async function enrollHistoryIngestCredential(db: SqlDatabase, context: HistoryOwnerEnrollmentContext, input: {
    sourceId: string;
    expiresAt: string;
}, now: string): Promise<{
    credentialId: string;
    token: string;
    expiresAt: string;
}> {
    owner.parse(context.authenticatedOwnerId);
    id.parse(input.sourceId);
    clock.parse(now);
    clock.parse(input.expiresAt);
    const lifetime = Date.parse(input.expiresAt) - Date.parse(now);
    if (lifetime <= 0 || lifetime > MAX_HISTORY_CREDENTIAL_LIFETIME_MS)
        throw Error('History credential lifetime must be positive and at most 24 hours.');
    if (!await context.authorizeOwner())
        throw Error('Authenticated owner enrollment is required.');
    const source = await enabledSource(db, context.authenticatedOwnerId, input.sourceId);
    if (!source)
        throw Error('History source is disabled, stale or unavailable.');
    const random = crypto.getRandomValues(new Uint8Array(32)), token = 'crh_' + Array.from(random, b => b.toString(16).padStart(2, '0')).join(''), secretHash = await contentHash(token), credentialId = crypto.randomUUID();
    const guard = sourceGuard(context.authenticatedOwnerId, source), value = source.stored.record.value, expiresAt = new Date(input.expiresAt).toISOString();
    if (!await context.authorizeOwner())
        throw Error('Authenticated owner enrollment is required.');
    const results = await db.batch([
        db.prepare('DELETE FROM history_ingest_credentials WHERE user_id=? AND (revoked_at IS NOT NULL OR julianday(expires_at)<=julianday(?))').bind(context.authenticatedOwnerId, now),
        db.prepare(`INSERT INTO history_ingest_credentials(user_id,id,secret_hash,source_id,epoch,scope_revision,execution_epoch,expires_at,revoked_at) SELECT ?,?,?,?,?,?,?,?,NULL WHERE (${guard.sql}) AND (SELECT COUNT(*) FROM history_ingest_credentials WHERE user_id=?)<?`).bind(context.authenticatedOwnerId, credentialId, secretHash, input.sourceId, value.epoch, value.scopeRevision, source.global, expiresAt, ...guard.params, context.authenticatedOwnerId, HISTORY_CREDENTIAL_LIMIT),
    ]);
    if (results[1]?.meta.changes !== 1)
        throw Error('History enrollment source changed or credential capacity is full.');
    return {
        credentialId, token, expiresAt
    };
}
/** Only a principal minted by successful ingress + credential authentication can
 * be revalidated. JSON/owner overrides and broad runtime principals fail closed. */
export async function historyAuthorityGuard(db: SqlDatabase, principal: HistoryIngestPrincipal, now: string): Promise<HistoryPrincipalGuard | null> {
    const secretHash = credentials.get(principal);
    if (!secretHash || !clock.safeParse(now).success)
        return null;
    try {
        const row = await db.prepare('SELECT user_id,id,secret_hash,source_id,epoch,scope_revision,execution_epoch,expires_at,revoked_at FROM history_ingest_credentials WHERE user_id=? AND id=?').bind(principal.ownerId, principal.credentialId).first<CredentialRow>();
        if (!row || row.revoked_at !== null || !equalDigest(row.secret_hash, secretHash) || row.source_id !== principal.sourceId || row.epoch !== principal.epoch || row.scope_revision !== principal.scopeRevision || row.execution_epoch !== principal.executionEpoch || row.expires_at !== principal.expiresAt || !clock.safeParse(row.expires_at).success || Date.parse(row.expires_at) <= Date.parse(now) || Date.parse(row.expires_at) - Date.parse(now) > MAX_HISTORY_CREDENTIAL_LIFETIME_MS)
            return null;
        const source = await enabledSource(db, principal.ownerId, principal.sourceId);
        if (!source)
            return null;
        const value = source.stored.record.value;
        if (value.epoch !== principal.epoch || value.scopeRevision !== principal.scopeRevision || source.global !== principal.executionEpoch)
            return null;
        const sourceProof = sourceGuard(principal.ownerId, source);
        const proof: HistoryPrincipalGuard = { sql: `(${sourceProof.sql}) AND EXISTS(SELECT 1 FROM history_ingest_credentials hc WHERE hc.user_id=? AND hc.id=? AND hc.secret_hash=? AND hc.source_id=? AND hc.epoch=? AND hc.scope_revision=? AND hc.execution_epoch=? AND hc.expires_at=? AND hc.revoked_at IS NULL AND julianday(hc.expires_at)>julianday(?))`, params: [...sourceProof.params, principal.ownerId, principal.credentialId, secretHash, principal.sourceId, principal.epoch, principal.scopeRevision, principal.executionEpoch, principal.expiresAt, now] };
        return await db.prepare('SELECT 1 WHERE ' + proof.sql).bind(...proof.params).first() ? proof : null;
    }
    catch {
        return null;
    }
}
/** The deployment's independently verified private ingress is mandatory. There
 * is intentionally no live verifier configured here. Tokens alone, browser
 * cookies, body owner IDs, and caller ingress-verdict headers prove nothing. */
export async function authenticateHistoryIngest(request: Request, db: SqlDatabase, options: {
    now: string;
    privateIngress?: PrivateIngressVerifier;
}): Promise<HistoryAuthentication | null> {
    if (!clock.safeParse(options.now).success || !options.privateIngress || request.headers.has('cookie') || request.headers.has('x-control-room-ingress-verdict') || request.headers.has('x-control-room-service-identity'))
        return null;
    try {
        const verified = await options.privateIngress.verify(request);
        if (!privateIngressBoundaryKey(verified, options.now))
            return null;
        const token = request.headers.get('X-Control-Room-History');
        if (!token || !/^crh_[a-f0-9]{64}$/.test(token))
            return null;
        const secretHash = await contentHash(token), rows = (await db.prepare('SELECT user_id,id,secret_hash,source_id,epoch,scope_revision,execution_epoch,expires_at,revoked_at FROM history_ingest_credentials WHERE secret_hash=? LIMIT 2').bind(secretHash).all<CredentialRow>()).results;
        if (rows.length !== 1 || !equalDigest(rows[0].secret_hash, secretHash))
            return null;
        const row = rows[0];
        const principal: HistoryIngestPrincipal = Object.freeze({
            ownerId: row.user_id, credentialId: row.id, sourceId: row.source_id, epoch: row.epoch, scopeRevision: row.scope_revision, executionEpoch: row.execution_epoch, expiresAt: row.expires_at
        });
        credentials.set(principal, secretHash);
        const guard = await historyAuthorityGuard(db, principal, options.now);
        return guard ? { principal, guard } : null;
    }
    catch {
        return null;
    }
}
/** Owner-only revocation remains available even if the source is paused/stale.
 * Fixed-size revocation timestamps remain within the separate 64-row auth cap. */
export async function revokeHistoryIngestCredential(db:SqlDatabase,context:HistoryOwnerEnrollmentContext,credentialId:string,now:string):Promise<boolean>{
 owner.parse(context.authenticatedOwnerId);id.parse(credentialId);clock.parse(now);
 if(!await context.authorizeOwner())throw Error('Authenticated owner revocation is required.');
 const result=await db.prepare('UPDATE history_ingest_credentials SET revoked_at=? WHERE user_id=? AND id=? AND revoked_at IS NULL').bind(new Date(now).toISOString(),context.authenticatedOwnerId,credentialId).run();
 return result.meta.changes===1;
}
