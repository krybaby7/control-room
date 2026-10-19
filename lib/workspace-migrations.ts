import { currentWeek } from './calendar.ts';
import type { Workspace } from './types.ts';

/** Deterministic legacy migration: the saved timestamp, never today's date, anchors pins. */
export function migratePlanningV1ToV2(source: Workspace, savedAt?: string): Workspace {
  if (source.schemaVersion !== 1) throw new Error('Expected planning schema version 1.');
  return { ...structuredClone(source), schemaVersion: 2, tasks: source.tasks.map(task => ({
    ...structuredClone(task), weeklyWeek: task.weekly ? currentWeek(savedAt ?? task.updatedAt) : null,
    archivedFromStatus: task.status === 'archived' ? (task.completedAt ? 'done' : 'todo') : null,
  })) };
}
export function migratePlanningV2ToV3(source: Workspace): Workspace {
  if (source.schemaVersion !== 2) throw new Error('Expected planning schema version 2.');
  return { ...structuredClone(source), schemaVersion: 3 };
}

/** Only generated null defaults are omitted. Owner content, including empty text, is retained. */
function withoutGeneratedDefaults(workspace:Workspace):unknown {
 const positions=new Map<string,number>();
 return {...workspace,projects:workspace.projects.map(project=>{const {archivedAt,...rest}=project;return archivedAt===null?rest:project;}),milestones:workspace.milestones.map(milestone=>{const next=positions.get(milestone.projectId)??0;positions.set(milestone.projectId,next+1);const copy:Partial<typeof milestone>={...milestone};if(copy.archivedAt===null)delete copy.archivedAt;if(copy.sortKey===next)delete copy.sortKey;return copy;}),tasks:workspace.tasks.map(task=>{const copy:Partial<typeof task>={...task};if(copy.weeklyWeek===null)delete copy.weeklyWeek;if(copy.archivedFromStatus===null)delete copy.archivedFromStatus;if(copy.estimateMinutes===null)delete copy.estimateMinutes;return copy;})};
}
export function compactPlanning(workspace:Workspace):unknown{return withoutGeneratedDefaults(workspace);}
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
export function measurePlanning(workspace: Workspace): { contentBytes: number; serializedBytes: number } {
  // Exclude exactly these generated fields, only at their defined schema locations.
  const compact=withoutGeneratedDefaults(workspace) as Workspace;
  const {schemaVersion:_schemaVersion,...content}=compact;void _schemaVersion;
  const tasks=content.tasks.map(task=>{const {weeklyWeek:_weeklyWeek,archivedFromStatus:_archivedFromStatus,...ownerContent}=task;void _weeklyWeek;void _archivedFromStatus;return ownerContent;});
  return {contentBytes:bytes({...content,tasks}),serializedBytes:bytes(compact)};
}
