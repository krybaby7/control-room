import { z } from 'zod';
import type { EntityTarget } from './entity-links.ts';
export const SEARCH_STATUSES=['proposed','todo','doing','review','done','planned','active','achieved','inbox','filed','archived'] as const;
export interface SearchState {query:string;entity:''|EntityTarget['kind'];projectId:string;status:''|typeof SEARCH_STATUSES[number];includeArchived:boolean;page:number;}
export const SEARCH_STATE_LIMITS=Object.freeze({queryCharacters:200,tokens:20,page:64,projectId:128,urlCharacters:4096});
export const DEFAULT_SEARCH_STATE:Readonly<SearchState>=Object.freeze({query:'',entity:'',projectId:'',status:'',includeArchived:false,page:1});
export function isValidSearchQuery(query:string):boolean{return query.length<=SEARCH_STATE_LIMITS.queryCharacters&&query.normalize('NFKC').trim().split(/\s+/).filter(Boolean).length<=SEARCH_STATE_LIMITS.tokens;}
const schema=z.object({query:z.string().refine(isValidSearchQuery,'Search supports up to 200 characters and 20 words.'),entity:z.enum(['','project','milestone','task','capture']),projectId:z.string().max(128).refine(value=>value.trim()===value),status:z.enum(['',...SEARCH_STATUSES]),includeArchived:z.boolean(),page:z.number().int().min(1).max(64)}).strict();
/** Copyable owner-side navigation only. Search terms never enter telemetry. */
export function encodeSearchState(value:SearchState):string {
 const state=schema.parse(value),query=new URLSearchParams({view:'search'});
 if(state.query)query.set('q',state.query);if(state.entity)query.set('type',state.entity);if(state.projectId)query.set('project',state.projectId);if(state.status)query.set('status',state.status);if(state.includeArchived)query.set('archived','1');if(state.page!==1)query.set('page',String(state.page));
 const href=`/?${query}`;if(href.length>SEARCH_STATE_LIMITS.urlCharacters)throw new Error('Search URL exceeds limit.');return href;
}
/** Ambiguous, oversized or malformed known parameters return a neutral bounded default. */
export function parseSearchState(params:URLSearchParams):SearchState {
 const defaults=()=>({...DEFAULT_SEARCH_STATE});
 if(!(params instanceof URLSearchParams)||params.toString().length>SEARCH_STATE_LIMITS.urlCharacters)return defaults();
 const keys=['view','q','type','project','status','archived','page'];
 if(keys.some(key=>params.getAll(key).length>1)||params.has('view')&&params.get('view')!=='search'||params.has('archived')&&params.get('archived')!=='1'||params.has('page')&&!/^[1-9]\d{0,2}$/.test(params.get('page')!))return defaults();
 const parsed=schema.safeParse({query:params.get('q')??'',entity:params.get('type')??'',projectId:params.get('project')??'',status:params.get('status')??'',includeArchived:params.get('archived')==='1',page:params.has('page')?Number(params.get('page')):1});
 return parsed.success?parsed.data:defaults();
}
