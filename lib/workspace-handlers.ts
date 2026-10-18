import { backupRemovalHandler } from './backup-removal.ts';
import { entityDeleteHandler } from './workspace-deletion.ts';
import { reviewedImportHandler } from './workspace-import-handler.ts';
import { applyCommand } from './planning.ts';
import type { CommandHandlerRegistry } from './workspace-transaction.ts';
import type { JsonValue } from './workspace-protocol.ts';
const planningCommands = ['baseline.apply','workspace.restore','task.restore','task.create','task.update','milestone.create','milestone.update','project.update','capture.create','capture.update','capture.convert'];
export const workspaceHandlers: CommandHandlerRegistry = new Map(planningCommands.map(type => [type, {
  async prepare(context) {
    const planningAfter = applyCommand(context.before.workspace,context.command,context.now);
    const changes = (['projects','milestones','tasks','captures'] as const).flatMap(collection => {
      const previous = new Map(context.before.workspace[collection].map(row => [row.id,row]));
      const next = new Map(planningAfter[collection].map(row => [row.id,row]));
      return [...new Set([...previous.keys(), ...next.keys()])].filter(id => JSON.stringify(previous.get(id)) !== JSON.stringify(next.get(id))).map(id => ({path:[collection,id], before:{exists:previous.has(id),value:(previous.get(id) ?? null) as unknown as JsonValue},after:{exists:next.has(id),value:(next.get(id) ?? null) as unknown as JsonValue}}));
    });
    return { planningAfter, writes:[], events:[{id:crypto.randomUUID(),kind:type,entityType:type.split('.')[0],entityId:typeof context.command.id === 'string' ? context.command.id : null,changes,origin:'owner' as const,actorId:context.userId,occurredAt:context.now,sourceRef:null,undoOf:null}],jobs:[],...(type === 'workspace.restore' ? {backup:{reason:'restore' as const},restoreEpoch:true} : {}) };
  },
}]));

(workspaceHandlers as Map<string,import('./workspace-transaction.ts').CommandHandler>).set('workspace.backup',{async prepare(context){
 if(Object.keys(context.command).some(key=>key!=='type'))throw new Error('Unsupported backup field.');
 return {planningAfter:context.before.workspace,writes:[],jobs:[],backup:{reason:'manual'},events:[{id:crypto.randomUUID(),kind:'workspace.backup',entityType:'workspace',entityId:null,changes:[],origin:'owner',actorId:context.userId,occurredAt:context.now,sourceRef:null,undoOf:null}]};
}});

(workspaceHandlers as Map<string,import('./workspace-transaction.ts').CommandHandler>).set('workspace.import.commit',reviewedImportHandler);

(workspaceHandlers as Map<string,import('./workspace-transaction.ts').CommandHandler>).set('entity.delete',entityDeleteHandler);

(workspaceHandlers as Map<string,import('./workspace-transaction.ts').CommandHandler>).set('workspace.backup.remove',backupRemovalHandler);
