import {z} from 'zod';
import type {SqlDatabase} from './workspace-store.ts';
import {ownerReader,type ModuleRow} from './workspace-modules.ts';
import {weeklyPlanSchema,weeklyReviewSchema,validateWeeklyReviewHistory} from './weekly-planning.ts';
import {parseRecurrenceRule} from './recurrence.ts';
import {recurrenceOccurrenceSchema,recurrenceOccurrenceId} from './recurrence.ts';
import {canonical,contentHash} from './canonical-json.ts';
export const PLANNING_READ_KEYS=['weekly_plans','weekly_reviews','recurrence_rules','recurrence_occurrences'] as const;
export const PLANNING_READ_LIMITS=Object.freeze({rowsPerModule:10000,bytes:8_000_000,pageSize:200,attempts:3});
type Key=typeof PLANNING_READ_KEYS[number];
export interface PlanningReadResponse {revision:number;modules:Record<Key,{schemaVersion:1;records:Array<{id:string;rowRevision:number;contentHash:string;value:unknown}>}>}
const rowSchema=z.object({id:z.string().min(1).max(128),row_revision:z.number().int().positive().safe(),payload_json:z.string(),content_hash:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
/** Four owner-scoped modules only: growing audit/backup data cannot disable this read. */
export async function readPlanningModules(db:SqlDatabase,userId:string):Promise<PlanningReadResponse>{
 if(!userId)throw new Error('A signed-in owner is required.');const query=ownerReader(db,userId);
 const revision=async()=>{const current=await db.prepare('SELECT revision FROM workspaces WHERE user_id=?').bind(userId).first<{revision:number}>();if(!current||!Number.isSafeInteger(current.revision)||current.revision<1)throw new Error('Workspace is unavailable.');return current.revision;};
 async function rows(key:Key,budget:{bytes:number}):Promise<ModuleRow[]>{const result:ModuleRow[]=[];let after='';for(;;){const page=await query.list(key,{after,limit:PLANNING_READ_LIMITS.pageSize});if(page.length>PLANNING_READ_LIMITS.pageSize)throw new Error('Planning page limit exceeded.');for(const raw of page){const row=rowSchema.parse(raw);if(row.id<=after)throw new Error('Planning pagination differs.');after=row.id;budget.bytes+=new TextEncoder().encode(JSON.stringify(row)).byteLength;if(budget.bytes>PLANNING_READ_LIMITS.bytes||result.length>=PLANNING_READ_LIMITS.rowsPerModule)throw new Error('Planning source exceeds its bounded read limit.');result.push(row);}if(page.length<PLANNING_READ_LIMITS.pageSize)return result;}}
 for(let attempt=0;attempt<PLANNING_READ_LIMITS.attempts;attempt++){
  const before=await revision(),budget={bytes:0};const captured=new Map<Key,ModuleRow[]>();const modules={} as PlanningReadResponse['modules'];
  for(const key of PLANNING_READ_KEYS){const selected=await rows(key,budget);captured.set(key,selected);const records=[];for(const row of selected){const raw=JSON.parse(row.payload_json);if(await contentHash(canonical(raw))!==row.content_hash)throw new Error('Planning record digest differs.');const value=key==='weekly_plans'?weeklyPlanSchema.parse(raw):key==='weekly_reviews'?weeklyReviewSchema.parse(raw):key==='recurrence_rules'?parseRecurrenceRule(raw):recurrenceOccurrenceSchema.parse(raw);const expected=key==='weekly_plans'?(value as {weekStart:string}).weekStart:key==='recurrence_occurrences'?recurrenceOccurrenceId((value as {ruleId:string}).ruleId,(value as {occurrenceDate:string}).occurrenceDate):(value as {id:string}).id;if(expected!==row.id)throw new Error('Planning record identity differs.');records.push({id:row.id,rowRevision:row.row_revision,contentHash:row.content_hash,value});}modules[key]={schemaVersion:1,records};}
  validateWeeklyReviewHistory(modules.weekly_reviews.records.map(row=>row.value));let stable=true;const secondBudget={bytes:0};for(const key of PLANNING_READ_KEYS)if(canonical(await rows(key,secondBudget))!==canonical(captured.get(key)))stable=false;
  if(before!==await revision()||!stable)continue;const response={revision:before,modules};if(new TextEncoder().encode(JSON.stringify(response)).byteLength>PLANNING_READ_LIMITS.bytes)throw new Error('Planning response exceeds its bounded read limit.');return response;
 }
 throw new Error('Planning source changed during read. Refresh before reviewing.');
}
