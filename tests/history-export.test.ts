import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHistoryBundle } from '../lib/history/export.ts';
test('portable history rejects unversioned authority-bearing input', async () => {
    await assert.rejects(parseHistoryBundle({ bundleVersion: 2, credentials: 'forged' }));
});
import { database } from './helpers/sqlite.ts';
import { createSeedWorkspace } from '../lib/seed.ts';
import { loadWorkspace, readCurrent } from '../lib/workspace-store.ts';
import { ownerReader } from '../lib/workspace-modules.ts';
import { canonical, contentHash } from '../lib/canonical-json.ts';
import { historyRecordId } from '../lib/history/record.ts';
import { stageHistoryObject, readHistoryObject, type PrivateHistoryBucket, type HistoryObjectScope } from '../lib/history/object-store.ts';
import { exportHistoryBundle, prepareHistoryRestore, parseLegacyPlanningHistoryImport, type HistoryExportContext } from '../lib/history/export.ts';
import { getRoadmapState } from '../lib/history/roadmap-store.ts';
const now = '2026-10-22T00:00:00.000Z';
async function fixture() {
    const { db, sqlite } = database(), stored = new Map<string, Uint8Array>();
    let puts = 0;
    let failPut = 0;
    const bucket: PrivateHistoryBucket = {
        async put(key, bytes) { if (++puts === failPut)
            throw Error('Synthetic PUT failure'); stored.set(key, bytes.slice()); }, async get(key, maxBytes) { const bytes = stored.get(key); if (bytes && bytes.length > maxBytes)
            throw Error('Bounded read'); return bytes?.slice() ?? null; }, async delete(key) { stored.delete(key); }
    };
    const objects = {
        db, bucket, authorize: async () => true, now: () => now
    };
    const workspace = createSeedWorkspace(now), projectId = workspace.projects[0].id;
    workspace.areas = [{
            id: 'area', projectId, name: 'Map', aliases: [], order: 0, archivedAt: null
        }];
    await loadWorkspace(db, 'owner-a', () => workspace, now);
    await loadWorkspace(db, 'owner-b', () => workspace, now);
    const planning = (await readCurrent(db, 'owner-a')).workspace;
    const source = {
        id: 'source', configuration: {
            codecVersion: 1, sourceId: 'source', kind: 'codex_local', epoch: 'epoch', scopeRevision: 1, roots: ['private-root'], accountId: 'private-account', deviceId: 'private-device', includeArchived: true, exclusions: ['private-exclusion'], parserVersion: '1', normalizationVersion: '1'
        }, capability: {
            sourceId: 'source', kind: 'codex_local', scopeLabel: 'Selected device', inventory: 'unverified', contentRead: 'unverified', unattendedRead: false, verifiedAt: null, proofRef: null, limitation: null
        }, epoch: 'epoch', scopeRevision: 1, executionEpoch: 0, paused: false, removedAt: null
    };
    async function add(kind: Parameters<typeof historyRecordId>[0], logical: string, value: unknown) { const id = await historyRecordId(kind, logical), record = {
        id, kind, value
    }; sqlite.prepare('INSERT INTO project_history(user_id,id,row_revision,payload_json,content_hash) VALUES(?,?,1,?,?)').run('owner-a', id, canonical(record), await contentHash(canonical(record))); return record; }
    await add('source', 'source', source);
    await add('conversation', 'conversation', {
        id: 'conversation', sourceId: 'source', nativeThreadId: 'native', sessionTreeId: null, parentConversationId: null, title: 'Synthetic', projectId, repositoryIdentity: null, branch: null, createdAt: null, sourceUpdatedAt: null, archived: false, availability: 'complete'
    });
    const scope = {
        ownerId: 'owner-a', sourceId: 'source', epoch: 'epoch', scopeRevision: 1
    };
    const body = new TextEncoder().encode('Synthetic 😀 body'), bodyDigest = await contentHash(body);
    const object = await stageHistoryObject(objects, {
        ...scope, bytes: body, sha256: bodyDigest
    });
    await add('message', 'message', {
        id: 'message', conversationId: 'conversation', nativeMessageId: 'native-message', revisionDigest: bodyDigest, normalizationVersion: '1', parentNativeMessageId: null, sequence: 0, role: 'user', occurredAt: null, observedAt: now, bodyObjectKey: object.key, contentBytes: body.length, availability: 'complete'
    });
    const selection = {
        rawSource: true, messageBodies: true, attachments: true, repositoryEvidence: true, redactedAnalysis: 'not_available' as const
    };
    const context: HistoryExportContext = {
        db, userId: 'owner-a', sourceRevision: 1, query: ownerReader(db, 'owner-a'), objects, selection, async captureSnapshot() { return {
            planning, planningRevision: 1, historyWatermark: '1', sourceWatermarks: { source: '1' }
        }; }, async resolveObject(key) { const row = sqlite.prepare("SELECT source_id,epoch,scope_revision,sha256,bytes FROM history_object_ledger WHERE user_id=? AND key=? AND status='ready'").get('owner-a', key); return row ? { scope: {
                ownerId: 'owner-a', sourceId: String(row.source_id), epoch: String(row.epoch), scopeRevision: Number(row.scope_revision)
            }, manifest: {
                key, sha256: String(row.sha256), bytes: Number(row.bytes)
            } } : null; }
    };
    return {
        db, sqlite, bucket, stored, objects, context, planning, projectId, scope, object, body, add, failAfter(n: number) { failPut = puts + n; }
    };
}
test('bounded portable history deterministically verifies bytes and redacts private selection', async () => {
    const f = await fixture();
    try {
        const first = await exportHistoryBundle(f.context), second = await exportHistoryBundle(f.context);
        assert.deepEqual(first, second);
        assert.equal(first.manifest.completeness, 'included_available_objects');
        assert.match(first.manifest.limitation, /not proof/);
        assert.equal(JSON.stringify(first).includes('private-root'), false);
        assert.equal(JSON.stringify(first).includes('private-account'), false);
        assert.equal(first.objects.length, 1);
        assert.equal((await parseHistoryBundle(first)).manifest.historyWatermark, '1');
        await assert.rejects(exportHistoryBundle({ ...f.context, resolveObject: async (key) => ({ scope: { ...f.scope, ownerId: 'owner-b' }, manifest: { ...f.object, key } }) }), /owner/);
    }
    finally {
        f.sqlite.close();
    }
});
test('same-owner and different-owner restore rekey only verified package bytes without final commit', async () => {
    const f = await fixture();
    try {
        const bundle = await exportHistoryBundle(f.context);
        for (const ownerId of ['owner-a', 'owner-b']) {
            const before = f.sqlite.prepare('SELECT COUNT(*) n FROM project_history WHERE user_id=?').get(ownerId)!.n;
            const proposal = await prepareHistoryRestore(bundle, { ownerId, objects: f.objects });
            assert.equal(proposal.committed, false);
            assert.equal(proposal.transfersOwnerGrants, false);
            const source = proposal.module.records.find(r => (r.value as {
                kind: string;
            }).kind === 'source')!.value as {
                value: {
                    paused: boolean;
                    epoch: string;
                    capability: {
                        unattendedRead: boolean;
                    };
                    configuration: {
                        roots: string[];
                    };
                };
            };
            assert.equal(source.value.paused, true);
            assert.notEqual(source.value.epoch, 'epoch');
            assert.equal(source.value.capability.unattendedRead, false);
            assert.deepEqual(source.value.configuration.roots, []);
            const message = proposal.module.records.find(r => (r.value as {
                kind: string;
            }).kind === 'message')!.value as {
                value: {
                    bodyObjectKey: string;
                };
            };
            assert.notEqual(message.value.bodyObjectKey, f.object.key);
            assert.equal(JSON.stringify(proposal.module).includes(f.object.key), false);
            const staged = proposal.stagedObjects[0], scopeRow = f.sqlite.prepare('SELECT source_id,epoch,scope_revision FROM history_object_ledger WHERE user_id=? AND key=?').get(ownerId, staged.key)!;
            const scope: HistoryObjectScope = {
                ownerId, sourceId: String(scopeRow.source_id), epoch: String(scopeRow.epoch), scopeRevision: Number(scopeRow.scope_revision)
            };
            assert.deepEqual(await readHistoryObject(f.objects, scope, staged), f.body);
            assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM project_history WHERE user_id=?').get(ownerId)!.n, before);
        }
    }
    finally {
        f.sqlite.close();
    }
});
test('tampered body, module and manifest abort before staging', async () => {
    const f = await fixture();
    try {
        const bundle = await exportHistoryBundle(f.context), before = f.sqlite.prepare('SELECT COUNT(*) n FROM history_object_ledger').get()!.n;
        const body = structuredClone(bundle);
        body.objects[0].base64 = btoa('tampered');
        await assert.rejects(prepareHistoryRestore(body, { ownerId: 'owner-b', objects: f.objects }), /digest/);
        const tamperedModule = structuredClone(bundle);
        (tamperedModule.module.records[0].value as {
            value: {
                title?: string;
            };
        }).value.title = 'tampered';
        await assert.rejects(prepareHistoryRestore(tamperedModule, { ownerId: 'owner-b', objects: f.objects }), /digest/);
        const manifest = structuredClone(bundle);
        manifest.manifest.historyWatermark = 'fake';
        await assert.rejects(prepareHistoryRestore(manifest, { ownerId: 'owner-b', objects: f.objects }), /digest/);
        assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM history_object_ledger').get()!.n, before);
    }
    finally {
        f.sqlite.close();
    }
});
test('missing and excluded content stays explicit and restores unavailable', async () => {
    const f = await fixture();
    try {
        const missing = await exportHistoryBundle({ ...f.context, resolveObject: async () => null });
        assert.equal(missing.manifest.completeness, 'partial');
        assert.equal(missing.manifest.objects[0].availability, 'missing');
        const excluded = await exportHistoryBundle({ ...f.context, selection: { ...f.context.selection, messageBodies: false } });
        assert.equal(excluded.objects.length, 0);
        assert.equal(excluded.manifest.objects[0].availability, 'excluded');
        const proposal = await prepareHistoryRestore(excluded, { ownerId: 'owner-b', objects: f.objects });
        const message = proposal.module.records.find(r => (r.value as {
            kind: string;
        }).kind === 'message')!.value as {
            value: {
                availability: string;
                bodyObjectKey: string;
            };
        };
        assert.equal(message.value.availability, 'unavailable');
        assert.notEqual(message.value.bodyObjectKey, f.object.key);
        assert.deepEqual(parseLegacyPlanningHistoryImport(f.planning), f.planning);
    }
    finally {
        f.sqlite.close();
    }
});
test('snapshot changes abort export and partial staging never changes live records', async () => {
    const f = await fixture();
    try {
        const capture = f.context.captureSnapshot;
        let reads = 0;
        await assert.rejects(exportHistoryBundle({ ...f.context, captureSnapshot: async () => ({ ...await capture(), historyWatermark: String(++reads) }) }), /snapshot changed/i);
        const bytes = new TextEncoder().encode('Attachment'), sha256 = await contentHash(bytes), object = await stageHistoryObject(f.objects, {
            ...f.scope, bytes, sha256
        });
        await f.add('attachment', 'attachment', {
            id: 'attachment', messageRevisionId: 'message', nativeAttachmentId: null, name: 'synthetic.txt', mediaType: 'text/plain', sha256, bytes: bytes.length, objectKey: object.key, availability: 'complete', unavailableReason: null
        });
        const bundle = await exportHistoryBundle(f.context), before = f.sqlite.prepare('SELECT COUNT(*) n FROM project_history').get()!.n;
        f.failAfter(2);
        await assert.rejects(prepareHistoryRestore(bundle, { ownerId: 'owner-b', objects: f.objects }), /PUT failure/);
        assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM project_history').get()!.n, before);
        assert.deepEqual(await readHistoryObject(f.objects, f.scope, f.object), f.body);
        assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM history_object_ledger WHERE user_id='owner-b' AND status='ready'").get()!.n, 0);
    }
    finally {
        f.sqlite.close();
    }
});
import { executeWorkspaceCommand } from '../lib/workspace-transaction.ts';
import { workspaceHandlers } from '../lib/workspace-handlers.ts';
import { roadmapScopeId } from '../lib/history/roadmap-store.ts';
import { exportWorkspaceBundle, buildWorkspaceBundle } from '../lib/workspace-export.ts';
import { stageImport } from '../lib/import-staging.ts';
test('verified proposal enters reviewed workspace restore; owner assessments remain historical', async () => {
    const f = await fixture();
    try {
        const scopeId = await roadmapScopeId(f.projectId, 'area');
        let serial = 0;
        const command = async (value: unknown) => executeWorkspaceCommand('owner-a', {
            protocolVersion: 1, expectedRevision: (await readCurrent(f.db, 'owner-a')).revision, mutationId: `history-export-owner-${++serial}-synthetic`, command: value
        }, {
            db: f.db, handlers: workspaceHandlers, now: () => now
        });
        await command({
            type: 'roadmap.set', projectId: f.projectId, areaId: 'area', expectedScopeRevision: null, checkpoints: [{
                    id: 'review', label: 'Review', acceptance: 'Owner reviewed', mandatory: true, milestoneId: null, taskIds: []
                }]
        });
        await command({
            type: 'roadmap.agree', scopeId, expectedScopeRevision: 1
        });
        await command({
            type: 'checkpoint.assess', scopeId, expectedScopeRevision: 1, checkpointId: 'review', verdict: 'accepted', reason: 'Explicit owner review', claimIds: []
        });
        const current = await readCurrent(f.db, 'owner-a'), bundle = await exportHistoryBundle({
            ...f.context, sourceRevision: current.revision, captureSnapshot: async () => ({
                planning: current.workspace, planningRevision: current.revision, historyWatermark: '1', sourceWatermarks: { source: '1' }
            })
        });
        const proposal = await prepareHistoryRestore(bundle, { ownerId: 'owner-b', objects: f.objects });
        const standard = await exportWorkspaceBundle(f.db, 'owner-b', { now: () => now });
        assert.equal(standard.completeness, 'metadata-only');
        const reviewed = await buildWorkspaceBundle({
            planning: proposal.planning, modules: { ...standard.modules, project_history: proposal.module }, workspaceRevision: standard.source.workspaceRevision, operationalWatermarks: standard.source.operationalWatermarks ?? {}, exportedAt: now
        });
        const staged = await stageImport(f.db, 'owner-b', new TextEncoder().encode(JSON.stringify(reviewed)), now);
        assert.deepEqual(staged.diagnostics, []);
        const result = await executeWorkspaceCommand('owner-b', {
            protocolVersion: 1, expectedRevision: 1, mutationId: 'history-package-reviewed-restore-0001', command: {
                type: 'workspace.import.commit', importId: staged.id, hash: staged.hash, targetRevision: 1, mode: 'replace'
            }
        }, {
            db: f.db, handlers: workspaceHandlers, now: () => now
        });
        assert.equal(result.status, 'committed');
        const state = await getRoadmapState(ownerReader(f.db, 'owner-b'), scopeId, async (id, hash) => !!f.sqlite.prepare('SELECT 1 FROM acceptance_owner_grants WHERE user_id=? AND record_id=? AND content_hash=?').get('owner-b', id, hash));
        assert.equal(state.agreed, false);
        assert.equal(state.assessments.length, 0);
        assert.equal(state.historicalAssessments.length, 1);
        const row = f.sqlite.prepare("SELECT payload_json FROM project_history WHERE user_id=? AND json_extract(payload_json,'$.kind')='source'").get('owner-b')!, source = JSON.parse(String(row.payload_json)).value;
        assert.equal(source.paused, true);
        const stagedObject = proposal.stagedObjects[0];
        assert.deepEqual(await readHistoryObject(f.objects, {
            ownerId: 'owner-b', sourceId: 'source', epoch: source.epoch, scopeRevision: source.scopeRevision
        }, stagedObject), f.body);
    }
    finally {
        f.sqlite.close();
    }
});
test('fully rehashed but foreign references still fail before staging; metadata is bounded', async () => {
    const f = await fixture();
    try {
        const bundle = await exportHistoryBundle(f.context), foreign = structuredClone(bundle);
        foreign.module.records = foreign.module.records.filter(r => (r.value as {
            kind: string;
        }).kind !== 'conversation');
        foreign.manifest.moduleHash = await contentHash(canonical(foreign.module));
        foreign.manifestDigest = await contentHash(canonical(foreign.manifest));
        const count = f.sqlite.prepare('SELECT COUNT(*) n FROM history_object_ledger').get()!.n;
        await assert.rejects(prepareHistoryRestore(foreign, { ownerId: 'owner-b', objects: f.objects }), /conversation/i);
        assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM history_object_ledger').get()!.n, count);
        await assert.rejects(exportHistoryBundle({ ...f.context, query: { ...f.context.query, async list() { return [{
                        id: 'oversize', row_revision: 1, payload_json: ' '.repeat(8 * 1024 * 1024 + 1), content_hash: 'a'.repeat(64)
                    }]; } } }), /metadata exceeds/i);
    }
    finally {
        f.sqlite.close();
    }
});
test('message, raw segment, attachment and repository snapshots all retain exact object digests', async () => {
    const f = await fixture();
    try {
        await f.add('segment', 'segment', {
            id: 'segment', sourceId: 'source', conversationId: 'conversation', nativeSegmentId: 'native-segment', inheritedFromSegmentId: null, inheritedRange: null, sha256: f.object.sha256, bytes: f.object.bytes, objectKey: f.object.key, availability: 'complete', unavailableReason: null
        });
        await f.add('attachment', 'attachment', {
            id: 'attachment', messageRevisionId: 'message', nativeAttachmentId: null, name: 'synthetic.txt', mediaType: 'text/plain', sha256: f.object.sha256, bytes: f.object.bytes, objectKey: f.object.key, availability: 'complete', unavailableReason: null
        });
        await f.add('repository_evidence', 'snapshot', {
            id: 'snapshot', repositoryIdentity: 'example/repo', kind: 'check', sourceUrl: 'https://example.invalid/check/1', nativeRecordId: 'check-1', candidate: null, environment: null, conclusion: null, observedAt: now, contentDigest: f.object.sha256, bodyObjectKey: f.object.key, availability: 'complete'
        });
        const bundle = await exportHistoryBundle(f.context);
        assert.equal(bundle.manifest.objects.length, 4);
        assert.equal(bundle.objects.length, 1);
        for (const ref of bundle.manifest.objects) {
            assert.equal(ref.sha256, f.object.sha256);
            assert.equal(ref.bytes, f.object.bytes);
            assert.equal(ref.availability, 'included');
        }
        const proposal = await prepareHistoryRestore(bundle, { ownerId: 'owner-b', objects: f.objects });
        assert.equal(proposal.stagedObjects.length, 1);
        const serialized = JSON.stringify(proposal.module);
        assert.equal(serialized.includes(f.object.key), false);
    }
    finally {
        f.sqlite.close();
    }
});
