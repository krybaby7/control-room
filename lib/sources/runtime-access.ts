import type {SqlDatabase} from '../workspace-store.ts';
import type {SourceConnection,SourceTarget} from './contracts.ts';
import {sourceConnectionSchema,sourceTargetSchema} from './validation.ts';
import {canonical,contentHash} from '../canonical-json.ts';
/** Server-only, owner-bound revalidation. A portable selection is never an access grant. */
export async function canResumeSource(db:SqlDatabase,owner:string,connection:SourceConnection,target:SourceTarget,now:string):Promise<boolean>{
 if(!owner)throw new Error('An authenticated owner is required.');
 const c=sourceConnectionSchema.parse(connection),t=sourceTargetSchema.parse(target);if(!c.enabled||c.archivedAt||t.archivedAt||t.connectionId!==c.id)return false;
 const current=await db.prepare('SELECT t.content_hash target_hash,c.content_hash connection_hash FROM source_targets t JOIN source_connections c ON c.user_id=t.user_id AND c.id=t.connection_id WHERE t.user_id=? AND t.id=? AND c.id=?').bind(owner,t.id,c.id).first<{target_hash:string;connection_hash:string}>();
 if(!current||current.target_hash!==await contentHash(canonical(t))||current.connection_hash!==await contentHash(canonical(c)))return false;
 if(c.accessMode==='interactive'&&((t.kind==='document'&&c.provider==='documents')||(t.kind==='conversation_export'&&c.provider==='conversation-export')))return true;
 const grant=await db.prepare('SELECT principal_ref,resource_scope_json FROM source_access_grants WHERE user_id=? AND connection_id=? AND mode=? AND revoked_at IS NULL AND julianday(verified_at)<=julianday(?) AND julianday(expires_at)>julianday(?)').bind(owner,c.id,c.accessMode,now,now).first<{principal_ref:string;resource_scope_json:string}>();if(!grant)return false;
 try{const resources:unknown=JSON.parse(grant.resource_scope_json);if(!Array.isArray(resources)||resources.length>100||resources.some(value=>typeof value!=='string'||!value||value.length>512)||new Set(resources).size!==resources.length||!resources.includes(t.providerResourceId))return false;}catch{return false;}
 if(c.accessMode==='interactive')return true;
 const principal=await db.prepare('SELECT scope_json FROM integration_service_principals WHERE user_id=? AND id=? AND revoked_at IS NULL AND julianday(renewable_verified_at)<=julianday(?) AND julianday(expires_at)>julianday(?)').bind(owner,grant.principal_ref,now,now).first<{scope_json:string}>();
 try{return !!principal&&canonical(JSON.parse(principal.scope_json))===canonical(['source:read']);}catch{return false;}
}
