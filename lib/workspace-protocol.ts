import type { Workspace, WorkspaceEnvelope } from './types.ts';
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type WorkspaceCommand = { type: string; [key: string]: JsonValue };
export interface CommandEnvelope { protocolVersion: 1; expectedRevision: number; mutationId: string; command: WorkspaceCommand; }
export interface MutationReceipt { mutationId: string; commandHash: string; appliedRevision: number; }
export type CommandResult = { status: 'committed' | 'replayed'; envelope: WorkspaceEnvelope; receipt: MutationReceipt } | { status: 'conflict'; currentRevision: number };
export type MutationOutcome = { status: 'committed'; receipt: MutationReceipt; currentRevision: number } | { status: 'not-found'; currentRevision: number } | { status: 'retired'; retryAllowed: false };
export interface ChangeValue { exists: boolean; value: JsonValue; }
export interface AuditEventDraft { id: string; kind: string; entityType: string; entityId: string | null; changes: Array<{path: string[]; before: ChangeValue; after: ChangeValue}>; origin: 'owner' | 'connector' | 'migration' | 'system'; actorId: string; occurredAt: string; sourceRef: string | null; undoOf: string | null; }
export interface JobIntent { id: string; kind: string; dedupeKey: string; payload: JsonValue; notBefore: string; }
export interface PreparedPlanning { planningAfter: Workspace; }
