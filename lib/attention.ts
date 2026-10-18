import type { Workspace, Task } from './types.ts';
import { cairoDate, currentWeek } from './calendar.ts';
import { entityHref, archivedEntity } from './entity-links.ts';
export type AttentionKind='blocked'|'overdue'|'review'|'proposal'|'carry-forward'|'capture-inbox'|'milestone-overdue'|'missing-evidence'|'stale-source'|'failed-job';
export interface AttentionItem {key:string;kind:AttentionKind;entityType:'task'|'milestone'|'capture'|'source'|'job';entityId:string;projectId:string|null;title:string;reasons:string[];href:string;severity:'action'|'review'|'information';sortAt:string|null;}
export interface AttentionProvider {key:string;read(userId:string,asOf:string):Promise<AttentionItem[]>;}
export interface AttentionContext {date:string;week?:string;weeklyTaskIds?:readonly string[];findings?:readonly AttentionItem[];}
const kinds:AttentionKind[]=['blocked','overdue','review','proposal','carry-forward','capture-inbox','milestone-overdue','missing-evidence','stale-source','failed-job'];
const completed=(task:Task)=>task.status==='done'||task.status==='archived'&&task.archivedFromStatus==='done';
export function buildAttention(workspace:Workspace,context:AttentionContext):AttentionItem[] {
 const date=cairoDate(context.date),week=context.week??currentWeek(date);if(currentWeek(week)!==week)throw new Error('Attention week must be Monday.');
 if((context.findings?.length??0)>10000)throw new Error('Attention provider findings exceed limit.');
 const result:AttentionItem[]=[],tasks=new Map(workspace.tasks.map(task=>[task.id,task]));
 const add=(kind:AttentionKind,entityType:'task'|'milestone'|'capture',row:{id:string;title:string;projectId:string|null},reasons:string[],sortAt:string|null=null)=>result.push({key:`${kind}:${entityType}:${row.id}`,kind,entityType,entityId:row.id,projectId:row.projectId,title:row.title,reasons,href:entityHref({kind:entityType,id:row.id}),severity:kind==='proposal'||kind==='review'?'review':'action',sortAt});
 for(const task of workspace.tasks){
  if(completed(task)||archivedEntity(workspace,{kind:'task',id:task.id}))continue;
  const blockers:string[]=[];if(task.blocker.trim())blockers.push(task.blocker.trim());
  for(const id of task.dependsOn){const prerequisite=tasks.get(id);if(!prerequisite)blockers.push('A prerequisite is missing or unavailable.');else if(!completed(prerequisite))blockers.push(`Complete “${prerequisite.title}” first${archivedEntity(workspace,{kind:'task',id})?' (archived prerequisite)':''}.`);}
  if(blockers.length)add('blocked','task',task,blockers);
  if(task.dueDate&&task.dueDate<date)add('overdue','task',task,[`Overdue since ${task.dueDate}.`],task.dueDate);
  if(task.status==='review')add('review','task',task,['Ready for owner review.'],task.updatedAt);
  if(task.status==='proposed')add('proposal','task',task,['Proposed work needs an explicit owner decision.'],task.createdAt);
  if(task.weekly&&task.weeklyWeek&&task.weeklyWeek<week&&!context.weeklyTaskIds?.includes(task.id))add('carry-forward','task',task,[`Unfinished commitment from ${task.weeklyWeek}.`],task.weeklyWeek);
 }
 for(const milestone of workspace.milestones)if(milestone.status!=='achieved'&&milestone.targetDate&&milestone.targetDate<date&&!archivedEntity(workspace,{kind:'milestone',id:milestone.id}))add('milestone-overdue','milestone',milestone,[`Target date was ${milestone.targetDate}.`],milestone.targetDate);
 for(const capture of workspace.captures)if(capture.status==='inbox'&&!archivedEntity(workspace,{kind:'capture',id:capture.id}))add('capture-inbox','capture',capture,['Capture needs triage.'],capture.createdAt);
 for(const item of context.findings??[]){if(!['task','milestone','capture','source','job'].includes(item.entityType)||!['action','review','information'].includes(item.severity)||typeof item.title!=='string'||typeof item.entityId!=='string'||!item.entityId||!/^\/(?!\/)/.test(item.href)||!kinds.includes(item.kind)||item.key!==`${item.kind}:${item.entityType}:${item.entityId}`||!Array.isArray(item.reasons)||item.reasons.some(reason=>typeof reason!=='string'))throw new Error('Invalid attention provider finding.');result.push(structuredClone(item));}
 const unique=new Map<string,AttentionItem>();for(const item of result){const prior=unique.get(item.key);if(prior)prior.reasons=[...new Set([...prior.reasons,...item.reasons])];else unique.set(item.key,item);}
 return [...unique.values()].sort((a,b)=>({action:0,review:1,information:2}[a.severity]-{action:0,review:1,information:2}[b.severity])||(a.sortAt??'9999').localeCompare(b.sortAt??'9999')||a.key.localeCompare(b.key));
}
export function attentionPage(items:readonly AttentionItem[],options:{kind?:AttentionKind;projectId?:string;page?:number}={}) {
 const page=options.page??1;if(!Number.isSafeInteger(page)||page<1||options.kind&&!kinds.includes(options.kind))throw new Error('Invalid attention filter.');
 const scoped=items.filter(item=>options.projectId===undefined||item.projectId===options.projectId);
 const counts=Object.fromEntries(kinds.map(kind=>[kind,scoped.filter(item=>item.kind===kind).length])) as Record<AttentionKind,number>;
 const filtered=options.kind?scoped.filter(item=>item.kind===options.kind):scoped;
 const grouped=new Map<string,AttentionItem&{kinds:AttentionKind[]}>();
 for(const row of filtered){const key=options.kind?row.key:`${row.entityType}:${row.entityId}`,existing=grouped.get(key);if(existing){existing.reasons=[...new Set([...existing.reasons,...row.reasons])];existing.kinds=[...new Set([...existing.kinds,row.kind])];}else grouped.set(key,{...structuredClone(row),kinds:[row.kind]});}
 const all=[...grouped.values()];return {items:all.slice((page-1)*50,page*50),total:all.length,page,pageSize:50 as const,pages:Math.ceil(all.length/50),counts};
}
