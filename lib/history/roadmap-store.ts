import type { CommandHandler, PrepareContext, MutationPlan } from '../workspace-transaction.ts';
import type { OwnerScopedReader, ModuleRow, GuardedWrite } from '../workspace-modules.ts';
import type { JsonValue } from '../workspace-protocol.ts';
import { contentHash, canonical } from '../canonical-json.ts';
import { historyRecordId, parseHistoryRecord, type HistoryRecordValue } from './record.ts';
import type { RoadmapScope, CheckpointAcceptance } from './contracts.ts';
import { RoadmapCommandSchema } from './validation.ts';
import { validateRoadmapCheckpoints } from './roadmap.ts';
export type RoadmapHead = HistoryRecordValue<'roadmap_head'>;
export interface RoadmapState {
    scope: RoadmapScope | null;
    agreed: boolean;
    assessments: CheckpointAcceptance[];
    historicalAssessments: CheckpointAcceptance[];
}
export type TrustRoadmapRecord = (physicalId: string, payloadHash: string) => Promise<boolean>;
export async function roadmapScopeId(projectId: string, areaId: string): Promise<string> {
    return `scope:${await contentHash(canonical({ projectId, areaId }))}`;
}
async function get(query: OwnerScopedReader, kind: 'roadmap_head' | 'roadmap_scope', logicalId: string): Promise<ModuleRow | null> {
    return query.get('project_history', await historyRecordId(kind, logicalId));
}
function headValue(row: ModuleRow): RoadmapHead {
    const record = parseHistoryRecord(JSON.parse(row.payload_json));
    if (record.id !== row.id || record.kind !== 'roadmap_head')
        throw Error('Invalid roadmap head.');
    return record.value;
}
async function scopeValue(query: OwnerScopedReader, head: RoadmapHead): Promise<RoadmapScope> {
    const row = await get(query, 'roadmap_scope', `${head.id}@${head.scopeRevision}`);
    if (!row)
        throw Error('Missing immutable scope revision.');
    const record = parseHistoryRecord(JSON.parse(row.payload_json));
    if (record.id !== row.id || record.kind !== 'roadmap_scope' || record.value.id !== head.id || record.value.revision !== head.scopeRevision || record.value.projectId !== head.projectId || record.value.areaId !== head.areaId)
        throw Error('Scope identity differs.');
    return record.value;
}
/** query and trust must be bound to the same authenticated owner. Imported
 * agreement/assessments remain history until a new owner grant is recorded. */
export async function getRoadmapState(query: OwnerScopedReader, scopeId: string, trust: TrustRoadmapRecord = async () => false): Promise<RoadmapState> {
    const row = await get(query, 'roadmap_head', scopeId);
    if (!row)
        return {
            scope: null, agreed: false, assessments: [], historicalAssessments: []
        };
    const head = headValue(row);
    if (head.id !== scopeId)
        throw Error('Head identity differs.');
    const scope = await scopeValue(query, head);
    const agreed = head.agreedAt !== null && await trust(row.id, await contentHash(canonical(JSON.parse(row.payload_json))));
    const current: CheckpointAcceptance[] = [], historical: CheckpointAcceptance[] = [];
    let after: string | undefined;
    for (;;) {
        const rows = await query.list('project_history', { after, limit: 200 });
        for (const candidate of rows) {
            const record = parseHistoryRecord(JSON.parse(candidate.payload_json));
            if (record.kind !== 'checkpoint_assessment' || record.value.scopeId !== scopeId)
                continue;
            if (record.id !== candidate.id || candidate.id !== await historyRecordId('checkpoint_assessment', record.value.id))
                throw Error('Assessment identity differs.');
            const assessment = record.value;
            if (agreed && assessment.scopeRevision === scope.revision && await trust(candidate.id, await contentHash(canonical(record))))
                current.push(assessment);
            else
                historical.push(assessment);
        }
        if (rows.length < 200)
            break;
        after = rows.at(-1)!.id;
    }
    // Fresh server assessments encode the serialized planning revision in their
    // ID. Wall clocks may tie; immutable insert row_revision is always one.
    const ordered = current.sort((a, b) => a.id.localeCompare(b.id));
    const latest = new Map<string, CheckpointAcceptance>();
    for (const a of ordered) {
        const old = latest.get(a.checkpointId);
        if (old)
            historical.push(old);
        latest.set(a.checkpointId, a);
    }
    return {
        scope: { ...scope, agreedAt: agreed ? head.agreedAt : null }, agreed, assessments: [...latest.values()], historicalAssessments: historical
    };
}
async function write(kind: 'roadmap_head' | 'roadmap_scope' | 'checkpoint_assessment', logicalId: string, value: unknown, row: ModuleRow | null = null): Promise<GuardedWrite> {
    const id = await historyRecordId(kind, logicalId), record = parseHistoryRecord({
        id, kind, value
    });
    return {
        table: 'project_history', operation: row ? 'update' : 'insert', id, value: record as unknown as JsonValue, expectedRowRevision: row?.row_revision ?? null
    };
}
export const roadmapCommandHandler: CommandHandler = { async prepare(ctx: PrepareContext): Promise<MutationPlan> {
        const command = RoadmapCommandSchema.parse(ctx.command), plan: MutationPlan = {
            planningAfter: ctx.before.workspace, writes: [], preconditions: [], events: [], jobs: []
        };
        const scopeId = command.type === 'roadmap.set' ? await roadmapScopeId(command.projectId, command.areaId) : command.scopeId;
        const headRow = await get(ctx.query, 'roadmap_head', scopeId), head = headRow ? headValue(headRow) : null;
        if (head && head.id !== scopeId)
            throw Error('Head identity differs.');
        if (headRow)
            plan.preconditions!.push({
                table: 'project_history', id: headRow.id, expectedRowRevision: headRow.row_revision, expectedHash: headRow.content_hash
            });
        if (command.type === 'roadmap.set') {
            validateRoadmapCheckpoints(ctx.before.workspace, command.projectId, command.areaId, command.checkpoints);
            if ((head?.scopeRevision ?? null) !== command.expectedScopeRevision)
                throw Error('Stale roadmap scope revision.');
            const revision = (head?.scopeRevision ?? 0) + 1, scope: RoadmapScope = {
                id: scopeId, projectId: command.projectId, areaId: command.areaId, revision, agreedAt: null, checkpoints: command.checkpoints
            };
            plan.writes.push(await write('roadmap_scope', `${scopeId}@${revision}`, scope), await write('roadmap_head', scopeId, {
                id: scopeId, projectId: scope.projectId, areaId: scope.areaId, scopeRevision: revision, agreedAt: null
            }, headRow));
        }
        else {
            if (!head || head.scopeRevision !== command.expectedScopeRevision)
                throw Error('Stale or missing roadmap scope revision.');
            const scope = await scopeValue(ctx.query, head);
            validateRoadmapCheckpoints(ctx.before.workspace, scope.projectId, scope.areaId, scope.checkpoints);
            if (command.type === 'roadmap.agree')
                plan.writes.push(await write('roadmap_head', scopeId, { ...head, agreedAt: ctx.now }, headRow));
            else {
                if (!head.agreedAt || !ctx.trustedAcceptanceRecord || !await ctx.trustedAcceptanceRecord(headRow!.id, await contentHash(canonical(JSON.parse(headRow!.payload_json)))))
                    throw Error('Owner must agree current scope before assessment.');
                if (!scope.checkpoints.some(c => c.id === command.checkpointId))
                    throw Error('Checkpoint does not exist in current scope.');
                if (!command.reason.trim())
                    throw Error('Assessment reason is required.');
                if (new Set(command.claimIds).size !== command.claimIds.length)
                    throw Error('Duplicate claim reference.');
                for (const id of command.claimIds) {
                    const row = await ctx.query.get('project_history', await historyRecordId('claim', id));
                    if (!row)
                        throw Error('Claim not found.');
                    const record = parseHistoryRecord(JSON.parse(row.payload_json));
                    if (record.id !== row.id || record.kind !== 'claim' || record.value.id !== id || record.value.projectId !== scope.projectId || record.value.areaId !== scope.areaId)
                        throw Error('Claim must belong to the same project and area.');
                    plan.preconditions!.push({
                        table: 'project_history', id: row.id, expectedRowRevision: row.row_revision, expectedHash: row.content_hash
                    });
                }
                const assessment: CheckpointAcceptance = {
                    id: `assessment:${String(ctx.before.revision + 1).padStart(16, '0')}:${crypto.randomUUID()}`, scopeId, scopeRevision: scope.revision, checkpointId: command.checkpointId, verdict: command.verdict, reason: command.reason, claimIds: command.claimIds, recordedAt: ctx.now
                };
                plan.writes.push(await write('checkpoint_assessment', assessment.id, assessment));
            }
        }
        plan.events.push({
            id: crypto.randomUUID(), kind: command.type, entityType: 'roadmap', entityId: scopeId, changes: plan.writes.map(w => ({
                path: ['project_history', w.id], before: { exists: w.operation === 'update', value: w.operation === 'update' ? JSON.parse(headRow!.payload_json) as JsonValue : null }, after: { exists: true, value: w.value! }
            })), origin: 'owner', actorId: ctx.userId, occurredAt: ctx.now, sourceRef: null, undoOf: null
        });
        return plan;
    } };
export const roadmapCommandHandlers = new Map(['roadmap.set', 'roadmap.agree', 'checkpoint.assess'].map(type => [type, roadmapCommandHandler]));
