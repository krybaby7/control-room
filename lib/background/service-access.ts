import type {SqlDatabase} from '../workspace-store.ts';
import type {IntegrationPrincipal} from './job-contract.ts';
import {evidenceDateSchema} from '../evidence-validation.ts';
import {contentHash} from '../canonical-json.ts';
/** Bounded opaque server token only; the returned authority never includes credential material. */
function bearer(value:unknown):string|null{if(typeof value!=='string'||value.length>520)return null;const match=/^Bearer ([A-Za-z0-9_-]{32,512})$/.exec(value);return match?.[1]??null;}
function equalDigest(left:string,right:string):boolean{if(!/^[a-f0-9]{64}$/.test(left)||right.length!==64)return false;let difference=0;for(let i=0;i<64;i++)difference|=left.charCodeAt(i)^right.charCodeAt(i);return difference===0;}
/** Read-only authentication, not provisioning or provider access. The owner comes from the trusted route scope.
 * A portable connection, supplied principal ID, or renewable claim cannot establish this authority.
 * No principal is available unless its exact private renewable registration is currently valid.
 */
export async function authenticateSourceServicePrincipal(db:SqlDatabase,ownerId:string,authorization:unknown,now:string):Promise<IntegrationPrincipal|null>{
 const token=bearer(authorization);if(!token||typeof ownerId!=='string'||!ownerId||ownerId.length>256||ownerId.trim()!==ownerId||/[\u0000-\u001f\u007f]/u.test(ownerId)||!evidenceDateSchema.safeParse(now).success)return null;
 const digest=await contentHash(token);
 const rows=(await db.prepare('SELECT id,token_hash,scope_json,expires_at,revoked_at,renewable_verified_at FROM integration_service_principals WHERE user_id=? AND token_hash=? LIMIT 2').bind(ownerId,digest).all<{id:string;token_hash:string;scope_json:string;expires_at:string;revoked_at:string|null;renewable_verified_at:string}>()).results;
 if(rows.length!==1)return null;const row=rows[0];
 if(typeof row.id!=='string'||!row.id||row.id.length>128||row.id.trim()!==row.id||/[\u0000-\u001f\u007f]/u.test(row.id)||!equalDigest(row.token_hash,digest)||row.revoked_at!==null||!evidenceDateSchema.safeParse(row.expires_at).success||!evidenceDateSchema.safeParse(row.renewable_verified_at).success||Date.parse(row.expires_at)<=Date.parse(now)||Date.parse(row.renewable_verified_at)>Date.parse(now)||Date.parse(row.renewable_verified_at)>=Date.parse(row.expires_at)||typeof row.scope_json!=='string'||row.scope_json.length>128)return null;
 let scope:unknown;try{scope=JSON.parse(row.scope_json);}catch{return null;}if(!Array.isArray(scope)||scope.length!==1||scope[0]!=='source:read')return null;
 return {ownerId,principalId:row.id,scope:['source:read'],expiresAt:row.expires_at};
}
/** Global unique-hash lookup derives owner scope; no request-supplied owner is accepted. */
export async function authenticateSourceServiceToken(db:SqlDatabase,serviceToken:unknown,now:string):Promise<IntegrationPrincipal|null>{
 if(typeof serviceToken!=='string'||!bearer(`Bearer ${serviceToken}`))return null;
 const hash=await contentHash(serviceToken),rows=(await db.prepare('SELECT user_id FROM integration_service_principals WHERE token_hash=? LIMIT 2').bind(hash).all<{user_id:string}>()).results;
 if(rows.length!==1)return null;return authenticateSourceServicePrincipal(db,rows[0].user_id,`Bearer ${serviceToken}`,now);
}

class ServiceBodyTimeout extends Error {}
async function serviceBody(request:Request,timeoutMs:number):Promise<Uint8Array>{
 const reader=request.body?.getReader();if(!reader)throw new Error('Missing body.');let timer:ReturnType<typeof setTimeout>|undefined;
 const read=async()=>{let size=0;const chunks:Uint8Array[]=[];for(;;){const result=await reader.read();if(result.done)break;size+=result.value.byteLength;if(size>1024)throw new Error('Body limit exceeded.');chunks.push(result.value);}const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes;};
 try{return await Promise.race([read(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new ServiceBodyTimeout()),timeoutMs);})]);}
 catch(error){let settleTimer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([reader.cancel().catch(()=>{}),new Promise<void>(resolve=>{settleTimer=setTimeout(resolve,100);})]);}finally{if(settleTimer!==undefined)clearTimeout(settleTimer);}throw error;}
 finally{if(timer!==undefined)clearTimeout(timer);try{reader.releaseLock();}catch{/* A nonconforming body may still have a pending read after cancellation. */}}
}
const serviceHeaders={'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff'};
/** Separate app service authentication; gateway Authorization remains the private ingress's concern.
 * Browser cookies cannot authorize or accompany this endpoint. No visitor/owner session is consulted.
 */
export async function handleSourceServiceJobRequest(request:Request,db:SqlDatabase|null,now:()=>string,options:{bodyTimeoutMs?:number}={}):Promise<Response>{
 const bodyTimeoutMs=options.bodyTimeoutMs??15_000;if(!Number.isSafeInteger(bodyTimeoutMs)||bodyTimeoutMs<1||bodyTimeoutMs>15_000)throw new Error('Invalid service body deadline.');
 const response=(body:unknown,status:number)=>Response.json(body,{status,headers:serviceHeaders});
 if(request.method!=='POST')return response({error:'Method unavailable.'},405);
 if(!db)return response({error:'Service unavailable.'},503);
 if(request.headers.has('cookie'))return response({error:'Service authentication required.'},401);
 let principal:IntegrationPrincipal|null;try{principal=await authenticateSourceServiceToken(db,request.headers.get('X-Control-Room-Service-Token'),now());}catch{return response({error:'Service unavailable.'},503);}if(!principal)return response({error:'Service authentication required.'},401);
 if(new URL(request.url).search||!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type')??''))return response({error:'Invalid request.'},400);
 let command:{intentId:string};try{const bytes=await serviceBody(request,bodyTimeoutMs);const value:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==1||!Object.hasOwn(value,'intentId'))throw new Error();const id=(value as {intentId:unknown}).intentId;if(typeof id!=='string'||!id||id.length>128||id.trim()!==id||/[\u0000-\u001f\u007f]/u.test(id))throw new Error();command={intentId:id};}catch(error){return error instanceof ServiceBodyTimeout?response({error:'Request body timed out.'},408):response({error:'Invalid request.'},400);}
 try{const {runIntegrationJob}=await import('./job-runner.ts');const result=await runIntegrationJob(db,principal.ownerId,command.intentId,{authority:{mode:'unattended',principal},now});
  // Private engine results include lease claims and uncertain pending payloads: never return those.
  const status=result.status==='completed'?200:result.status==='partial'?202:result.status==='conflict'||result.status==='cancelled'?409:result.status==='failed'?502:503;
  return response({status:result.status,...('reason' in result?{reason:result.reason}:{})},status);
 }catch{return response({error:'Service run unavailable.'},503);}
}
