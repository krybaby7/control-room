import type {Task,Project} from './types.ts';

/** The supplied workspace is the complete authenticated owner scope. This module never looks up outside it. */
export interface TaskGraphWorkspace {tasks:Task[];projects:Project[]}
export const TASK_GRAPH_LIMITS=Object.freeze({prerequisites:50,visibleNodes:200});
export interface TaskGraphBlocker {kind:'manual'|'unfinished'|'archived-unfinished';taskId:string;prerequisiteId:string|null;projectId:string;projectLabel:string;message:string}
export type TaskGraphErrorCode='duplicate-task'|'duplicate-project'|'missing-project'|'invalid-dependencies'|'missing-dependency'|'duplicate-dependency'|'self-dependency'|'cycle'|'completed-blocked'|'unavailable-root'|'invalid-limit';
export interface TaskGraphIssue {code:TaskGraphErrorCode;taskId:string|null;prerequisiteId?:string;message:string;cycle?:string[];blockers?:TaskGraphBlocker[]}
export class TaskGraphError extends Error {
 readonly code:TaskGraphErrorCode;readonly issues:TaskGraphIssue[];
 constructor(issues:TaskGraphIssue[]){super(issues.map(issue=>issue.message).join(' '));this.name='TaskGraphError';this.code=issues[0].code;this.issues=structuredClone(issues);}
}
interface Index {tasks:Map<string,Task>;projects:Map<string,Project>;dependents:Map<string,string[]>}
export function taskGraphFulfilled(task:Pick<Task,'status'|'archivedFromStatus'>):boolean{return task.status==='done'||task.status==='archived'&&task.archivedFromStatus==='done';}
function blockers(task:Task,index:Index):TaskGraphBlocker[]{
 const result:TaskGraphBlocker[]=[];const label=(projectId:string)=>index.projects.get(projectId)!.name;
 if(task.blocker.trim())result.push({kind:'manual',taskId:task.id,prerequisiteId:null,projectId:task.projectId,projectLabel:label(task.projectId),message:task.blocker.trim()});
 for(const id of [...task.dependsOn].sort()){const prerequisite=index.tasks.get(id)!;if(taskGraphFulfilled(prerequisite))continue;const archived=prerequisite.status==='archived';const projectLabel=label(prerequisite.projectId);result.push({kind:archived?'archived-unfinished':'unfinished',taskId:task.id,prerequisiteId:id,projectId:prerequisite.projectId,projectLabel,message:archived?`Archived prerequisite “${prerequisite.title}” (${projectLabel}) must be restored and completed, or explicitly unlinked.`:`Complete “${prerequisite.title}” (${projectLabel}) first.`});}
 return result;
}
function build(workspace:TaskGraphWorkspace):Index {
 const tasks=new Map<string,Task>(),projects=new Map<string,Project>(),dependents=new Map<string,string[]>();const issues:TaskGraphIssue[]=[];
 for(const project of workspace.projects){if(projects.has(project.id))issues.push({code:'duplicate-project',taskId:null,message:'Project IDs must be unique in the owner workspace.'});projects.set(project.id,project);}
 for(const task of workspace.tasks){if(tasks.has(task.id))issues.push({code:'duplicate-task',taskId:task.id,message:'Task IDs must be unique in the owner workspace.'});tasks.set(task.id,task);dependents.set(task.id,[]);}
 for(const task of workspace.tasks){
  if(!projects.has(task.projectId))issues.push({code:'missing-project',taskId:task.id,message:`Task “${task.title}” refers to an unavailable project.`});
  if(!Array.isArray(task.dependsOn)||task.dependsOn.length>TASK_GRAPH_LIMITS.prerequisites||task.dependsOn.some(id=>typeof id!=='string'||!id.trim())){issues.push({code:'invalid-dependencies',taskId:task.id,message:`Task “${task.title}” must have at most 50 valid prerequisite IDs.`});continue;}
  const seen=new Set<string>();for(const id of task.dependsOn){if(seen.has(id))issues.push({code:'duplicate-dependency',taskId:task.id,prerequisiteId:id,message:`Task “${task.title}” lists a prerequisite more than once.`});seen.add(id);if(id===task.id)issues.push({code:'self-dependency',taskId:task.id,prerequisiteId:id,message:`Task “${task.title}” cannot depend on itself.`});else if(!tasks.has(id))issues.push({code:'missing-dependency',taskId:task.id,prerequisiteId:id,message:`Task “${task.title}” has a prerequisite missing or unavailable in this workspace.`});else dependents.get(id)!.push(task.id);}
 }
 if(issues.length)throw new TaskGraphError(issues);
 for(const ids of dependents.values())ids.sort();
 return {tasks,projects,dependents};
}
function validate(workspace:TaskGraphWorkspace):Index {
 const index=build(workspace);const visited=new Set<string>(),visiting=new Set<string>();
 // Iterative DFS keeps large owner graphs independent of JavaScript call-stack depth.
 for(const root of [...index.tasks.keys()].sort()){
  if(visited.has(root))continue;const stack=[{id:root,next:0}];visiting.add(root);
  while(stack.length){const frame=stack[stack.length-1];const next=index.tasks.get(frame.id)!.dependsOn[frame.next++];if(next===undefined){visiting.delete(frame.id);visited.add(frame.id);stack.pop();continue;}if(visiting.has(next)){const cycle=[...stack.slice(stack.findIndex(item=>item.id===next)).map(item=>item.id),next];throw new TaskGraphError([{code:'cycle',taskId:frame.id,prerequisiteId:next,cycle,message:'Task prerequisites cannot form a cycle across the owner workspace.'}]);}if(!visited.has(next)){visiting.add(next);stack.push({id:next,next:0});}}
 }
 const issues:TaskGraphIssue[]=[];for(const task of index.tasks.values())if(taskGraphFulfilled(task)){const blocked=blockers(task,index);if(blocked.length)issues.push({code:'completed-blocked',taskId:task.id,blockers:blocked,message:`Completed task “${task.title}” is blocked by unfinished dependencies or an explicit blocker. Clear its blockers or reopen the dependent task first.`});}
 if(issues.length)throw new TaskGraphError(issues);return index;
}
/** Allows cross-project edges; validates the final whole graph, independent of command order. */
export function validateTaskGraph(workspace:TaskGraphWorkspace):void {validate(workspace);}
export function getTaskGraphBlockers(workspace:TaskGraphWorkspace,taskId:string):TaskGraphBlocker[]{const index=validate(workspace),task=index.tasks.get(taskId);if(!task)throw new TaskGraphError([{code:'unavailable-root',taskId:null,message:'Task is missing or unavailable.'}]);return blockers(task,index);}
export interface TaskGraphRow {id:string;title:string;projectId:string;projectLabel:string;status:Task['status'];archived:boolean;fulfilled:boolean;relation:'root'|'prerequisite'|'dependent';depth:number;prerequisiteIds:string[];dependentIds:string[];blockers:TaskGraphBlocker[]}
export interface RootedTaskGraph {rootId:string;totalNodes:number;visible:TaskGraphRow[];edges:Array<{taskId:string;prerequisiteId:string}>;remainingTable:TaskGraphRow[];remainingCount:number;rootBlockers:TaskGraphBlocker[]}
/** Returns every transitive prerequisite/dependent. Only visualization nodes are capped; the table omits none. */
export function traverseTaskGraph(workspace:TaskGraphWorkspace,rootId:string,options:{maxVisible?:number}={}):RootedTaskGraph {
 const maxVisible=options.maxVisible??TASK_GRAPH_LIMITS.visibleNodes;if(!Number.isSafeInteger(maxVisible)||maxVisible<1||maxVisible>TASK_GRAPH_LIMITS.visibleNodes)throw new TaskGraphError([{code:'invalid-limit',taskId:null,message:'Display between 1 and 200 graph nodes.'}]);
 const index=validate(workspace);if(!index.tasks.has(rootId))throw new TaskGraphError([{code:'unavailable-root',taskId:null,message:'Task is missing or unavailable.'}]);
 const found=new Map<string,{relation:TaskGraphRow['relation'];depth:number}>([[rootId,{relation:'root',depth:0}]]);
 const queue:Array<{id:string;direction:'prerequisite'|'dependent';depth:number}>=[{id:rootId,direction:'prerequisite',depth:0},{id:rootId,direction:'dependent',depth:0}];const explored=new Set<string>();
 for(let cursor=0;cursor<queue.length;cursor++){const current=queue[cursor],key=`${current.direction}:${current.id}`;if(explored.has(key))continue;explored.add(key);const adjacent=current.direction==='prerequisite'?index.tasks.get(current.id)!.dependsOn:index.dependents.get(current.id)!;for(const id of [...adjacent].sort()){if(!found.has(id))found.set(id,{relation:current.direction,depth:current.depth+1});queue.push({id,direction:current.direction,depth:current.depth+1});}}
 const rows=[...found].map(([id,context]):TaskGraphRow=>{const task=index.tasks.get(id)!;return {id,title:task.title,projectId:task.projectId,projectLabel:index.projects.get(task.projectId)!.name,status:task.status,archived:task.status==='archived',fulfilled:taskGraphFulfilled(task),...context,prerequisiteIds:[...task.dependsOn].sort(),dependentIds:[...index.dependents.get(id)!],blockers:blockers(task,index)};});
 const visible=rows.slice(0,maxVisible),displayed=new Set(visible.map(row=>row.id));const remainingTable=rows.slice(maxVisible);
 return {rootId,totalNodes:rows.length,visible,edges:visible.flatMap(task=>task.prerequisiteIds.filter(id=>displayed.has(id)).map(prerequisiteId=>({taskId:task.id,prerequisiteId}))),remainingTable,remainingCount:remainingTable.length,rootBlockers:blockers(index.tasks.get(rootId)!,index)};
}
