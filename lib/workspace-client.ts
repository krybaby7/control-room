import type { WorkspaceEnvelope } from './types';

export class WorkspaceRequestError extends Error {
  readonly status:number;
  readonly diagnostic?:string;
  readonly trusted:boolean;
  constructor(message:string,status:number,diagnostic?:string,trusted=false) {super(message);this.status=status;this.diagnostic=diagnostic;this.trusted=trusted;}
}
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
const conclusiveStatuses = {
  request_invalid: [400,403,413,415],
  command_invalid: [400],
  receipt_capacity: [429],
  private_recovery_capacity: [429],
  revision_conflict: [409],
  module_conflict: [409],
} as const;
export type ConclusiveWorkspaceDiagnostic=keyof typeof conclusiveStatuses;
/** Only authenticated application-shaped rejections with known non-commit semantics settle a save. */
export function isConclusiveWorkspaceRejection(error:unknown):error is WorkspaceRequestError {
  if(!(error instanceof WorkspaceRequestError)||!error.trusted||!error.diagnostic||!Object.hasOwn(conclusiveStatuses,error.diagnostic))return false;
  return (conclusiveStatuses[error.diagnostic as ConclusiveWorkspaceDiagnostic] as readonly number[]).includes(error.status);
}
function appFailure(body:unknown,response:Response):body is {error:string;diagnostic:string;requestId:string} {
  if(!body||typeof body!=='object'||Array.isArray(body))return false;
  const value=body as Record<string,unknown>;
  if(Object.keys(value).length!==3||Object.keys(value).some(key=>!['error','diagnostic','requestId'].includes(key)))return false;
  return typeof value.error==='string'&&value.error.trim().length>0&&value.error.length<=4000
    &&typeof value.diagnostic==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(value.diagnostic)
    &&typeof value.requestId==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.requestId)
    &&response.headers.get('X-Request-Id')===value.requestId;
}
export async function readWorkspaceResponse(response: Response): Promise<WorkspaceEnvelope> {
  if (response.status === 401) throw new SessionExpiredError();
  const body:unknown=await response.json().catch(()=>null);
  if (!response.ok) {
    const trusted=appFailure(body,response);
    const value=body&&typeof body==='object'&&!Array.isArray(body)?body as Record<string,unknown>:null;
    const message=typeof value?.error==='string'&&value.error.trim()?value.error:'Your workspace could not be loaded. Check your connection and try again.';
    throw new WorkspaceRequestError(message,response.status,typeof value?.diagnostic==='string'?value.diagnostic:undefined,trusted);
  }
  const value=body&&typeof body==='object'&&!Array.isArray(body)?body as Partial<WorkspaceEnvelope>:null;
  if (!value?.workspace || typeof value.revision !== 'number' || typeof value.updatedAt !== 'string') throw new Error('The workspace response was incomplete. Your change may have saved; retry the unchanged submission safely.');
  return value as WorkspaceEnvelope;
}
