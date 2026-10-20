import {evidenceDateSchema,evidenceIdSchema} from '../evidence-validation.ts';
import {automationScheduleSchema} from './validation.ts';
import {AUTOMATION_LIMITS,type AutomationSchedule} from './contracts.ts';
const DAY=86_400_000;
const formatter=new Intl.DateTimeFormat('en-GB-u-nu-latn',{timeZone:'Africa/Cairo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
/** Compatible local-time policy: repeated times choose the earlier instant; skipped
 * times shift forward by the actual timezone gap. Only one instant belongs to a local date.
 * enabled/archive are execution gates owned by callers, not calendar preview arithmetic.
 */
export const CAIRO_SCHEDULE_POLICY=Object.freeze({ambiguous:'earlier',gap:'shift-forward',calendarOccurrencesPerDate:1}as const);
function instant(value:string):number{evidenceDateSchema.parse(value);const result=Date.parse(value),year=new Date(result).getUTCFullYear();if(year<1||year>9998)throw new Error('Schedule timestamps support years 0001 through 9998.');return result;}
function utc(year:number,month:number,day:number,hour=0,minute=0,second=0):number{const date=new Date(0);date.setUTCFullYear(year,month-1,day);date.setUTCHours(hour,minute,second,0);return date.getTime();}
function parts(value:number){const fields=Object.fromEntries(formatter.formatToParts(new Date(value)).filter(part=>part.type!=='literal').map(part=>[part.type,Number(part.value)]));return {year:fields.year,month:fields.month,day:fields.day,hour:fields.hour,minute:fields.minute,second:fields.second};}
function ordinal(value:number):number{const local=parts(value);if(local.year<1||local.year>9998)throw new Error('Cairo calendar date exceeds supported years.');return Math.floor(utc(local.year,local.month,local.day)/DAY);}
function iso(value:number){const date=new Date(value);if(!Number.isFinite(value)||date.getUTCFullYear()<1||date.getUTCFullYear()>9998)throw new Error('Schedule occurrence exceeds supported years.');return date.toISOString();}
function weekday(day:number){return ((new Date(day*DAY).getUTCDay()+6)%7)+1;}
function localOccurrence(day:number,time:string):number{
 const [hour,minute]=time.split(':').map(Number),nominal=day*DAY+hour*3_600_000+minute*60_000,offsets=new Set<number>();
 // Constant thirteen probes capture the actual offsets surrounding the calendar date.
 for(let step=-6;step<=6;step++){const sample=nominal+step*6*3_600_000,p=parts(sample);offsets.add(utc(p.year,p.month,p.day,p.hour,p.minute,p.second)-sample);}
 const exact:number[]=[],shifted:Array<{instant:number;delta:number}>=[];
 for(const offset of offsets){const candidate=nominal-offset,p=parts(candidate),wall=utc(p.year,p.month,p.day,p.hour,p.minute,p.second),delta=wall-nominal;if(delta===0)exact.push(candidate);else if(delta>0&&Math.floor(wall/DAY)===day)shifted.push({instant:candidate,delta});}
 if(exact.length)return Math.min(...exact);shifted.sort((a,b)=>a.delta-b.delta||a.instant-b.instant);if(shifted.length)return shifted[0].instant;throw new Error('The selected Cairo calendar time could not be resolved.');
}
function config(value:AutomationSchedule){return automationScheduleSchema.parse(value);}
function nextCalendar(schedule:AutomationSchedule,after:number):number{const recurrence=schedule.recurrence;if(recurrence.frequency==='interval')throw new Error('Calendar recurrence required.');let day=ordinal(after);if(recurrence.frequency==='weekly')day+=(recurrence.weekday-weekday(day)+7)%7;let due=localOccurrence(day,recurrence.localTime);if(due<=after){day+=recurrence.frequency==='weekly'?7:1;due=localOccurrence(day,recurrence.localTime);}return due;}
/** Offset representations of the same due instant share exactly one bounded identity. */
export function occurrenceKey(scheduleId:string,dueAt:string):string{evidenceIdSchema.parse(scheduleId);return `${scheduleId}:${iso(instant(dueAt))}`;}
/** Strictly later than after; an interval never precedes its explicit anchor. */
export function nextOccurrence(schedule:AutomationSchedule,after:string):string{const parsed=config(schedule),at=instant(after),recurrence=parsed.recurrence;if(recurrence.frequency!=='interval')return iso(nextCalendar(parsed,at));const anchor=instant(recurrence.anchorAt),period=recurrence.minutes*60_000,index=Math.max(0,Math.floor((at-anchor)/period)+1);return iso(anchor+index*period);}
export interface LatestDue {dueAt:string|null;nextDueAt:string;missedPeriods:number;missedPeriodsCapped:boolean;clockRollback:boolean}
/** Exclusive lower bound, inclusive now. Returns only the latest due occurrence;
 * missedPeriods summarizes earlier due occurrences, never a backlog of execution intents.
 * Calendar counting uses day/week ordinals, independent of elapsed DST-hour lengths.
 */
export function latestDue(schedule:AutomationSchedule,from:string,now:string):LatestDue{
 const parsed=config(schedule),start=instant(from),end=instant(now),next=nextOccurrence(parsed,from),none=(rollback=false):LatestDue=>({dueAt:null,nextDueAt:next,missedPeriods:0,missedPeriodsCapped:false,clockRollback:rollback});if(end<start)return none(true);const first=instant(next);if(first>end)return none();let due:number,count:number;const recurrence=parsed.recurrence;
 if(recurrence.frequency==='interval'){const anchor=instant(recurrence.anchorAt),period=recurrence.minutes*60_000,last=Math.floor((end-anchor)/period),begin=Math.max(0,Math.floor((start-anchor)/period)+1);due=anchor+last*period;count=last-begin+1;}
 else{let day=ordinal(end);const step=recurrence.frequency==='weekly'?7:1;if(recurrence.frequency==='weekly')day-=(weekday(day)-recurrence.weekday+7)%7;due=localOccurrence(day,recurrence.localTime);if(due>end){day-=step;due=localOccurrence(day,recurrence.localTime);}count=Math.floor((day-ordinal(first))/step)+1;}
 if(count<1||due<=start)return none();const missed=count-1;return {dueAt:iso(due),nextDueAt:nextOccurrence(parsed,iso(due)),missedPeriods:Math.min(missed,AUTOMATION_LIMITS.missedPeriods),missedPeriodsCapped:missed>AUTOMATION_LIMITS.missedPeriods,clockRollback:false};
}
