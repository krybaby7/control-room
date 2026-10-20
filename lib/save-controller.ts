import { readWorkspaceResponse, SessionExpiredError } from './workspace-client.ts';
import type { WorkspaceEnvelope } from './types.ts';

export interface MutationReceipt { mutationId: string; commandHash: string; appliedRevision: number }
export type MutationOutcome =
  | { status: 'committed'; receipt: MutationReceipt; currentRevision: number }
  | { status: 'not-found'; currentRevision: number }
  | { status: 'retired'; retryAllowed: false };
export interface RequestOptions { fetch?: typeof fetch; deadlineMs?: number; session?: SaveSessionGeneration; generation?: number }
export class OutcomeUnknownError extends Error {
  readonly code = 'outcome_unknown';
  constructor() { super('The save outcome is unknown. Check its original mutation before retrying unchanged.'); }
}
export class StaleSessionError extends Error {
  constructor() { super('This response belongs to an earlier session.'); }
}
/** A sign-out or session replacement invalidates every outstanding response. */
export class SaveSessionGeneration {
  private generation = 0;
  capture() { return this.generation; }
  invalidate() { this.generation += 1; }
  isCurrent(generation: number) { return generation === this.generation; }
  assertCurrent(generation: number) { if (!this.isCurrent(generation)) throw new StaleSessionError(); }
}

/** The deadline includes decoding; Promise.race also bounds transports ignoring abort. */
export async function boundedRequest<T>(input: RequestInfo | URL, init: RequestInit, decode: (response: Response) => Promise<T>, options: RequestOptions = {}): Promise<T> {
  const generation = options.generation ?? options.session?.capture();
  const check = () => { if (generation !== undefined) options.session?.assertCurrent(generation); };
  check();
  const controller = new AbortController();
  const deadlineMs = options.deadlineMs ?? 15_000;
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) throw new RangeError('A positive finite deadline is required.');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(new OutcomeUnknownError()); controller.abort(); }, deadlineMs);
  });
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => (options.fetch ?? fetch)(input, { ...init, signal: controller.signal })).then(response => {
        // Never wait for an authentication failure's potentially hanging body.
        if (response.status === 401) throw new SessionExpiredError();
        return decode(response);
      }),
      timeout,
    ]);
    check();
    return result;
  } catch (error) { check(); throw error; } finally { clearTimeout(timer); }
}

/** Obtain an epoch-bound server identity before any draft persistence or command execution. */
export function issueSubmissionId(options: RequestOptions = {}): Promise<string> {
  return boundedRequest('/api/workspace/mutation-ids', {
    method: 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { 'Content-Type': 'application/json' }, body: '{}',
  }, async response => {
    if (!response.ok) throw new Error('A submission ID could not be issued. Try again before saving.');
    const body: unknown = await response.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || !('mutationId' in body) || typeof body.mutationId !== 'string' || !/^m1_[a-f0-9]{32}_[a-f0-9]{32}$/.test(body.mutationId)) throw new Error('The submission ID response was invalid. Try again before saving.');
    return body.mutationId;
  }, options);
}

export function sendCommand(submission: { revision: number; mutationId: string; command: unknown }, options: RequestOptions = {}): Promise<WorkspaceEnvelope> {
  const command=submission.command as {type?:unknown;importId?:unknown}|null;
  const url=command?.type==='workspace.import.commit' && typeof command.importId==='string'?`/api/workspace/imports/${encodeURIComponent(command.importId)}/commit`:'/api/workspace';
  return boundedRequest(url, {
    method: 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(submission),
  }, readWorkspaceResponse, options);
}

export function lookupMutationOutcome(mutationId: string, options: RequestOptions = {}): Promise<MutationOutcome> {
  return boundedRequest(`/api/workspace/mutations/${encodeURIComponent(mutationId)}`, { credentials: 'same-origin', cache: 'no-store' }, async response => {
    const body: unknown = await response.json();
    if (!response.ok || !body || typeof body !== 'object') throw new OutcomeUnknownError();
    const value = body as Record<string, unknown>;
    if (value.status === 'retired' && value.retryAllowed === false) return { status: 'retired', retryAllowed: false };
    if (!Number.isSafeInteger(value.currentRevision) || (value.currentRevision as number) < 0) throw new OutcomeUnknownError();
    if (value.status === 'not-found') return { status: 'not-found', currentRevision: value.currentRevision as number };
    if (value.status === 'committed' && value.receipt && typeof value.receipt === 'object') {
      const receipt = value.receipt as MutationReceipt;
      if (receipt.mutationId === mutationId && typeof receipt.commandHash === 'string' && receipt.commandHash.length > 0 && Number.isSafeInteger(receipt.appliedRevision) && receipt.appliedRevision >= 0 && receipt.appliedRevision <= (value.currentRevision as number)) {
        return { status: 'committed', receipt, currentRevision: value.currentRevision as number };
      }
    }
    throw new OutcomeUnknownError();
  }, options);
}

export interface ReconcileOptions extends RequestOptions {
  backoff?: (attempt: number) => Promise<void>;
  session?: SaveSessionGeneration;
  generation?: number;
}
export type ReconciliationResult = MutationOutcome | { status: 'uncertain' };
/** Reads only: not-found is an observation, never authorization for an automatic retry. */
export async function reconcileSubmission(mutationId: string, options: ReconcileOptions = {}): Promise<ReconciliationResult> {
  const generation = options.generation ?? options.session?.capture();
  const check = () => { if (generation !== undefined) options.session?.assertCurrent(generation); };
  let latest: ReconciliationResult = { status: 'uncertain' };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    check();
    try {
      latest = await lookupMutationOutcome(mutationId, options);
      check();
      if (latest.status === 'committed' || latest.status === 'retired') return latest;
    } catch (error) {
      check();
      if (error instanceof SessionExpiredError || error instanceof StaleSessionError) throw error;
      latest = { status: 'uncertain' };
    }
    if (attempt < 2) {
      await (options.backoff ?? (async (index: number) => { await new Promise(resolve => setTimeout(resolve, 250 * (index + 1))); }))(attempt);
      check();
    }
  }
  return latest;
}
