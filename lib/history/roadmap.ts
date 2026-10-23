import type { Workspace } from '../types.ts';
import type { RoadmapScope } from './contracts.ts';
import { RoadmapScopeSchema } from './validation.ts';
export function validateRoadmapCheckpoints(workspace: Workspace, projectId: string, areaId: string, checkpoints: RoadmapScope['checkpoints']): void {
    if (!workspace.projects.some(p => p.id === projectId))
        throw Error('Project does not exist.');
    if (!workspace.areas?.some(a => a.id === areaId && a.projectId === projectId && a.archivedAt === null))
        throw Error('An active same-project area is required.');
    RoadmapScopeSchema.parse({
        id: 'validate', projectId, areaId, revision: 1, agreedAt: null, checkpoints
    });
    const seen = new Set<string>();
    for (const checkpoint of checkpoints) {
        if (seen.has(checkpoint.id))
            throw Error('Duplicate checkpoint ID.');
        seen.add(checkpoint.id);
        if (!checkpoint.label.trim() || !checkpoint.acceptance.trim())
            throw Error('Checkpoint label and acceptance are required.');
        if (new Set(checkpoint.taskIds).size !== checkpoint.taskIds.length)
            throw Error('Duplicate linked task.');
        for (const taskId of checkpoint.taskIds)
            if (!workspace.tasks.some(t => t.id === taskId && t.projectId === projectId))
                throw Error('Task must belong to the same project.');
        if (checkpoint.milestoneId !== null && !workspace.milestones.some(m => m.id === checkpoint.milestoneId && m.projectId === projectId))
            throw Error('Milestone must belong to the same project.');
    }
}
