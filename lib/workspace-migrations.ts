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
export function compactPlanning(workspace: Workspace): unknown {
  return { ...workspace, tasks: workspace.tasks.map(task => {
    const copy = { ...task };
    if (copy.weeklyWeek === null) delete copy.weeklyWeek;
    if (copy.archivedFromStatus === null) delete copy.archivedFromStatus;
    return copy;
  }) };
}
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
export function measurePlanning(workspace: Workspace): { contentBytes: number; serializedBytes: number } {
  // Exclude exactly these generated fields, only at their defined schema locations.
  const { schemaVersion: _schemaVersion, ...content } = workspace;
  void _schemaVersion;
  const tasks = content.tasks.map(task => {
    const { weeklyWeek: _weeklyWeek, archivedFromStatus: _archivedFromStatus, ...ownerContent } = task;
    void _weeklyWeek; void _archivedFromStatus;
    return ownerContent;
  });
  return { contentBytes: bytes({ ...content, tasks }), serializedBytes: bytes(compactPlanning(workspace)) };
}
