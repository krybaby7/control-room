import type {SqlDatabase} from '../workspace-store.ts';
import {agentIdSchema} from './contracts.ts';
import {readAgentJobDetail,readAgentJobEvents} from './detail-store.ts';
export const ownerJobReadHeaders={'Cache-Control':'no-store, private','Pragma':'no-cache','X-Content-Type-Options':'nosniff'};
/** Authenticated owner comes from the session adapter, never request JSON. */
export async function handleOwnerJobRead(request:Request,owner:string|null,db:SqlDatabase|null,jobId:string,now:string,events=false):Promise<Response>{
 const reply=(value:unknown,status=200)=>Response.json(value,{status,headers:ownerJobReadHeaders});
 if(!owner)return reply({error:'Sign in again.'},401);
 if(request.method!=='GET')return new Response(null,{status:405,headers:{...ownerJobReadHeaders,Allow:'GET'}});
 if(!db)return reply({error:'Agent storage is unavailable.'},503);
 const parsed=agentIdSchema.safeParse(jobId);if(!parsed.success)return reply({error:'Job unavailable.'},404);
 const query=new URL(request.url).searchParams,allowed=events?['attemptId','afterSequence']:[];
 if([...query.keys()].some(key=>!allowed.includes(key))||allowed.some(key=>query.getAll(key).length>1))return reply({error:'Invalid job page.'},400);
 const id=query.get('attemptId'),after=query.get('afterSequence')??'0';
 if(events&&(!agentIdSchema.safeParse(id).success||! /^(0|[1-9][0-9]{0,3})$/.test(after)||Number(after)>1024))return reply({error:'Invalid event page.'},400);
 try{const value=events?await readAgentJobEvents(db,owner,jobId,id!,now,Number(after)):await readAgentJobDetail(db,owner,jobId,now);return value?reply(value):reply({error:'Job unavailable.'},404);}
 catch{return reply({error:'Job history is unavailable. Refresh again.'},503);}
}
