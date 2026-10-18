import {z} from 'zod';
import type {Workspace} from './types.ts';
import type {MutationPlan,PrepareContext} from './workspace-transaction.ts';
import {parseAuditEvent,topLevelChanges,type AuditEventDraft,type FieldChange,type ChangeValue,type JsonValue} from './audit-events.ts';
import {canonical} from './canonical-json.ts';
import {parseWorkspaceExport} from './workspace-validation.ts';
import {validateTaskGraph} from './task-graph.ts';
import {syncLegacyWeeklyPins} from './planning-module.ts';
type Collection='projects'|'milestones'|'tasks'|'captures';
const collections:Record<string,Collection>={project:'projects',milestone:'milestones',task:'tasks',capture:'captures'};
const allowedKinds=new Set(['project.update','project.edit','project.archive','project.restore','milestone.update','milestone.archive','milestone.restore','milestone.reorder','task.update','task.restore','task.move','task.bulk','capture.update','capture.bulk','history.undo']);
const mutable:Record<Collection,ReadonlySet<string>>={projects:new Set(['name','description','goal','color','repositories','archivedAt']),milestones:new Set(['title','description','acceptance','status','targetDate','evidence','archivedAt','sortKey']),tasks:new Set(['estimateMinutes','projectId','milestoneId','title','notes','status','horizon','priority','dueDate','weekly','dependsOn','blocker','sourceUrl','evidence']),captures:new Set(['title','body','projectId','kind','sourceUrl','status'])};
const taskLifecycle=new Set(['completedAt','archivedFromStatus','weeklyWeek']);
function record(value:JsonValue):Record<string,JsonValue>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Undo requires a recorded planning object.');return value;}
function at(value:Record<string,JsonValue>,field:string):ChangeValue{return Object.hasOwn(value,field)?{exists:true,value:value[field]}:{exists:false,value:null};}
function validateField(field:string):void {if(!field||['__proto__','prototype','constructor'].includes(field))throw new Error('Invalid undo field.');}
/** Single-field inverse primitive; arrays remain atomic and comparison ignores nested key order. */
export function assertUndoMatches(entity:Record<string,JsonValue>,changes:readonly FieldChange[]):void {for(const change of changes){if(change.path.length!==1)throw new Error('Unsupported undo field path.');const field=change.path[0];validateField(field);if(canonical(at(entity,field))!==canonical(change.after))throw new Error(`Cannot undo: ${field} changed after this action.`);}}
export function applyInverse(entity:Record<string,JsonValue>,changes:readonly FieldChange[]):Record<string,JsonValue>{assertUndoMatches(entity,changes);const next=structuredClone(entity);const seen=new Set<string>();for(const change of changes){const field=change.path[0];if(seen.has(field))throw new Error('Duplicate undo field.');seen.add(field);if(change.before.exists)next[field]=structuredClone(change.before.value);else delete next[field];}return next;}
interface Target {collection:Collection;id:string;changes:FieldChange[];}
function targetPath(event:AuditEventDraft,path:string[]):{collection:Collection;id:string;field?:string}{
 if(path.length===1){const collection=collections[event.entityType];if(!collection||!event.entityId)throw new Error('Undo field lacks an exact planning entity.');return {collection,id:event.entityId,field:path[0]};}
 if(path.length<2||path.length>3||!['projects','milestones','tasks','captures'].includes(path[0]))throw new Error('Unsupported planning undo path.');return {collection:path[0] as Collection,id:path[1],...(path.length===3?{field:path[2]}:{})};
}
function expand(event:AuditEventDraft):Target[]{
 const targets=new Map<string,Target>();const seen=new Set<string>();
 for(const change of event.changes){const selected=targetPath(event,change.path),expected=collections[event.kind.split('.')[0]];if(expected&&selected.collection!==expected)throw new Error('Undo event crosses its command domain.');const key=canonical([selected.collection,selected.id]);let target=targets.get(key);if(!target){target={...selected,changes:[]};targets.set(key,target);}let fields:FieldChange[];
  if(selected.field){validateField(selected.field);fields=[{...change,path:[selected.field]}];}
  else {if(!change.before.exists||!change.after.exists)throw new Error('Create/delete undo requires a full reference-guarded recovery workflow.');const before=record(change.before.value),after=record(change.after.value);if(before.id!==selected.id||after.id!==selected.id)throw new Error('Audited entity identity differs.');fields=topLevelChanges(before,after);}
  for(const field of fields){const name=field.path[0],identity=canonical([selected.collection,selected.id,name]);if(seen.has(identity))throw new Error('Overlapping undo field paths.');seen.add(identity);if(name==='updatedAt'&&(selected.collection==='tasks'||selected.collection==='milestones'))continue;if(!mutable[selected.collection].has(name)&&!(selected.collection==='tasks'&&taskLifecycle.has(name)))throw new Error(`Undo cannot alter ${name}.`);target.changes.push(field);}
 }
 for(const target of targets.values())if(target.collection==='tasks'){const fields=new Set(target.changes.map(change=>change.path[0]));if((fields.has('completedAt')||fields.has('archivedFromStatus'))&&!fields.has('status'))throw new Error('Completion metadata requires its audited lifecycle transition.');}
 return [...targets.values()];
}
function validateNewAssignments(before:Workspace,after:Workspace):void {
 const existing=new Map(before.tasks.map(task=>[task.id,task]));for(const task of after.tasks){const previous=existing.get(task.id)!;if(task.projectId!==previous.projectId||task.milestoneId!==previous.milestoneId){const project=after.projects.find(row=>row.id===task.projectId);if(!project||project.archivedAt)throw new Error('Undo cannot assign work to an archived project.');if(task.milestoneId!==null){const milestone=after.milestones.find(row=>row.id===task.milestoneId&&row.projectId===task.projectId);if(!milestone||milestone.archivedAt)throw new Error('Undo cannot assign work to an archived milestone.');}}}
 const captures=new Map(before.captures.map(capture=>[capture.id,capture]));for(const capture of after.captures){const previous=captures.get(capture.id)!;if(capture.projectId!==previous.projectId&&capture.projectId!==null&&after.projects.find(project=>project.id===capture.projectId)?.archivedAt)throw new Error('Undo cannot assign a capture to an archived project.');}
}
export interface PlanningUndoPreview {planningAfter:Workspace;changes:FieldChange[];}
/** Read-only planning edit inverse. Creation/deletion, normalized modules and external effects are intentionally unsupported. */
export function previewPlanningUndo(workspace:Workspace,value:unknown,now:string):PlanningUndoPreview {
 const event=parseAuditEvent(value);z.string().datetime({offset:true}).parse(now);if(event.origin!=='owner'||!allowedKinds.has(event.kind))throw new Error('This event requires a specialized recovery workflow and cannot be undone as a planning edit.');if(Date.parse(event.occurredAt)>Date.parse(now))throw new Error('Cannot undo a future event.');if(!event.changes.length)throw new Error('This event contains no reversible planning changes.');const current=parseWorkspaceExport(workspace,now),next=structuredClone(current),targets=expand(event);
 for(const target of targets){const row=next[target.collection].find(item=>item.id===target.id);if(!row)throw new Error('Undo target is missing; creation/deletion recovery is required.');const data=row as unknown as Record<string,JsonValue>;const inverse=applyInverse(data,target.changes);Object.assign(data,inverse);for(const field of Object.keys(data))if(!Object.hasOwn(inverse,field))delete data[field];if(target.changes.length&&(target.collection==='tasks'||target.collection==='milestones'))data.updatedAt=now;}
 const planningAfter=parseWorkspaceExport(next,now);validateNewAssignments(current,planningAfter);validateTaskGraph(planningAfter);
 if(targets.some(target=>target.collection==='milestones'&&target.changes.some(change=>change.path[0]==='sortKey'))){for(const project of planningAfter.projects){const keys=planningAfter.milestones.filter(row=>row.projectId===project.id).map(row=>row.sortKey);if(new Set(keys).size!==keys.length)throw new Error('Undo would create duplicate milestone ordering.');}}
 const changes:FieldChange[]=[];for(const target of targets){const before=current[target.collection].find(row=>row.id===target.id)!,after=planningAfter[target.collection].find(row=>row.id===target.id)!;for(const change of topLevelChanges(before as unknown as Record<string,JsonValue>,after as unknown as Record<string,JsonValue>))changes.push({...change,path:[target.collection,target.id,...change.path]});}if(!changes.length)throw new Error('This event contains no effective reversible planning changes.');return {planningAfter,changes};
}
/** Root must resolve the exact immutable owner event/group and bind the preview/receipt before calling this helper. */
export async function prepareHistoryUndo(context:PrepareContext,value:unknown):Promise<MutationPlan>{
 const event=parseAuditEvent(value);if(!context.userId||event.origin!=='owner'||event.actorId!==context.userId)throw new Error('Only this authenticated owner’s original event can be undone.');if(context.command.type!=='history.undo'||context.command.eventId!==undefined&&context.command.eventId!==event.id||context.command.targetRevision!==undefined&&context.command.targetRevision!==context.before.revision)throw new Error('Undo source or preview revision changed.');const preview=previewPlanningUndo(context.before.workspace,event,context.now);const writes=await syncLegacyWeeklyPins(context,preview.planningAfter);
 return {planningAfter:preview.planningAfter,writes,jobs:[],events:[{id:crypto.randomUUID(),kind:'history.undo',entityType:event.entityType,entityId:event.entityId,changes:preview.changes,origin:'owner',actorId:context.userId,occurredAt:context.now,sourceRef:event.id,undoOf:event.id}]};
}
