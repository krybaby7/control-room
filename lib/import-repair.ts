import { z } from 'zod';
import { parsePlanningImport } from './workspace-codec.ts';
import { contentHash } from './workspace-export.ts';
const collections=['projects','milestones','tasks','captures','activity'] as const;
type Collection=typeof collections[number];
const id=z.string().min(1).max(128).refine(value=>value.trim()===value);
const collection=z.enum(collections);
const operationSchema=z.discriminatedUnion('type',[
 z.object({type:z.literal('map-project'),collection:z.enum(['tasks','milestones','captures']),id,projectId:id}).strict(),
 z.object({type:z.literal('remove-dependency'),taskId:id,dependencyId:id}).strict(),
 z.object({type:z.literal('rename-duplicate'),collection,occurrenceIndex:z.number().int().nonnegative().safe(),newId:id}).strict(),
 z.object({type:z.literal('exclude-record'),collection,id}).strict(),
 z.object({type:z.literal('migrate')}).strict(),
]);
export type PlanningRepairOperation=z.infer<typeof operationSchema>;
export interface PlanningRepairReport {sourceHash:string;operation:PlanningRepairOperation;changes:{path:(string|number)[];before:unknown;after:unknown}[];excludedRecords:{collection:Collection;id:string;record:unknown}[];warnings:string[];}
const LIMIT=8_000_000;
function object(value:unknown):value is Record<string,unknown> {return Boolean(value)&&typeof value==='object'&&!Array.isArray(value);}
/** Repairs quarantine bytes only; unknown fields/modules remain untouched for later diagnostics. */
export async function repairPlanningImport(raw:Uint8Array,operation:PlanningRepairOperation):Promise<{raw:Uint8Array;report:PlanningRepairReport}> {
 if(!(raw instanceof Uint8Array)||raw.byteLength>LIMIT)throw new Error('Import byte limit exceeded.');
 const bytes=raw.slice(),op=operationSchema.parse(operation);
 let root:unknown;try{root=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new Error('Import must contain valid UTF-8 JSON.');}
 if(!object(root))throw new Error('Planning import must be an object.');
 const path:string[]='planning' in root?['planning']:'workspace' in root?['workspace']:[];
 const planning=path.length?root[path[0]]:root;
 if(!object(planning))throw new Error('Planning document must be an object.');
 const report:PlanningRepairReport={sourceHash:await contentHash(bytes),operation:structuredClone(op),changes:[],excludedRecords:[],warnings:[]};
 const rows=(name:Collection):Record<string,unknown>[]=>{const value=planning[name];if(!Array.isArray(value)||value.some(row=>!object(row)))throw new Error(`Invalid ${name} collection.`);return value as Record<string,unknown>[];};
 const unique=(name:Collection,key:string)=>{const found=rows(name).map((record,index)=>({record,index})).filter(({record})=>record.id===key);if(found.length!==1)throw new Error('Record selection is missing or ambiguous; use an exact duplicate occurrence.');return found[0];};
 const change=(record:Record<string,unknown>,key:string,value:unknown,recordPath:(string|number)[])=>{report.changes.push({path:[...path,...recordPath,key],before:structuredClone(record[key]??null),after:structuredClone(value)});record[key]=value;};
 if(op.type==='map-project') {
  unique('projects',op.projectId);const selected=unique(op.collection,op.id);change(selected.record,'projectId',op.projectId,[op.collection,selected.index]);
 }else if(op.type==='remove-dependency') {
  const selected=unique('tasks',op.taskId),deps=selected.record.dependsOn;
  if(!Array.isArray(deps)||!deps.includes(op.dependencyId))throw new Error('Selected dependency does not exist.');
  change(selected.record,'dependsOn',deps.filter(value=>value!==op.dependencyId),['tasks',selected.index]);
 }else if(op.type==='exclude-record') {
  const selected=unique(op.collection,op.id);report.excludedRecords.push({collection:op.collection,id:op.id,record:structuredClone(selected.record)});
  report.changes.push({path:[...path,op.collection,selected.index],before:structuredClone(selected.record),after:null});rows(op.collection).splice(selected.index,1);
  report.warnings.push('Only the selected record was excluded. References were preserved and may still need explicit repair.');
 }else if(op.type==='rename-duplicate') {
  const selected=rows(op.collection)[op.occurrenceIndex];if(!selected||typeof selected.id!=='string')throw new Error('Exact duplicate occurrence does not exist.');
  const oldId=selected.id,all=collections.flatMap(name=>rows(name));
  if(all.some(row=>row.id===op.newId))throw new Error('Replacement ID must be globally unique.');
  if(all.filter(row=>row.id===oldId).length<2)throw new Error('Selected record does not have a duplicate ID.');
  if(object(root.modules)&&Object.values(root.modules).some(module=>object(module)&&Array.isArray(module.records)&&module.records.length))throw new Error('Module references require explicit mapping before renaming a duplicate.');
  const refs:{record:Record<string,unknown>;key:string;value:unknown;at:(string|number)[]}[]=[];
  for(const name of collections)rows(name).forEach((record,index)=>{
   if(op.collection==='projects'&&['tasks','milestones','captures','activity'].includes(name)&&record.projectId===oldId)refs.push({record,key:'projectId',value:op.newId,at:[name,index]});
   if(op.collection==='milestones'&&name==='tasks'&&record.milestoneId===oldId)refs.push({record,key:'milestoneId',value:op.newId,at:[name,index]});
   if(op.collection==='tasks'&&name==='captures'&&record.convertedTaskId===oldId)refs.push({record,key:'convertedTaskId',value:op.newId,at:[name,index]});
   if(op.collection==='tasks'&&name==='tasks'&&Array.isArray(record.dependsOn)&&record.dependsOn.includes(oldId))refs.push({record,key:'dependsOn',value:record.dependsOn.map(value=>value===oldId?op.newId:value),at:[name,index]});
  });
  if(rows(op.collection).filter(row=>row.id===oldId).length>1&&refs.length)throw new Error('Duplicate references are ambiguous. Provide explicit reference mapping instead of guessing.');
  change(selected,'id',op.newId,[op.collection,op.occurrenceIndex]);for(const ref of refs)change(ref.record,ref.key,ref.value,ref.at);
 }else {
  const savedAt=typeof root.updatedAt==='string'?root.updatedAt:undefined;
  const migrated=parsePlanningImport(planning,savedAt);
  report.changes.push({path:[...path],before:structuredClone(planning),after:structuredClone(migrated)});
  if(path.length)root[path[0]]=migrated;else root=migrated;
 }
 if(op.type!=='migrate')report.warnings.push('Repair output may remain invalid. Review a new staged preview before any owner import command.');
 const output=new TextEncoder().encode(JSON.stringify(root));if(output.byteLength>LIMIT)throw new Error('Repaired import byte limit exceeded.');
 return {raw:output,report};
}
