import {z} from 'zod';
import {cairoDate} from './calendar.ts';
import type {EvidenceVersion,DecisionVersion} from './evidence-contract.ts';
export const REVIEW_BROWSE_LIMIT=10_000;
const day=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value=>{try{return new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)===value;}catch{return false;}},'A real calendar date is required.');
const instant=z.string().datetime({offset:true}).refine(value=>day.safeParse(value.slice(0,10)).success&&Number.isFinite(Date.parse(value)),'A real timestamp is required.');
export function reviewAsOfDate(value:string):string{return cairoDate(z.union([day,instant]).parse(value));}
export type EvidenceDateField='observedAt'|'recordedAt';
export interface EvidenceDateFilter {field:EvidenceDateField;from?:string;through?:string;includeUnknown?:boolean}
const evidenceFilter=z.object({field:z.enum(['observedAt','recordedAt']),from:day.optional(),through:day.optional(),includeUnknown:z.boolean().default(false)}).strict().refine(value=>!value.from||!value.through||value.from<=value.through,'The start date must not follow the end date.');
export type DecisionReviewFilter='all'|'due'|'not-due'|'unknown';
export type DecisionReviewState='due'|'not-due'|'unknown';
export function decisionReviewState(reviewOn:string|null,asOf:string):DecisionReviewState{const today=reviewAsOfDate(asOf);return reviewOn===null?'unknown':day.parse(reviewOn)<=today?'due':'not-due';}
function bounded(rows:readonly unknown[]){if(!Array.isArray(rows)||rows.length>REVIEW_BROWSE_LIMIT)throw new Error('Review browse limit exceeded.');}
/** Inclusive Cairo day bounds apply to the selected immutable version date, never its head. */
export function filterEvidenceDates<T extends Pick<EvidenceVersion,'observedAt'|'recordedAt'>>(rows:readonly T[],input:EvidenceDateFilter):T[]{
 bounded(rows);const filter=evidenceFilter.parse(input),range=!!(filter.from||filter.through);
 return rows.filter(row=>{const value=row[filter.field];if(value===null)return !range||filter.includeUnknown;const date=cairoDate(instant.parse(value));return (!filter.from||date>=filter.from)&&(!filter.through||date<=filter.through);});
}
/** Due dates are contextual browse results; null remains unknown and never counts as due. */
export function filterDecisionReviews<T extends Pick<DecisionVersion,'reviewOn'>>(rows:readonly T[],input:{mode:DecisionReviewFilter;asOf:string}):T[]{
 bounded(rows);const filter=z.object({mode:z.enum(['all','due','not-due','unknown']),asOf:z.string()}).strict().parse(input);const asOf=reviewAsOfDate(filter.asOf);
 return rows.filter(row=>{const state=decisionReviewState(row.reviewOn,asOf);return filter.mode==='all'||state===filter.mode;});
}
