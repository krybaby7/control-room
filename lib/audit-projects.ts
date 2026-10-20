import type {Workspace} from './types.ts';
import type {AuditEventDraft,JsonValue} from './workspace-protocol.ts';
/** Immutable project scopes are derived from both sides of the command, never later live lookups. */
export function auditProjectIds(event:AuditEventDraft,before:Workspace,after:Workspace):string[]{
 const ids=new Set<string>();
 const add=(id:unknown)=>{if(typeof id==='string'&&id.length>0&&id.length<=128)ids.add(id);};
 if(event.entityType==='project')add(event.entityId);
 const visit=(value:JsonValue):void=>{if(Array.isArray(value)){for(const item of value)visit(item);}else if(value&&typeof value==='object')for(const [key,item] of Object.entries(value)){if(key==='projectId')add(item);else visit(item);}};
 for(const change of event.changes){for(const side of [change.before,change.after])if(side.exists){if(change.path.at(-1)==='projectId')add(side.value);visit(side.value);}}
 for(const workspace of [before,after]){
  if(event.entityType==='task')add(workspace.tasks.find(row=>row.id===event.entityId)?.projectId);
  if(event.entityType==='milestone')add(workspace.milestones.find(row=>row.id===event.entityId)?.projectId);
  if(event.entityType==='capture')add(workspace.captures.find(row=>row.id===event.entityId)?.projectId);
 }
 return [...ids].sort();
}
