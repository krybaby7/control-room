import {canonical,contentHash} from '../canonical-json.ts';
import {readCurrent,type SqlDatabase} from '../workspace-store.ts';
import {getProjectBaseline} from '../project-baselines.ts';
import {evidenceIdSchema} from '../evidence-validation.ts';
import {baselinePreviewInputSchema,baselineRevisionSchema} from './validation.ts';
import type {ProjectBaselineRevision} from './contracts.ts';
export const baselineHeaders={'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff'};
export class BaselineHttpError extends Error {status:number;constructor(message:string,status:number){super(message);this.status=status;}}
export interface BaselineHistoryPage {projectId:string;bundled:ReturnType<typeof getProjectBaseline>;head:{id:string;hash:string}|null;items:Array<{value:ProjectBaselineRevision;hash:string}>;nextAfter:string|null}
export function baselineHistoryQuery(url:URL){for(const key of url.searchParams.keys())if(!['projectId','after'].includes(key)||url.searchParams.getAll(key).length!==1)throw new BaselineHttpError('Invalid baseline history query.',400);return {projectId:evidenceIdSchema.parse(url.searchParams.get('projectId')),after:url.searchParams.has('after')?evidenceIdSchema.parse(url.searchParams.get('after')):undefined};}
interface Row {id:string;payload_json:string;content_hash:string;project_id:string;recorded_at:string}
async function checked(row:Row,projectId:string){const value=baselineRevisionSchema.parse(JSON.parse(row.payload_json));if(value.id!==row.id||value.projectId!==projectId||row.project_id!==projectId||value.recordedAt!==row.recorded_at||await contentHash(canonical(value))!==row.content_hash)throw new Error('Baseline history integrity differs.');return {value,hash:row.content_hash};}
/** Imported history never becomes an active head merely by appearing in this list. */
export async function readBaselineHistory(db:SqlDatabase,owner:string,input:{projectId:string;after?:string},now:string):Promise<BaselineHistoryPage>{
 if(!owner||owner.trim()!==owner||owner.length>256||/[\u0000-\u001f\u007f]/u.test(owner))throw new Error('Authenticated owner required.');const projectId=evidenceIdSchema.parse(input.projectId),after=input.after===undefined?'':evidenceIdSchema.parse(input.after);
 const before=await readCurrent(db,owner,now),project=before.workspace.projects.find(p=>p.id===projectId);if(!project)throw new BaselineHttpError('Project is unavailable.',404);
 const head=await db.prepare('SELECT revision_id,content_hash,recorded_at FROM project_baseline_heads WHERE user_id=? AND project_id=?').bind(owner,projectId).first<{revision_id:string;content_hash:string;recorded_at:string}>();
 const page:BaselineHistoryPage={projectId,bundled:getProjectBaseline(project),head:null,items:[],nextAfter:null};
 if(head){const row=await db.prepare('SELECT id,payload_json,content_hash,project_id,recorded_at FROM project_baseline_revisions WHERE user_id=? AND id=? AND project_id=?').bind(owner,head.revision_id,projectId).first<Row>();if(!row||row.content_hash!==head.content_hash||row.recorded_at!==head.recorded_at)throw new Error('Baseline head unavailable.');await checked(row,projectId);page.head={id:head.revision_id,hash:head.content_hash};}
 // Fetch one bounded row at a time: fifty large prose records must not materialize as an unbounded page.
 let cursor=after;for(let index=0;index<51;index++){const row=await db.prepare('SELECT id,payload_json,content_hash,project_id,recorded_at FROM project_baseline_revisions WHERE user_id=? AND project_id=? AND id>? ORDER BY id LIMIT 1').bind(owner,projectId,cursor).first<Row>();if(!row)break;if(index===50){page.nextAfter=cursor;break;}const item=await checked(row,projectId);page.items.push(item);if(new TextEncoder().encode(JSON.stringify(page)).byteLength>1900000){page.items.pop();if(!page.items.length)throw new Error('Baseline record exceeds response bounds.');page.nextAfter=cursor;break;}cursor=row.id;}
 const currentHead=await db.prepare('SELECT revision_id,content_hash,recorded_at FROM project_baseline_heads WHERE user_id=? AND project_id=?').bind(owner,projectId).first();if((await readCurrent(db,owner,now)).revision!==before.revision||canonical(currentHead)!==canonical(head))throw new BaselineHttpError('Workspace changed. Refresh baseline history.',409);return page;
}
export async function readBaselinePreviewInput(request:Request){
 if(request.headers.get('origin')!==new URL(request.url).origin)throw new BaselineHttpError('Same-origin request required.',403);if(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')throw new BaselineHttpError('JSON required.',415);
 const declared=request.headers.get('content-length');if(declared&&(!/^\d+$/.test(declared)||Number(declared)>65536))throw new BaselineHttpError('Preview body exceeds limit.',413);if(!request.body)throw new BaselineHttpError('Preview input required.',400);
 const reader=request.body.getReader(),chunks:Uint8Array[]=[];let size=0;let timer:ReturnType<typeof setTimeout>|undefined;
 try{await Promise.race([(async()=>{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>65536)throw new BaselineHttpError('Preview body exceeds limit.',413);chunks.push(part.value);}})(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new BaselineHttpError('Preview request timed out.',408)),15000);})]);const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}let raw:unknown;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new BaselineHttpError('Invalid preview JSON.',400);}return baselinePreviewInputSchema.parse(raw);}finally{if(timer)clearTimeout(timer);void reader.cancel().catch(()=>{});}
}
