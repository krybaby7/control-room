import {classification,WORK_TYPES} from './areas.ts';
import { z } from 'zod';
import type { Workspace, Task } from './types.ts';
import type { WorkflowContext, WorkflowResult } from './planning-contract.ts';
import { parsePlanningImport } from './workspace-codec.ts';
import { validateTaskGraph } from './task-graph.ts';
const id=z.string().trim().min(1).max(128);
const text=(max:number,required=false)=>z.string().trim().max(max).refine(value=>!required||Boolean(value));
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value=>{try{return new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)===value;}catch{return false;}});
const url=text(2048,true).transform((value,ctx)=>{try{const parsed=new URL(value);if(!['https:','http:'].includes(parsed.protocol)||parsed.username||parsed.password||/[\u0000-\u0020\u007f]/.test(value))throw new Error();parsed.pathname=parsed.pathname.replace(/\/+$/,'')||'/';return parsed.toString();}catch{ctx.addIssue({code:z.ZodIssueCode.custom,message:'Repository URL must be HTTP or HTTPS without credentials.'});return z.NEVER;}});
const projectFields={name:text(200,true),description:text(5000),goal:text(5000),framing:z.string().max(2500).regex(/^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/u).optional(),includeTaskPlanInBriefings:z.boolean().optional(),personalRepositoryKey:z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/u).nullable().optional(),personalRepositoryKeys:z.array(z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/u)).max(4).refine(keys=>new Set(keys).size===keys.length,'Folder keys must be unique.').optional(),color:z.enum(['orange','teal']),repositories:z.array(z.object({name:text(200,true),url}).strict()).max(100)};
const ids=z.array(id).min(1).max(100).refine(values=>new Set(values).size===values.length,'Selection IDs must be unique.');
const horizon=z.enum(['now','next','later']);
const schema=z.discriminatedUnion('type',[
 z.object({type:z.literal('project.create'),project:z.object(projectFields).strict()}).strict(),
 z.object({type:z.literal('project.edit'),id,patch:z.object(projectFields).partial().strict().refine(value=>Object.keys(value).length>0)}).strict(),
 z.object({type:z.enum(['project.archive','project.restore']),id}).strict(),
 z.object({type:z.literal('project.delete'),id,impactToken:z.string()}).strict(),
 z.object({type:z.enum(['milestone.archive','milestone.restore']),id}).strict(),
 z.object({type:z.literal('milestone.delete'),id,impactToken:z.string()}).strict(),
 z.object({type:z.literal('milestone.reorder'),projectId:id,orderedIds:z.array(id).max(100).refine(values=>new Set(values).size===values.length)}).strict(),
 z.object({type:z.literal('task.move'),ids,projectId:id,milestoneId:id.nullable(),areaId:id.nullable().optional(),workType:z.enum(WORK_TYPES).optional()}).strict(),
 z.object({type:z.literal('task.bulk'),ids,patch:z.object({areaId:id.nullable().optional(),workType:z.enum(WORK_TYPES).optional(),status:z.enum(['proposed','todo','doing','review','done','archived']).optional(),priority:z.enum(['high','normal','low']).optional(),horizon:horizon.optional(),dueDate:date.nullable().optional(),milestoneId:id.nullable().optional()}).strict().refine(value=>Object.keys(value).length>0)}).strict(),
 z.object({type:z.literal('capture.bulk'),ids,patch:z.object({projectId:id.nullable().optional(),status:z.enum(['inbox','filed','archived']).optional()}).strict().refine(value=>Object.keys(value).length>0)}).strict(),
 z.object({type:z.literal('capture.bulkConvert'),items:z.array(z.object({id,projectId:id,milestoneId:id.nullable(),horizon,areaId:id.nullable().optional(),workType:z.enum(WORK_TYPES).optional()}).strict()).min(1).max(50).refine(items=>new Set(items.map(item=>item.id)).size===items.length)}).strict(),
]);
function found<T extends {id:string}>(rows:T[],id:string,label:string):T{const row=rows.find(row=>row.id===id);if(!row)throw new Error(`${label} is missing or unavailable.`);return row;}
function repositories(rows:Workspace['projects'][number]['repositories']){return [...new Map(rows.map(row=>[row.url,row])).values()];}
/** One pure atomic workflow. Authority, revision CAS and audit/backup compilation belong to the transaction. */
export function applyWorkflowCommand(workspace:Workspace,value:unknown,context:WorkflowContext):WorkflowResult {
 const command=schema.parse(value);
 if(!z.string().datetime({offset:true}).safeParse(context.now).success||typeof context.newId!=='function')throw new Error('A saved command timestamp and ID factory are required.');
 const next=parsePlanningImport(workspace,context.now);let impact:WorkflowResult['impact']=null;
 const freshId=()=>{const value=context.newId();if(!id.safeParse(value).success||[...next.projects,...next.milestones,...next.tasks,...next.captures,...next.activity].some(row=>row.id===value))throw new Error('Generated entity ID is invalid or already exists.');return value;};
 const activeProject=(projectId:string)=>{const project=found(next.projects,projectId,'Project');if(project.archivedAt)throw new Error('Select an active project.');return project;};
 const assign=(projectId:string,milestoneId:string|null,existing?:Task)=>{activeProject(projectId);if(milestoneId!==null){const milestone=found(next.milestones,milestoneId,'Milestone');if(milestone.projectId!==projectId)throw new Error('Milestone must belong to the destination project.');if(milestone.archivedAt&&existing?.milestoneId!==milestoneId)throw new Error('Select an active milestone.');}};
 switch(command.type){
 case 'project.create':if(next.projects.length>=100)throw new Error('Project capacity limit reached.');next.projects.push({...command.project,repositories:repositories(command.project.repositories),id:freshId(),priority:'equal',archivedAt:null});break;
 case 'project.edit':{const project=found(next.projects,command.id,'Project');Object.assign(project,command.patch,command.patch.repositories?{repositories:repositories(command.patch.repositories)}:{});break;}
 case 'project.archive':case 'project.restore':{const project=found(next.projects,command.id,'Project');project.archivedAt=command.type==='project.archive'?project.archivedAt??context.now:null;break;}
 case 'milestone.archive':case 'milestone.restore':{const milestone=found(next.milestones,command.id,'Milestone');milestone.archivedAt=command.type==='milestone.archive'?milestone.archivedAt??context.now:null;break;}
 case 'project.delete':case 'milestone.delete':throw new Error('Permanent removal requires the revision-bound foundation impact and backup workflow.');
 case 'milestone.reorder':{found(next.projects,command.projectId,'Project');const rows=next.milestones.filter(row=>row.projectId===command.projectId);if(rows.length!==command.orderedIds.length||rows.some(row=>!command.orderedIds.includes(row.id)))throw new Error('Reorder must contain every milestone ID for this project exactly once, including archived rows.');for(const [sortKey,milestoneId] of command.orderedIds.entries())found(rows,milestoneId,'Milestone').sortKey=sortKey;break;}
 case 'task.move':{
  activeProject(command.projectId);const selected=command.ids.map(id=>found(next.tasks,id,'Task')),previousProjectIds=[...new Set(selected.map(task=>task.projectId))];
  for(const task of selected)assign(command.projectId,command.milestoneId,task);
  for(const task of selected){Object.assign(task,classification(next,command.projectId,command.areaId===undefined?(task.projectId===command.projectId?task.areaId:null):command.areaId,command.workType??task.workType,task));task.projectId=command.projectId;task.milestoneId=command.milestoneId;}
  const moved=new Set(command.ids),index=new Map(next.tasks.map(task=>[task.id,task]));
  impact={taskIds:[...command.ids],previousProjectIds,targetProjectId:command.projectId,crossProjectEdges:next.tasks.flatMap(task=>task.dependsOn.filter(id=>(moved.has(task.id)||moved.has(id))&&index.get(id)?.projectId!==task.projectId).map(id=>({from:task.id,to:id}))).sort((a,b)=>a.from.localeCompare(b.from)||a.to.localeCompare(b.to)),captureIds:next.captures.filter(capture=>capture.convertedTaskId&&moved.has(capture.convertedTaskId)).map(capture=>capture.id)};break;
 }
 case 'task.bulk':{
  const selected=command.ids.map(id=>found(next.tasks,id,'Task'));
  for(const task of selected){
   if(command.patch.milestoneId!==undefined&&command.patch.milestoneId!==null&&command.patch.milestoneId!==task.milestoneId)assign(task.projectId,command.patch.milestoneId,task);
   if(command.patch.areaId!==undefined||command.patch.workType!==undefined)Object.assign(task,classification(next,task.projectId,command.patch.areaId===undefined?task.areaId:command.patch.areaId,command.patch.workType??task.workType,task));
   const status=command.patch.status??task.status;
   const archivedFromStatus=status==='archived'?(task.status==='archived'?task.archivedFromStatus??(task.completedAt?'done':'todo'):task.status):null;
   const completedAt=status==='done'||status==='archived'&&archivedFromStatus==='done'?task.completedAt??context.now:null;
   Object.assign(task,command.patch,{archivedFromStatus,completedAt,updatedAt:context.now});
   if(status==='archived'){task.weekly=false;task.weeklyWeek=null;}
  }break;
 }
 case 'capture.bulk':{
  if(command.patch.projectId!==undefined&&command.patch.projectId!==null)activeProject(command.patch.projectId);
  const selected=command.ids.map(id=>found(next.captures,id,'Capture'));for(const capture of selected)Object.assign(capture,command.patch);break;
 }
 case 'capture.bulkConvert':{
  if(next.tasks.length+command.items.length>2000)throw new Error('Task capacity limit reached.');
  const selected=command.items.map(item=>{const capture=found(next.captures,item.id,'Capture');if(capture.convertedTaskId||capture.status==='archived')throw new Error(`Capture “${capture.title}” is already converted or archived.`);assign(item.projectId,item.milestoneId);return {item,capture};});
  for(const {item,capture} of selected){const task:Task={...classification(next,item.projectId,item.areaId,item.workType),id:freshId(),projectId:item.projectId,milestoneId:item.milestoneId,title:capture.title,notes:capture.body,status:'proposed',horizon:item.horizon,priority:'normal',dueDate:null,weekly:false,weeklyWeek:null,dependsOn:[],blocker:'',sourceUrl:capture.sourceUrl,evidence:'',estimateMinutes:null,createdAt:context.now,updatedAt:context.now,completedAt:null,archivedFromStatus:null};next.tasks.push(task);capture.projectId=item.projectId;capture.convertedTaskId=task.id;capture.status='filed';}break;
 }
 }
 validateTaskGraph(next);
 return {workspace:parsePlanningImport(next,context.now),impact};
}
