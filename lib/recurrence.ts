import {z} from 'zod';
import type {Task,TaskInput,Workspace} from './types.ts';
export type RecurrencePattern={frequency:'daily';interval:number}|{frequency:'weekly';interval:number;weekdays:number[]}|{frequency:'monthly';interval:number;day:number};
export interface RecurrenceRule {id:string;startDate:string;endDate:string|null;pattern:RecurrencePattern;enabled:boolean;template:Omit<TaskInput,'status'|'weekly'|'dueDate'|'dependsOn'|'evidence'>;}
const DAY=86_400_000;
function validDate(value:string):boolean {return /^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(`${value}T00:00:00Z`))&&new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)===value;}
const date=z.string().refine(validDate,'A valid calendar date is required.');
const identifier=z.string().min(1).max(128).refine(value=>value.trim()===value);
const interval=z.number().int().min(1).max(365);
export const recurrencePatternSchema=z.discriminatedUnion('frequency',[
 z.object({frequency:z.literal('daily'),interval}).strict(),
 z.object({frequency:z.literal('weekly'),interval,weekdays:z.array(z.number().int().min(1).max(7)).min(1).max(7).refine(days=>new Set(days).size===days.length,'Weekdays must be unique.')}).strict(),
 z.object({frequency:z.literal('monthly'),interval,day:z.number().int().min(1).max(31)}).strict(),
]);
const source=z.string().max(2048).refine(value=>{try{const url=new URL(value);return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password&&!/[\u0000-\u0020\u007f]/.test(value);}catch{return false;}});
export const recurrenceRuleSchema=z.object({id:z.string().uuid(),startDate:date,endDate:date.nullable(),pattern:recurrencePatternSchema,enabled:z.boolean(),template:z.object({estimateMinutes:z.number().int().min(1).max(10080).nullable(),projectId:identifier,milestoneId:identifier.nullable(),title:z.string().max(200).refine(value=>!!value.trim()),notes:z.string().max(10000),horizon:z.enum(['now','next','later']),priority:z.enum(['high','normal','low']),blocker:z.string().max(1000),sourceUrl:source.nullable()}).strict()}).strict().refine(rule=>rule.endDate===null||rule.endDate>=rule.startDate,'End date precedes start date.');
export function parseRecurrenceRule(value:unknown):RecurrenceRule {return recurrenceRuleSchema.parse(value);}
function ordinal(value:string):number {return Date.parse(`${value}T00:00:00Z`)/DAY;}
function dayAt(value:number):string {const result=new Date(value*DAY).toISOString().slice(0,10);if(!validDate(result))throw new Error('Calendar date exceeds supported years.');return result;}
function isoWeekday(value:number):number{return (new Date(value*DAY).getUTCDay()+6)%7+1;}
function occurs(rule:RecurrenceRule,value:string,day:number):boolean {
 const start=ordinal(rule.startDate),pattern=rule.pattern;
 if(value<rule.startDate || rule.endDate!==null&&value>rule.endDate)return false;
 if(pattern.frequency==='daily')return (day-start)%pattern.interval===0;
 if(pattern.frequency==='weekly'){const anchorMonday=start-(isoWeekday(start)-1);return Math.floor((day-anchorMonday)/7)%pattern.interval===0&&pattern.weekdays.includes(isoWeekday(day));}
 const [year,month,monthDay]=value.split('-').map(Number),[startYear,startMonth]=rule.startDate.split('-').map(Number);
 const monthOffset=(year-startYear)*12+month-startMonth;const nextMonth=new Date(`${value.slice(0,7)}-01T00:00:00Z`);nextMonth.setUTCMonth(nextMonth.getUTCMonth()+1);nextMonth.setUTCDate(0);
 return monthOffset%pattern.interval===0&&monthDay===Math.min(pattern.day,nextMonth.getUTCDate());
}
/** Date-only Gregorian arithmetic; UTC here is a calendar surrogate, never a Cairo elapsed-time interval. */
export function enumerateOccurrences(input:RecurrenceRule,from:string,through:string):string[] {
 const rule=parseRecurrenceRule(input);date.parse(from);date.parse(through);const first=ordinal(from),last=ordinal(through);
 if(last<first||last-first>=90)throw new Error('Preview requires one to ninety inclusive calendar dates.');
 if(!rule.enabled)return [];const result:string[]=[];
 for(let current=first;current<=last;current++){const value=dayAt(current);if(occurs(rule,value,current))result.push(value);}return result;
}
/** With no end bound, jumps between rule periods to find ten dates without an unbounded day scan. */
export function nextTenOccurrences(input:RecurrenceRule,from:string,through?:string):string[]{
 if(through!==undefined)return enumerateOccurrences(input,from,through).slice(0,10);
 const rule=parseRecurrenceRule(input);date.parse(from);if(!rule.enabled)return [];
 const start=ordinal(rule.startDate),first=Math.max(start,ordinal(from)),pattern=rule.pattern,result:string[]=[];
 const append=(day:number)=>{if(day<first)return;let value:string;try{value=dayAt(day);}catch{return;}if(occurs(rule,value,day))result.push(value);};
 if(pattern.frequency==='daily'){const initial=start+Math.ceil((first-start)/pattern.interval)*pattern.interval;for(let i=0;i<10;i++)append(initial+i*pattern.interval);}
 else if(pattern.frequency==='weekly'){const anchor=start-isoWeekday(start)+1,firstWeek=Math.max(0,Math.floor((first-anchor)/7)),period=Math.floor(firstWeek/pattern.interval);for(let i=period;i<=period+10 && result.length<10;i++)for(const weekday of [...pattern.weekdays].sort((a,b)=>a-b)){append(anchor+i*pattern.interval*7+weekday-1);if(result.length===10)break;}}
 else {const [year,month]=rule.startDate.split('-').map(Number),[fromYear,fromMonth]=dayAt(first).split('-').map(Number),monthOffset=(fromYear-year)*12+fromMonth-month,period=Math.floor(monthOffset/pattern.interval);for(let i=period;i<=period+10&&result.length<10;i++){const monthIndex=year*12+month-1+i*pattern.interval,atYear=Math.floor(monthIndex/12),atMonth=monthIndex%12+1;if(atYear>9999)break;const monthStart=`${String(atYear).padStart(4,'0')}-${String(atMonth).padStart(2,'0')}-01`;const last=new Date(`${monthStart}T00:00:00Z`);last.setUTCMonth(last.getUTCMonth()+1);last.setUTCDate(0);append(ordinal(monthStart)+Math.min(pattern.day,last.getUTCDate())-1);}}
 return result;
}
export function occurrenceTaskId(ruleId:string,value:string):string {
 if(!z.string().uuid().safeParse(ruleId).success||!validDate(value))throw new Error('A saved recurrence rule and calendar date are required.');return `repeat:${ruleId}:${value}`;
}
export type RecurrenceAttention='paused-rule'|'missing-project'|'archived-project'|'missing-milestone'|'archived-milestone';
export type RecurrenceProposal={status:'proposed';task:Task}|{status:'attention';reason:RecurrenceAttention}|{status:'not-due'};
/** Produces a reviewable proposal only; never persists tasks, occurrence disposition or job intent. */
export function createRecurrenceProposal(input:RecurrenceRule,value:string,workspace:Workspace,now:string):RecurrenceProposal {
 const rule=parseRecurrenceRule(input);date.parse(value);if(!z.string().datetime({offset:true}).safeParse(now).success)throw new Error('A valid proposal timestamp is required.');
 if(!rule.enabled)return {status:'attention',reason:'paused-rule'};
 const project=workspace.projects.find(item=>item.id===rule.template.projectId);if(!project)return {status:'attention',reason:'missing-project'};if(project.archivedAt)return {status:'attention',reason:'archived-project'};
 if(rule.template.milestoneId!==null){const milestone=workspace.milestones.find(item=>item.id===rule.template.milestoneId&&item.projectId===project.id);if(!milestone)return {status:'attention',reason:'missing-milestone'};if(milestone.archivedAt)return {status:'attention',reason:'archived-milestone'};}
 if(!occurs(rule,value,ordinal(value)))return {status:'not-due'};
 return {status:'proposed',task:{...structuredClone(rule.template),id:occurrenceTaskId(rule.id,value),status:'proposed',weekly:false,weeklyWeek:null,dueDate:value,dependsOn:[],evidence:'',createdAt:now,updatedAt:now,completedAt:null,archivedFromStatus:null}};
}

export const recurrenceOccurrenceSchema=z.object({ruleId:z.string().uuid(),occurrenceDate:date,taskId:z.string().min(1).max(128).nullable(),generatedAt:z.string().datetime({offset:true}),disposition:z.enum(['created','skipped','removed'])}).strict().superRefine((row,ctx)=>{if(row.taskId!==null&&row.taskId!==occurrenceTaskId(row.ruleId,row.occurrenceDate)||row.taskId===null&&row.disposition!=='skipped')ctx.addIssue({code:'custom',message:'Occurrence task identity differs.'});});
export type RecurrenceOccurrence=z.infer<typeof recurrenceOccurrenceSchema>;
export function recurrenceOccurrenceId(ruleId:string,date:string):string {occurrenceTaskId(ruleId,date);return `${ruleId}:${date}`;}
