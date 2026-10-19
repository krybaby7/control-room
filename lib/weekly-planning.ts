import {z} from 'zod';
import {currentWeek} from './calendar.ts';
import type {Task,Workspace} from './types.ts';
import {WORKSPACE_LIMITS} from './workspace-validation.ts';
const id=z.string().min(1).max(128).refine(value=>value.trim()===value);
export const weekStartSchema=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value=>{try{return currentWeek(value)===value;}catch{return false;}},'Week must start on a valid Cairo Monday.');
const stamp=z.string().datetime({offset:true});
const capacity=z.number().int().min(0).max(10080).nullable();
const estimate=z.number().int().min(1).max(10080).nullable();
const taskIds=(max:number)=>z.array(id).max(max).refine(ids=>new Set(ids).size===ids.length,'Duplicate weekly task IDs.');
const selectionSchema=taskIds(100);
export const weeklyPlanSchema=z.object({weekStart:weekStartSchema,capacityMinutes:capacity,taskIds:taskIds(WORKSPACE_LIMITS.tasks),revision:z.number().int().min(1).safe()}).strict();
export type WeeklyPlan=z.infer<typeof weeklyPlanSchema>;
export const weeklyTaskSnapshotSchema=z.object({taskId:id,title:z.string().min(1).max(200),projectId:id,milestoneId:id.nullable(),status:z.enum(['proposed','todo','doing','review','done','archived']),estimateMinutes:estimate,completedAt:stamp.nullable(),archivedFromStatus:z.enum(['proposed','todo','doing','review','done']).nullable(),evidence:z.string().max(10000),sourceUrl:z.string().max(2048).nullable(),tombstone:z.boolean()}).strict();
export type WeeklyTaskSnapshot=z.infer<typeof weeklyTaskSnapshotSchema>;
export const weeklyReviewSnapshotSchema=z.object({weekStart:weekStartSchema,takenAt:stamp,commitments:z.array(weeklyTaskSnapshotSchema).max(WORKSPACE_LIMITS.tasks),completedTaskIds:taskIds(WORKSPACE_LIMITS.tasks),completedTasks:z.array(weeklyTaskSnapshotSchema).max(WORKSPACE_LIMITS.tasks),reflection:z.string().max(10000),nextWeekNotes:z.string().max(10000)}).strict().superRefine((snapshot,context)=>{
 for(const rows of [snapshot.commitments,snapshot.completedTasks])if(new Set(rows.map(row=>row.taskId)).size!==rows.length)context.addIssue({code:'custom',message:'Duplicate weekly snapshot identity.'});
 if(JSON.stringify(snapshot.completedTaskIds)!==JSON.stringify(snapshot.completedTasks.map(row=>row.taskId)))context.addIssue({code:'custom',message:'Completed snapshot attribution differs.'});
 for(const row of snapshot.completedTasks)if(!completed(row)||!row.completedAt||currentWeek(row.completedAt)!==snapshot.weekStart)context.addIssue({code:'custom',message:'Completion has no recorded timestamp in this Cairo week.'});
});
export type WeeklyReviewSnapshot=z.infer<typeof weeklyReviewSnapshotSchema>;
export const weeklyReviewSchema=z.object({id,weekStart:weekStartSchema,createdAt:stamp,supersedesId:id.nullable(),snapshot:weeklyReviewSnapshotSchema,reflection:z.string().max(10000),nextWeekNotes:z.string().max(10000)}).strict().superRefine((review,context)=>{
 if(review.id===review.supersedesId||review.weekStart!==review.snapshot.weekStart||review.createdAt!==review.snapshot.takenAt||review.reflection!==review.snapshot.reflection||review.nextWeekNotes!==review.snapshot.nextWeekNotes)context.addIssue({code:'custom',message:'Weekly review attribution differs.'});
});
export type WeeklyReview=z.infer<typeof weeklyReviewSchema>;
export const weeklyCommandSchema=z.discriminatedUnion('type',[
 z.object({type:z.literal('weekly.set'),weekStart:weekStartSchema,capacityMinutes:capacity,taskIds:selectionSchema}).strict(),
 z.object({type:z.literal('weekly.carry'),fromWeek:weekStartSchema,toWeek:weekStartSchema,taskIds:selectionSchema}).strict(),
 z.object({type:z.literal('weekly.review'),weekStart:weekStartSchema,reflection:z.string().max(10000),nextWeekNotes:z.string().max(10000),supersedesId:id.nullable()}).strict(),
]);
export type WeeklyCommand=z.infer<typeof weeklyCommandSchema>;
export function createWeeklyPlan(weekStart:string):WeeklyPlan{return weeklyPlanSchema.parse({weekStart,capacityMinutes:null,taskIds:[],revision:1});}
function revise(plan:WeeklyPlan,patch:Partial<WeeklyPlan>):WeeklyPlan{return weeklyPlanSchema.parse({...weeklyPlanSchema.parse(plan),...patch,revision:plan.revision+1});}
function indexTasks(tasks:readonly Task[]):Map<string,Task>{const map=new Map<string,Task>();for(const task of tasks){if(map.has(task.id))throw new Error('Duplicate task identity.');map.set(task.id,task);}return map;}
function completed(task:{status:string;archivedFromStatus?:string|null}){return task.status==='done'||task.status==='archived'&&task.archivedFromStatus==='done';}
export function setWeeklyCapacity(plan:WeeklyPlan,capacityMinutes:number|null):WeeklyPlan{return revise(plan,{capacityMinutes:capacity.parse(capacityMinutes)});}
/** Adding a commitment never accepts a proposal or rewrites a task's historical pin. */
export function commitWeeklyTasks(plan:WeeklyPlan,ids:readonly string[],tasks:readonly Task[]):WeeklyPlan {
 const current=weeklyPlanSchema.parse(plan);const selected=selectionSchema.parse(ids);const index=indexTasks(tasks);
 for(const id of selected){const task=index.get(id);if(!task)throw new Error(`Task ${id} is missing; recover its recorded history before committing it.`);if(!current.taskIds.includes(id)&&(task.status==='proposed'||task.status==='archived'))throw new Error(`Task ${id} must be explicitly accepted and active before commitment.`);}
 const next=[...new Set([...current.taskIds,...selected])];return next.length===current.taskIds.length?structuredClone(current):revise(current,{taskIds:next});
}
export function uncommitWeeklyTasks(plan:WeeklyPlan,ids:readonly string[]):WeeklyPlan {
 const current=weeklyPlanSchema.parse(plan);const selected=new Set(selectionSchema.parse(ids));const next=current.taskIds.filter(id=>!selected.has(id));return next.length===current.taskIds.length?structuredClone(current):revise(current,{taskIds:next});
}
export function carryForwardWeeklyTasks(from:WeeklyPlan,to:WeeklyPlan,ids:readonly string[],tasks:readonly Task[]):{from:WeeklyPlan;to:WeeklyPlan}{
 const source=weeklyPlanSchema.parse(from),target=weeklyPlanSchema.parse(to);const selected=selectionSchema.parse(ids);if(target.weekStart<=source.weekStart)throw new Error('Carry-forward requires a later Cairo week.');const index=indexTasks(tasks);
 for(const id of selected){if(!source.taskIds.includes(id))throw new Error(`Task ${id} was not committed to the source week.`);const task=index.get(id);if(!task)throw new Error(`Task ${id} no longer exists; retain its frozen history.`);if(completed(task))throw new Error(`Task ${id} is already completed and cannot be carried forward.`);if(task.status==='archived'||task.status==='proposed')throw new Error(`Task ${id} must be explicitly accepted and active before carry-forward.`);}
 return {from:structuredClone(source),to:commitWeeklyTasks(target,selected,tasks)};
}
export function budgetSummary(plan:WeeklyPlan,estimates:ReadonlyMap<string,number|null>):{knownMinutes:number;unestimated:number;overBy:number|null}{
 const validated=weeklyPlanSchema.parse(plan);let knownMinutes=0,unestimated=0;
 for(const id of validated.taskIds){const value=estimates.get(id);if(value===undefined||value===null)unestimated++;else knownMinutes+=estimate.parse(value)!;}
 return {knownMinutes,unestimated,overBy:validated.capacityMinutes===null?null:Math.max(0,knownMinutes-validated.capacityMinutes)};
}
function freezeTask(task:Task):WeeklyTaskSnapshot{return weeklyTaskSnapshotSchema.parse({taskId:task.id,title:task.title,projectId:task.projectId,milestoneId:task.milestoneId,status:task.status,estimateMinutes:task.estimateMinutes,completedAt:task.completedAt,archivedFromStatus:task.archivedFromStatus??null,evidence:task.evidence,sourceUrl:task.sourceUrl,tombstone:false});}
export function completionSummary(plan:WeeklyPlan,tasks:readonly Task[]):{completedTaskIds:string[];committedCompletedTaskIds:string[]}{
 const validated=weeklyPlanSchema.parse(plan);indexTasks(tasks);const completedTaskIds=tasks.filter(task=>completed(task)&&task.completedAt!==null&&currentWeek(task.completedAt)===validated.weekStart).map(task=>task.id);const committed=new Set(validated.taskIds);return {completedTaskIds,committedCompletedTaskIds:completedTaskIds.filter(id=>committed.has(id))};
}
/** Caller supplies the actual review timestamp. Missing historical completion times stay null. */
export function prepareWeeklyReview(plan:WeeklyPlan,tasks:readonly Task[],options:{id:string;takenAt:string;reflection:string;nextWeekNotes:string;supersedes?:WeeklyReview|null;tombstones?:readonly WeeklyTaskSnapshot[]}):WeeklyReview{
 const validated=weeklyPlanSchema.parse(plan);stamp.parse(options.takenAt);const index=indexTasks(tasks);const tombstones=new Map<string,WeeklyTaskSnapshot>();
 for(const raw of options.tombstones??[]){const row=weeklyTaskSnapshotSchema.parse(raw);if(tombstones.has(row.taskId)||index.has(row.taskId)||!row.tombstone)throw new Error('Invalid historical task tombstone.');tombstones.set(row.taskId,row);}
 const previous=options.supersedes?weeklyReviewSchema.parse(options.supersedes):null;if(previous&&(previous.weekStart!==validated.weekStart||Date.parse(previous.createdAt)>Date.parse(options.takenAt)))throw new Error('Correction must supersede an earlier review for this same week.');
 const commitments=validated.taskIds.map(id=>{const task=index.get(id);if(task)return freezeTask(task);const historical=tombstones.get(id);if(!historical)throw new Error(`Task ${id} is missing; an explicit historical tombstone is required.`);return structuredClone(historical);});
 const completedTasks=[...tasks.filter(task=>completed(task)&&task.completedAt!==null&&currentWeek(task.completedAt)===validated.weekStart).map(freezeTask),...[...tombstones.values()].filter(row=>completed(row)&&row.completedAt!==null&&currentWeek(row.completedAt)===validated.weekStart).map(row=>structuredClone(row))];
 const snapshot={weekStart:validated.weekStart,takenAt:options.takenAt,commitments,completedTaskIds:completedTasks.map(task=>task.taskId),completedTasks,reflection:options.reflection,nextWeekNotes:options.nextWeekNotes};
 return weeklyReviewSchema.parse({id:options.id,weekStart:validated.weekStart,createdAt:options.takenAt,supersedesId:previous?.id??null,snapshot,reflection:options.reflection,nextWeekNotes:options.nextWeekNotes});
}
/** Validate imported correction chains without consulting live task rows. */
export function validateWeeklyReviewHistory(values:unknown):WeeklyReview[]{
 const reviews=z.array(weeklyReviewSchema).max(10000).parse(values);const index=new Map<string,WeeklyReview>();
 for(const review of reviews){if(index.has(review.id))throw new Error('Duplicate weekly review identity.');index.set(review.id,review);}
 for(const review of reviews)if(review.supersedesId){const previous=index.get(review.supersedesId);if(!previous||previous.weekStart!==review.weekStart||Date.parse(previous.createdAt)>Date.parse(review.createdAt))throw new Error('Invalid weekly review correction link.');}
 const done=new Set<string>();for(const review of reviews){const path=new Set<string>();let cursor:WeeklyReview|undefined=review;while(cursor&&!done.has(cursor.id)){if(path.has(cursor.id))throw new Error('Weekly review supersession cycle.');path.add(cursor.id);cursor=cursor.supersedesId?index.get(cursor.supersedesId):undefined;}for(const id of path)done.add(id);}
 return reviews;
}

/** Derive today's compatibility cache without rewriting noncurrent legacy history. */
export function hydrateCurrentWeeklyPins(workspace:Workspace,plan:WeeklyPlan|null,now:string):Workspace {
 const next=structuredClone(workspace),weekStart=currentWeek(now);if(!plan)return next;
 const canonical=weeklyPlanSchema.parse(plan);if(canonical.weekStart!==weekStart)return next;const selected=new Set(canonical.taskIds);
 for(const task of next.tasks){if(selected.has(task.id)&&task.status!=='archived'&&task.status!=='proposed'){task.weekly=true;task.weeklyWeek=weekStart;}else if(task.weeklyWeek===weekStart){task.weekly=false;task.weeklyWeek=null;}}
 return next;
}
