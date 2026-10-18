import {cleanupRetainedFileBackup,listRetainedFileBackupGenerations} from './automations/backup-archive-retained-cleanup.ts';
import type {FileBackupServices} from './automations/backup-archive-store.ts';
import {RequestError} from './api-guards.ts';
import {settleUploadBody} from './upload-body-settlement.ts';
import type {SqlDatabase} from './workspace-store.ts';
import {cleanupRetiredFileBackup,listRetiredFileBackups,type BackupArchiveCleanupBucket} from './automations/backup-archive-cleanup.ts';
const headers={'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff'};
export interface RetiredBackupHttpDependencies {db:SqlDatabase;ownerId:string|null;bucket?:BackupArchiveCleanupBucket;fileBackupServices?:FileBackupServices&{bucket:BackupArchiveCleanupBucket};now:()=>string;bodyMs?:number}
type CleanupCommand={action:'retired';id:string;indexHash:string}|{action:'retained';id:string;indexHash:string;generationHash:string};
async function input(request:Request,ms:number):Promise<CleanupCommand>{
 if(request.headers.get('origin')!==new URL(request.url).origin||request.headers.get('sec-fetch-site')==='cross-site')throw new RequestError('Invalid request.',403);
 if(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')throw new RequestError('Invalid request.',415);
 const length=request.headers.get('content-length');if(length!==null&&(!/^[0-9]{1,8}$/u.test(length)||Number(length)>1024))throw new RequestError('Invalid request.',413);
 const reader=request.body?.getReader();if(!reader)throw new RequestError('Invalid request.',400);let timer:ReturnType<typeof setTimeout>|undefined,abort=()=>{},size=0;const chunks:Uint8Array[]=[];
 const stopped=new Promise<never>((_resolve,reject)=>{abort=()=>{void reader.cancel().catch(()=>{});reject(new RequestError('Invalid request.',408));};timer=setTimeout(abort,ms);request.signal.addEventListener('abort',abort,{once:true});});
 try{if(request.signal.aborted)throw new RequestError('Invalid request.',408);const value=await Promise.race([(async()=>{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>1024)throw new RequestError('Invalid request.',413);chunks.push(part.value);}let body:unknown;try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(chunks.flatMap(chunk=>[...chunk]))));}catch{throw new RequestError('Invalid request.',400);}
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.getPrototypeOf(body)!==Object.prototype)throw new RequestError('Invalid request.',400);
  const record=body as Record<string,unknown>,action=Object.hasOwn(record,'action')?record.action:'retired',keys=['id','indexHash','confirmed',...(Object.hasOwn(record,'action')?['action']:[]),...(action==='retained'?['generationHash']:[])];if((action!=='retired'&&action!=='retained')||Object.keys(record).length!==keys.length||!keys.every(key=>Object.hasOwn(record,key))||record.confirmed!==true||typeof record.id!=='string'||record.id.length<1||record.id.length>128||record.id.trim()!==record.id||typeof record.indexHash!=='string'||!/^[a-f0-9]{64}$/u.test(record.indexHash))throw new RequestError('Invalid request.',400);
  if(action==='retained'){if(typeof record.generationHash!=='string'||!/^[a-f0-9]{64}$/u.test(record.generationHash))throw new RequestError('Invalid request.',400);return {action:'retained' as const,id:record.id,indexHash:record.indexHash,generationHash:record.generationHash};}
  return {action:'retired' as const,id:record.id,indexHash:record.indexHash};
 })(),stopped]);return value;
 }finally{clearTimeout(timer);request.signal.removeEventListener('abort',abort);let settlement:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([reader.cancel().catch(()=>{}),new Promise<void>(resolve=>{settlement=setTimeout(resolve,250);})]);}finally{clearTimeout(settlement);try{reader.releaseLock();}catch{}}}
}
/** Owner is supplied solely by the authenticated server route, never a body/header/query claim. */
export async function handleRetiredBackupHttp(request:Request,deps:RetiredBackupHttpDependencies):Promise<Response>{
 try{
  if(!deps.ownerId)return Response.json({error:'Sign in again.',diagnostic:'session_expired'},{status:401,headers});
  const url=new URL(request.url),after=url.searchParams.get('after'),action=url.searchParams.get('action')??'retired';if(after!==null&&(after.length<1||after.length>128||after.trim()!==after||/[\u0000-\u001f\u007f]/u.test(after)))throw new RequestError('Invalid request.',400);if([...url.searchParams.keys()].some(key=>!['after','action'].includes(key))||url.searchParams.getAll('after').length>1||url.searchParams.getAll('action').length>1||!['retired','retained'].includes(action)||request.method==='POST'&&url.search)throw new RequestError('Invalid request.',400);
  if(request.method==='GET'){if(request.headers.get('sec-fetch-site')==='cross-site'||request.headers.get('origin')!==null&&request.headers.get('origin')!==url.origin)throw new RequestError('Invalid request.',403);const options={...(url.searchParams.has('after')?{after:url.searchParams.get('after')!}:{}),limit:25};return Response.json(action==='retained'?await listRetainedFileBackupGenerations(deps.db,deps.ownerId,options):await listRetiredFileBackups(deps.db,deps.ownerId,options),{headers});}
  if(request.method!=='POST')return Response.json({error:'Use the owner cleanup action.'},{status:405,headers:{...headers,Allow:'GET, POST'}});
  const ms=deps.bodyMs??15000;if(!Number.isSafeInteger(ms)||ms<1||ms>15000)throw new Error('Invalid trusted body deadline.');
  const command=await input(request,ms),result=command.action==='retained'?await cleanupRetainedFileBackup(deps.db,deps.ownerId,{id:command.id,indexHash:command.indexHash,generationHash:command.generationHash},{services:deps.fileBackupServices,now:deps.now,signal:request.signal}):await cleanupRetiredFileBackup(deps.db,deps.ownerId,{id:command.id,indexHash:command.indexHash},{bucket:deps.bucket,now:deps.now,signal:request.signal});return Response.json(result,{headers});
 }catch(error){if(error instanceof RequestError)return Response.json({error:'The cleanup request was invalid.',diagnostic:'request_invalid'},{status:error.status,headers});return Response.json({error:'The archive cleanup could not be confirmed. Retained quota and recovery history must be reviewed again.',diagnostic:'cleanup_unconfirmed'},{status:409,headers});}
 finally{if(!request.bodyUsed)await settleUploadBody(request.body);}
}
