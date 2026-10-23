import type { Task } from './types.ts';
const DAY = 86_400_000;
// Reuse fixed formatting configuration; never cache an owner's dates or results.
let cairoDateFormatter: Intl.DateTimeFormat | undefined;
/** Calendar dates in the owner's Cairo timezone; date-only inputs stay date-only. */
export function cairoDate(value: string | Date = new Date()): string {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    if (new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw new Error('Invalid calendar date.');
    return value;
  }
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) throw new Error('Invalid calendar timestamp.');
  return (cairoDateFormatter ??= new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' })).format(instant);
}
export function currentWeek(value: string | Date = new Date()): string {
  const date = new Date(`${cairoDate(value)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  return date.toISOString().slice(0, 10);
}
export function weekRange(value: string | Date = new Date()): { start: string; end: string } {
  const start = currentWeek(value);
  return { start, end: new Date(Date.parse(`${start}T00:00:00Z`) + 6 * DAY).toISOString().slice(0, 10) };
}
export function isCurrentWeek(task: Pick<Task, 'weekly' | 'weeklyWeek'>, value: string | Date = new Date()): boolean {
  return task.weekly && task.weeklyWeek === currentWeek(value);
}
export function isCompletedThisWeek(task: Pick<Task, 'completedAt'>, value: string | Date = new Date()): boolean {
  return task.completedAt !== null && currentWeek(task.completedAt) === currentWeek(value);
}
