import {z} from 'zod';
import type {Workspace,WorkType,TaskClassification} from './types.ts';
export const WORK_TYPES=['planning','implementation','testing','review','research','decision','operations','other'] as const;
export const WORK_TYPE_LABELS:Record<WorkType,string>={planning:'Planning',implementation:'Implementation',testing:'Testing',review:'Review',research:'Research',decision:'Decision',operations:'Operations',other:'Other'};
export function taskContext(project:string,area:string|null,workTypeLabel:string){return [project,area??'Unclassified',workTypeLabel].join(' / ');}
export const normalizeAreaName=(name:string)=>name.trim().normalize('NFKC').toLocaleLowerCase('en-US');
const id=z.string().trim().min(1).max(128),name=z.string().trim().min(1).max(120);
const areaFields={name,aliases:z.array(name).max(10),order:z.number().int().nonnegative().safe()};
export const areaCommandSchema=z.discriminatedUnion('type',[
 z.object({type:z.literal('area.create'),projectId:id,name,aliases:areaFields.aliases.optional(),order:areaFields.order.optional()}).strict(),
 z.object({type:z.literal('area.update'),id,patch:z.object(areaFields).partial().strict().refine(p=>Object.keys(p).length>0)}).strict(),
 z.object({type:z.enum(['area.archive','area.restore']),id}).strict(),
]);
export type AreaCommand=z.infer<typeof areaCommandSchema>;
export function validateAreas(workspace:Workspace){
 const areas=workspace.areas??[];if(areas.length>1000)throw new Error('Area capacity limit reached.');
 const names=new Set<string>(),counts=new Map<string,number>();
 for(const area of areas){
  if(!Number.isSafeInteger(area.order)||area.order<0||area.aliases.length>10)throw new Error('Invalid area ordering or alias limit.');
  if(!workspace.projects.some(p=>p.id===area.projectId))throw new Error('Area refers to a missing project.');
  counts.set(area.projectId,(counts.get(area.projectId)??0)+1);if(counts.get(area.projectId)!>100)throw new Error('Project area capacity limit reached.');
  const own=new Set<string>();for(const label of [area.name,...area.aliases]){const normalized=normalizeAreaName(label);if(!normalized||label.length>120)throw new Error('Invalid area name.');if(own.has(normalized))throw new Error('Duplicate area name or alias.');own.add(normalized);const key=JSON.stringify([area.projectId,normalized]);if(names.has(key))throw new Error('Duplicate area name or alias in project.');names.add(key);}
 }
}
export function classification(workspace:Workspace,projectId:string,areaId:unknown,workType:unknown,previous?:{areaId?:string|null;projectId:string}):TaskClassification{
 const type=z.enum(WORK_TYPES).parse(workType??'other');const selected=areaId===undefined?null:areaId;
 if(selected!==null){const parsed=id.parse(selected),area=workspace.areas?.find(a=>a.id===parsed);if(!area||area.projectId!==projectId)throw new Error('Select an area belonging to this project.');if(area.archivedAt&&!(previous?.areaId===parsed&&previous.projectId===projectId))throw new Error('Select an active area.');return {areaId:parsed,workType:type};}
 return {areaId:null,workType:type};
}
export function applyAreaCommand(workspace:Workspace,value:unknown,now:string,newId:()=>string):Workspace{
 const command=areaCommandSchema.parse(value),next=structuredClone(workspace);next.areas??=[];
 const freshId=()=>{const generated=id.parse(newId());if([...next.areas!,...next.projects,...next.milestones,...next.tasks,...next.captures,...next.activity].some(row=>row.id===generated))throw new Error('Generated area ID already exists.');return generated;};
 if(command.type==='area.create'){
  const project=next.projects.find(p=>p.id===command.projectId);if(!project||project.archivedAt)throw new Error('Select an active project.');
  next.areas.push({id:freshId(),projectId:command.projectId,name:command.name,aliases:command.aliases??[],order:command.order??Math.max(-1,...next.areas.filter(a=>a.projectId===command.projectId).map(a=>a.order))+1,archivedAt:null});
 }else{const area=next.areas.find(a=>a.id===command.id);if(!area)throw new Error('Area is missing or unavailable.');
  if(command.type==='area.update'){const old=area.name;Object.assign(area,command.patch);if(normalizeAreaName(old)!==normalizeAreaName(area.name)&&!area.aliases.some(a=>normalizeAreaName(a)===normalizeAreaName(old)))area.aliases.push(old);if(area.aliases.length>10)throw new Error('Area aliases must contain at most 10 names.');}
  else area.archivedAt=command.type==='area.archive'?area.archivedAt??now:null;
 }
 validateAreas(next);return next;
}
