import type { Task } from './types.ts';
import { isCompletedThisWeek } from './calendar.ts';

export function weeklyCompletionCount(tasks: Task[], at?: string | Date): number {
  return tasks.filter(task => isCompletedThisWeek(task, at) && (task.status === 'done' || task.status === 'archived' && task.archivedFromStatus === 'done')).length;
}
