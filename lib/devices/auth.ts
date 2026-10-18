import type {SqlDatabase} from '../workspace-store.ts';
import {canonical,contentHash} from '../canonical-json.ts';
import {evidenceDateSchema} from '../evidence-validation.ts';
import type {DevicePrincipal,DeviceScope,PrivateIngressVerifier} from './contracts.ts';
import {deviceDisplaySchema,devicePrincipalSchema,deviceScopeSchema} from './validation.ts';
export interface DeviceSqlGuard {sql:string;bindings:(string|number|null)[]}
export function equalDeviceDigest(left:string,right:string):boolean{if(!/^[a-f0-9]{64}$/.test(left)||!/^[a-f0-9]{64}$/.test(right))return false;let difference=0;for(let i=0;i<64;i++)difference|=left.charCodeAt(i)^right.charCodeAt(i);return difference===0;}
function all(clauses:string[]):string{if(clauses.length===1)return clauses[0];const middle=Math.floor(clauses.length/2);return '('+all(clauses.slice(0,middle))+' AND '+all(clauses.slice(middle))+')';}
/** Private rate buckets only. Identity is trusted ingress/device identity, never a token or arbitrary client key. */
export async function admitDeviceRequest(db:SqlDatabase,identity:string,now:string,limit=120):Promise<boolean>{
 if(typeof identity!=='string'||!identity||identity.length>512||!evidenceDateSchema.safeParse(now).success||!Number.isSafeInteger(limit)||limit<1||limit>1000)return false;
 const key=await contentHash(identity),minute=now.slice(0,16)+':00.000Z',cutoff=new Date(Date.parse(now)-120000).toISOString();
 // Bounded deletion keeps rate metadata finite; it never deletes owner data.
 const cleanup=db.prepare('DELETE FROM device_rate_buckets WHERE rowid IN(SELECT rowid FROM device_rate_buckets WHERE bucket_at<? ORDER BY bucket_at LIMIT 256)').bind(cutoff);
 const write=db.prepare('INSERT INTO device_rate_buckets(bucket_key,bucket_at,count) SELECT ?,?,1 WHERE (SELECT COUNT(*) FROM device_rate_buckets)<4096 ON CONFLICT(bucket_key,bucket_at) DO UPDATE SET count=count+1 WHERE count<?').bind(key,minute,limit);
 const result=await db.batch([cleanup,write]);return result[1]?.meta.changes===1;
}
/** A caller must have authenticated private ingress and the opaque device credential first.
 * Re-read exact authority so every later atomic effect can also embed this SQL predicate. */
export async function deviceAuthorityGuard(db:SqlDatabase,raw:DevicePrincipal,now:string):Promise<DeviceSqlGuard|null>{
 const parsed=devicePrincipalSchema.safeParse(raw);if(!parsed.success||!evidenceDateSchema.safeParse(now).success)return null;const principal=parsed.data;
 const row=await db.prepare('SELECT c.token_hash,c.scopes_json,c.execution_epoch,c.created_at,c.expires_at,c.rotation_retire_at,c.revoked_at,d.row_revision,d.payload_json,d.content_hash,d.archived_at,r.execution_epoch runtime_epoch,r.revoked_at runtime_revoked FROM device_credentials c JOIN devices d ON d.user_id=c.user_id AND d.id=c.device_id JOIN device_runtime r ON r.user_id=d.user_id AND r.device_id=d.id WHERE c.user_id=? AND c.device_id=? AND c.id=?').bind(principal.ownerId,principal.deviceId,principal.credentialId).first<{token_hash:string;scopes_json:string;execution_epoch:number;created_at:string;expires_at:string;rotation_retire_at:string|null;revoked_at:string|null;row_revision:number;payload_json:string;content_hash:string;archived_at:string|null;runtime_epoch:number;runtime_revoked:string|null}>();
 if(!row)return null;try{
  const display=deviceDisplaySchema.parse(JSON.parse(row.payload_json)),scopes=JSON.parse(row.scopes_json) as unknown;
  if(display.id!==principal.deviceId||display.archivedAt!==null||row.archived_at!==null||await contentHash(canonical(display))!==row.content_hash||!Number.isSafeInteger(row.row_revision)||row.row_revision<1||!equalDeviceDigest(row.token_hash,row.token_hash)||canonical(scopes)!==canonical(principal.scopes)||row.revoked_at!==null||row.runtime_revoked!==null||!Number.isSafeInteger(row.execution_epoch)||row.execution_epoch<0||row.runtime_epoch!==row.execution_epoch)return null;
  for(const stamp of [row.created_at,row.expires_at,...(row.rotation_retire_at===null?[]:[row.rotation_retire_at])])if(!evidenceDateSchema.safeParse(stamp).success)return null;
  if(Date.parse(row.created_at)>Date.parse(now)||Date.parse(row.expires_at)<=Date.parse(now)||row.rotation_retire_at!==null&&Date.parse(row.rotation_retire_at)<=Date.parse(now))return null;
 }catch{return null;}
 const clauses=['c.user_id=?','c.device_id=?','c.id=?','c.token_hash=?','c.scopes_json=?','c.execution_epoch=?','c.created_at=?','c.expires_at=?','c.rotation_retire_at IS ?','c.revoked_at IS NULL','julianday(c.created_at)<=julianday(?)','julianday(c.expires_at)>julianday(?)','(c.rotation_retire_at IS NULL OR julianday(c.rotation_retire_at)>julianday(?))','d.row_revision=?','d.content_hash=?','d.payload_json=?','d.archived_at IS NULL','r.revoked_at IS NULL','r.execution_epoch=c.execution_epoch','c.execution_epoch=COALESCE((SELECT epoch FROM workspace_execution_state WHERE user_id=c.user_id),0)'];
 const guard={sql:'EXISTS(SELECT 1 FROM device_credentials c JOIN devices d ON d.user_id=c.user_id AND d.id=c.device_id JOIN device_runtime r ON r.user_id=d.user_id AND r.device_id=d.id WHERE '+all(clauses)+')',bindings:[principal.ownerId,principal.deviceId,principal.credentialId,row.token_hash,row.scopes_json,row.execution_epoch,row.created_at,row.expires_at,row.rotation_retire_at,now,now,now,row.row_revision,row.content_hash,row.payload_json]};
 return await db.prepare('SELECT 1 WHERE '+guard.sql).bind(...guard.bindings).first()?guard:null;
}
/** Gateway identity and application device identity are separate, mandatory gates. No browser owner is inferred. */
export async function authenticateDevice(request:Request,requiredScope:DeviceScope,db:SqlDatabase,ingress:PrivateIngressVerifier,now:string):Promise<DevicePrincipal|null>{
 if(!deviceScopeSchema.safeParse(requiredScope).success||!evidenceDateSchema.safeParse(now).success)return null;
 let verified:{serviceIdentity:string}|null;try{verified=await ingress.verify(request);}catch{return null;}
 if(!verified||typeof verified.serviceIdentity!=='string'||!verified.serviceIdentity||verified.serviceIdentity.length>256)return null;
 if(!await admitDeviceRequest(db,'device-ingress:'+verified.serviceIdentity,now,600))return null;
 const token=request.headers.get('X-Control-Room-Device');if(request.headers.has('Cookie')||typeof token!=='string'||!/^[A-Za-z0-9_-]{32,512}$/.test(token))return null;
 const hash=await contentHash(token),rows=(await db.prepare('SELECT user_id,device_id,id,token_hash,scopes_json FROM device_credentials WHERE token_hash=? LIMIT 2').bind(hash).all<{user_id:string;device_id:string;id:string;token_hash:string;scopes_json:string}>()).results;
 if(rows.length!==1||!equalDeviceDigest(rows[0].token_hash,hash))return null;
 let principal:DevicePrincipal;try{principal=devicePrincipalSchema.parse({ownerId:rows[0].user_id,deviceId:rows[0].device_id,credentialId:rows[0].id,scopes:JSON.parse(rows[0].scopes_json)});}catch{return null;}
 if(!principal.scopes.includes(requiredScope)||!await admitDeviceRequest(db,'device:'+principal.ownerId+':'+principal.deviceId,now))return null;
 return await deviceAuthorityGuard(db,principal,now)?principal:null;
}
