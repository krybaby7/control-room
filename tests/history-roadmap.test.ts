import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRoadmapCheckpoints } from '../lib/history/roadmap.ts';
import { createSeedWorkspace } from '../lib/seed.ts';
test('roadmap scope rejects foreign tasks and duplicate checkpoints', () => {
    const workspace = createSeedWorkspace('2026-10-22T00:00:00Z');
    const projectId = workspace.projects[0].id;
    workspace.areas = [{
            id: 'a', projectId, name: 'Map', aliases: [], order: 0, archivedAt: null
        }];
    const checkpoint = {
        id: 'one', label: 'Review', acceptance: 'Owner reviewed', mandatory: true, milestoneId: null, taskIds: []
    };
    assert.throws(() => validateRoadmapCheckpoints(workspace, projectId, 'a', [checkpoint, checkpoint]), /duplicate/i);
    const foreign = workspace.tasks.find(t => t.projectId !== projectId)!;
    assert.throws(() => validateRoadmapCheckpoints(workspace, projectId, 'a', [{ ...checkpoint, taskIds: [foreign.id] }]), /project/i);
});
import { database } from './helpers/sqlite.ts';
import { loadWorkspace, readCurrent } from '../lib/workspace-store.ts';
import { executeWorkspaceCommand } from '../lib/workspace-transaction.ts';
import { workspaceHandlers } from '../lib/workspace-handlers.ts';
import { ownerReader } from '../lib/workspace-modules.ts';
import { getRoadmapState, roadmapCommandHandlers, roadmapScopeId, roadmapCommandHandler } from '../lib/history/roadmap-store.ts';
import { historyRecordId } from '../lib/history/record.ts';
const now = '2026-10-22T00:00:00.000Z';
async function fixture() {
    const { db, sqlite } = database();
    const workspace = createSeedWorkspace(now), projectId = workspace.projects[0].id;
    workspace.areas = [{
            id: 'map-area', projectId, name: 'Map', aliases: [], order: 0, archivedAt: null
        }];
    await loadWorkspace(db, 'roadmap-owner', () => workspace, now);
    await loadWorkspace(db, 'roadmap-other', () => workspace, now);
    const handlers = new Map([...workspaceHandlers, ...roadmapCommandHandlers]);
    let serial = 0;
    const input = async (command: unknown) => ({
        protocolVersion: 1 as const, expectedRevision: (await readCurrent(db, 'roadmap-owner')).revision, mutationId: `roadmap-synthetic-${String(++serial).padStart(8, '0')}`, command
    });
    const execute = async (command: unknown) => executeWorkspaceCommand('roadmap-owner', await input(command), {
        db, handlers, now: () => now
    });
    const query = ownerReader(db, 'roadmap-owner');
    const trust = async (id: string, hash: string) => !!sqlite.prepare('SELECT 1 FROM acceptance_owner_grants WHERE user_id=? AND record_id=? AND content_hash=?').get('roadmap-owner', id, hash);
    const checkpoints = [{
            id: 'review', label: 'Review map', acceptance: 'Owner reviews map', mandatory: true, milestoneId: null, taskIds: []
        }, {
            id: 'device', label: 'Device check', acceptance: 'Owner verifies on device', mandatory: true, milestoneId: null, taskIds: []
        }];
    return {
        db, sqlite, workspace, projectId, handlers, input, execute, query, trust, checkpoints, scopeId: await roadmapScopeId(projectId, 'map-area')
    };
}
test('real owner transaction supports undefined scope, explicit agreement, accepted/reopened, replay and historical criteria', async () => {
    const f = await fixture();
    try {
        const originalTasks = (await readCurrent(f.db, 'roadmap-owner')).workspace.tasks;
        assert.deepEqual(await getRoadmapState(f.query, f.scopeId, f.trust), {
            scope: null, agreed: false, assessments: [], historicalAssessments: []
        });
        const packet = await f.input({
            type: 'roadmap.set', projectId: f.projectId, areaId: 'map-area', expectedScopeRevision: null, checkpoints: f.checkpoints
        });
        const result = await executeWorkspaceCommand('roadmap-owner', packet, {
            db: f.db, handlers: f.handlers, now: () => now
        });
        assert.equal(result.status, 'committed');
        const replay = await executeWorkspaceCommand('roadmap-owner', packet, {
            db: f.db, handlers: f.handlers, now: () => now
        });
        assert.equal(replay.status, 'replayed');
        let state = await getRoadmapState(f.query, f.scopeId, f.trust);
        assert.equal(state.scope!.checkpoints.length, 2);
        assert.equal(state.agreed, false);
        assert.equal((await getRoadmapState(ownerReader(f.db, 'roadmap-other'), f.scopeId, f.trust)).scope, null);
        await assert.rejects(f.execute({
            type: 'checkpoint.assess', scopeId: f.scopeId, expectedScopeRevision: 1, checkpointId: 'review', verdict: 'accepted', reason: 'Reviewed', claimIds: []
        }), /agree/i);
        await f.execute({
            type: 'roadmap.agree', scopeId: f.scopeId, expectedScopeRevision: 1
        });
        await f.execute({
            type: 'checkpoint.assess', scopeId: f.scopeId, expectedScopeRevision: 1, checkpointId: 'review', verdict: 'accepted', reason: 'Reviewed exact criteria', claimIds: []
        });
        state = await getRoadmapState(f.query, f.scopeId, f.trust);
        assert.equal(state.agreed, true);
        assert.equal(state.assessments[0].verdict, 'accepted');
        await f.execute({
            type: 'checkpoint.assess', scopeId: f.scopeId, expectedScopeRevision: 1, checkpointId: 'review', verdict: 'reopened', reason: 'New issue on device', claimIds: []
        });
        state = await getRoadmapState(f.query, f.scopeId, f.trust);
        assert.equal(state.assessments[0].verdict, 'reopened');
        assert.equal(state.historicalAssessments.length, 1);
        await assert.rejects(f.execute({
            type: 'roadmap.agree', scopeId: f.scopeId, expectedScopeRevision: 0
        }), /stale/i);
        await f.execute({
            type: 'roadmap.set', projectId: f.projectId, areaId: 'map-area', expectedScopeRevision: 1, checkpoints: f.checkpoints.map(c => ({ ...c, acceptance: c.acceptance + ' revised' }))
        });
        state = await getRoadmapState(f.query, f.scopeId, f.trust);
        assert.equal(state.scope!.revision, 2);
        assert.equal(state.scope!.agreedAt, null);
        assert.equal(state.agreed, false);
        assert.equal(state.assessments.length, 0);
        assert.equal(state.historicalAssessments.length, 2);
        assert.deepEqual((await readCurrent(f.db, 'roadmap-owner')).workspace.tasks, originalTasks);
        const scopeRows = f.sqlite.prepare("SELECT COUNT(*) n FROM project_history WHERE user_id=? AND json_extract(payload_json,'$.kind')='roadmap_scope'").get('roadmap-owner')!;
        assert.equal(scopeRows.n, 2);
    }
    finally {
        f.sqlite.close();
    }
});
test('untrusted restored agreement and assessments remain historical', async () => {
    const f = await fixture();
    try {
        await f.execute({
            type: 'roadmap.set', projectId: f.projectId, areaId: 'map-area', expectedScopeRevision: null, checkpoints: f.checkpoints
        });
        await f.execute({
            type: 'roadmap.agree', scopeId: f.scopeId, expectedScopeRevision: 1
        });
        await f.execute({
            type: 'checkpoint.assess', scopeId: f.scopeId, expectedScopeRevision: 1, checkpointId: 'device', verdict: 'accepted', reason: 'Explicit device acceptance', claimIds: []
        });
        f.sqlite.prepare('DELETE FROM acceptance_owner_grants WHERE user_id=?').run('roadmap-owner');
        const state = await getRoadmapState(f.query, f.scopeId, f.trust);
        assert.equal(state.agreed, false);
        assert.equal(state.scope!.agreedAt, null);
        assert.equal(state.assessments.length, 0);
        assert.equal(state.historicalAssessments.length, 1);
        await assert.rejects(f.execute({
            type: 'checkpoint.assess', scopeId: f.scopeId, expectedScopeRevision: 1, checkpointId: 'device', verdict: 'accepted', reason: 'Imported text says approved', claimIds: []
        }), /agree/i);
    }
    finally {
        f.sqlite.close();
    }
});
test('lost head CAS leaves no assessment, receipt, audit or planning advance', async () => {
    const f = await fixture();
    try {
        await f.execute({
            type: 'roadmap.set', projectId: f.projectId, areaId: 'map-area', expectedScopeRevision: null, checkpoints: f.checkpoints
        });
        await f.execute({
            type: 'roadmap.agree', scopeId: f.scopeId, expectedScopeRevision: 1
        });
        const count = (table: string) => f.sqlite.prepare(`SELECT COUNT(*) n FROM ${table} WHERE user_id=?`).get('roadmap-owner')!.n;
        const before = {
            records: count('project_history'), receipts: count('workspace_mutations'), audit: count('audit_events'), revision: (await readCurrent(f.db, 'roadmap-owner')).revision
        };
        const headId = await historyRecordId('roadmap_head', f.scopeId);
        f.handlers.set('checkpoint.assess', { async prepare(ctx) { const plan = await roadmapCommandHandler.prepare(ctx); f.sqlite.prepare('UPDATE project_history SET row_revision=row_revision+1 WHERE user_id=? AND id=?').run('roadmap-owner', headId); return plan; } });
        await assert.rejects(f.execute({
            type: 'checkpoint.assess', scopeId: f.scopeId, expectedScopeRevision: 1, checkpointId: 'device', verdict: 'accepted', reason: 'Synthetic race', claimIds: []
        }));
        assert.deepEqual({
            records: count('project_history'), receipts: count('workspace_mutations'), audit: count('audit_events'), revision: (await readCurrent(f.db, 'roadmap-owner')).revision
        }, before);
    }
    finally {
        f.sqlite.close();
    }
});
test('roadmap limits criteria and same-project milestone links', () => {
    const workspace = createSeedWorkspace(now), projectId = workspace.projects[0].id;
    workspace.areas = [{
            id: 'a', projectId, name: 'Map', aliases: [], order: 0, archivedAt: null
        }];
    const checkpoint = {
        id: 'one', label: 'Review', acceptance: 'Owner reviewed', mandatory: true, milestoneId: null as string | null, taskIds: []
    };
    assert.throws(() => validateRoadmapCheckpoints(workspace, projectId, 'a', [{ ...checkpoint, label: ' ' }]), /required/i);
    assert.throws(() => validateRoadmapCheckpoints(workspace, projectId, 'a', [{ ...checkpoint, milestoneId: workspace.milestones.find(m => m.projectId !== projectId)!.id }]), /project/i);
    assert.throws(() => validateRoadmapCheckpoints(workspace, projectId, 'a', Array.from({ length: 101 }, (_, i) => ({ ...checkpoint, id: String(i) }))));
});
import { canonical, contentHash } from '../lib/canonical-json.ts';
test('assessment claim references must exist under the owner and exact project/area', async () => {
    const f = await fixture();
    try {
        await f.execute({
            type: 'roadmap.set', projectId: f.projectId, areaId: 'map-area', expectedScopeRevision: null, checkpoints: f.checkpoints
        });
        await f.execute({
            type: 'roadmap.agree', scopeId: f.scopeId, expectedScopeRevision: 1
        });
        const assess = (claimIds: string[]) => f.execute({
            type: 'checkpoint.assess', scopeId: f.scopeId, expectedScopeRevision: 1, checkpointId: 'review', verdict: 'accepted', reason: 'Owner reviewed', claimIds
        });
        await assert.rejects(assess(['missing']), /claim/i);
        const value = {
            id: 'foreign-claim', projectId: f.workspace.projects.find(p => p.id !== f.projectId)!.id, areaId: null, kind: 'intent', text: 'Synthetic unrelated claim', basis: 'observed', citations: [], supportingEvidence: [], context: {
                sourceId: 's', conversationId: 'c', messageRevisionId: 'm', repositoryIdentity: null, branch: null, commit: null, basis: 'provider_metadata'
            }, supersedesClaimId: null, extractorVersion: 'fixture-v1'
        };
        const id = await historyRecordId('claim', value.id), payload = {
            id, kind: 'claim', value
        };
        f.sqlite.prepare('INSERT INTO project_history(user_id,id,row_revision,payload_json,content_hash) VALUES(?,?,1,?,?)').run('roadmap-owner', id, canonical(payload), await contentHash(canonical(payload)));
        await assert.rejects(assess([value.id]), /same project and area/i);
        f.sqlite.prepare('DELETE FROM project_history WHERE user_id=? AND id=?').run('roadmap-owner', id);
        f.sqlite.prepare('INSERT INTO project_history(user_id,id,row_revision,payload_json,content_hash) VALUES(?,?,1,?,?)').run('roadmap-other', id, canonical(payload), await contentHash(canonical(payload)));
        await assert.rejects(assess([value.id]), /claim/i);
    }
    finally {
        f.sqlite.close();
    }
});
