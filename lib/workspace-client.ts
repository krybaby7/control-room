import type { WorkspaceEnvelope } from './types';

export interface Submission { key: string; mutationId: string; }
export class SessionExpiredError extends Error {
  constructor() { super('Your session has expired. Sign in again to open your private workspace.'); }
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
export function submissionFor(previous: Submission | null, command: unknown, createId = () => crypto.randomUUID()): Submission {
  const key = JSON.stringify(canonical(command));
  return previous?.key === key ? previous : { key, mutationId: createId() };
}
export async function readWorkspaceResponse(response: Response): Promise<WorkspaceEnvelope> {
  if (response.status === 401) throw new SessionExpiredError();
  const body = await response.json().catch(() => null) as (Partial<WorkspaceEnvelope> & { error?: string }) | null;
  if (!response.ok) throw new Error(body?.error ?? 'Your workspace could not be loaded. Check your connection and try again.');
  if (!body?.workspace || typeof body.revision !== 'number' || typeof body.updatedAt !== 'string') throw new Error('The workspace response was incomplete. Your change may have saved; retry the unchanged submission safely.');
  return body as WorkspaceEnvelope;
}
