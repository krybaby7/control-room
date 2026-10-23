import type { SourceConfiguration, InventoryMembership } from './contracts.ts';
export { SourceConfigurationSchema, InventoryMembershipSchema } from './validation.ts';
/** Partial sweeps never remove retained records. Only matching generations establish membership. */
export function inventoryMatchesScope(membership: Pick<InventoryMembership, 'sourceId' | 'epoch' | 'scopeRevision' | 'generation'>, scope: Pick<SourceConfiguration, 'sourceId' | 'epoch' | 'scopeRevision'>, generation: string): boolean {
    return membership.sourceId === scope.sourceId && membership.epoch === scope.epoch && membership.scopeRevision === scope.scopeRevision && membership.generation === generation;
}
/** A changed selection always resets cursors and requires a fresh server-issued epoch. */
export function changeSourceScope(current: SourceConfiguration, next: SourceConfiguration): {
    configuration: SourceConfiguration;
    cursor: null;
    inventoryComplete: false;
} {
    if (next.sourceId !== current.sourceId || next.scopeRevision !== current.scopeRevision + 1 || next.epoch === current.epoch)
        throw new Error('Scope change requires next revision and new epoch');
    return { configuration: next, cursor: null, inventoryComplete: false };
}
