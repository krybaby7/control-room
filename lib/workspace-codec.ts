import type { Workspace } from './types.ts';
import { compactPlanning } from './workspace-migrations.ts';
import { parseWorkspaceExport, WorkspaceValidationError } from './workspace-validation.ts';
export { measurePlanning } from './workspace-migrations.ts';
export function parsePlanningImport(value: unknown, savedAt?: string): Workspace {
  return parseWorkspaceExport(value, savedAt);
}
export function encodePlanning(workspace: Workspace): string {
  return JSON.stringify(compactPlanning(parsePlanningImport(workspace)));
}
export function decodePlanning(serialized: string, savedAt?: string): Workspace {
  let value: unknown;
  try { value = JSON.parse(serialized); }
  catch { throw new WorkspaceValidationError('Workspace contains invalid JSON.'); }
  return parsePlanningImport(value, savedAt);
}
