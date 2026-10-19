import type {SqlDatabase} from './workspace-store.ts';
export interface WorkspaceNamespaces {auditNamespace:string;blobNamespace:string;cursorSecret:Uint8Array}
export const WORKSPACE_NAMESPACE_READ_SQL='SELECT audit_namespace,blob_namespace,cursor_secret FROM workspace_source_namespaces WHERE user_id=?';
interface NamespaceRow {audit_namespace:string;blob_namespace:string;cursor_secret:string}
const randomUuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function owner(userId:string){if(typeof userId!=='string'||!userId.trim())throw new Error('An authenticated owner is required.');}
function decode(row:NamespaceRow):WorkspaceNamespaces {
 // Invalid persisted authority is never silently rotated: old cursors and provenance must remain attributable.
 if(!randomUuid.test(row.audit_namespace)||!randomUuid.test(row.blob_namespace)||row.audit_namespace===row.blob_namespace||typeof row.cursor_secret!=='string'||!/^[a-f0-9]{64}$/.test(row.cursor_secret))throw new Error('Workspace namespace configuration is invalid.');
 const cursorSecret=new Uint8Array(32);for(let index=0;index<cursorSecret.length;index++)cursorSecret[index]=Number.parseInt(row.cursor_secret.slice(index*2,index*2+2),16);
 return {auditNamespace:row.audit_namespace,blobNamespace:row.blob_namespace,cursorSecret};
}
/** Server-only owner-scoped authority. Never export this configuration row or secret. Portable attachment source keys remain metadata claims; target availability requires rekeying and verification. */
export async function getWorkspaceNamespaces(db:SqlDatabase,userId:string):Promise<WorkspaceNamespaces|null>{
 owner(userId);const row=await db.prepare(WORKSPACE_NAMESPACE_READ_SQL).bind(userId).first<NamespaceRow>();return row?decode(row):null;
}
/** Concurrent initializers converge on the single persisted owner row, rather than returning losing candidates. */
export async function getOrCreateWorkspaceNamespaces(db:SqlDatabase,userId:string):Promise<WorkspaceNamespaces>{
 const existing=await getWorkspaceNamespaces(db,userId);if(existing)return existing;
 const auditNamespace=crypto.randomUUID(),blobNamespace=crypto.randomUUID();const secret=crypto.getRandomValues(new Uint8Array(32));const hex=Array.from(secret,value=>value.toString(16).padStart(2,'0')).join('');
 await db.prepare('INSERT INTO workspace_source_namespaces(user_id,audit_namespace,blob_namespace,cursor_secret) VALUES(?,?,?,?) ON CONFLICT(user_id) DO NOTHING').bind(userId,auditNamespace,blobNamespace,hex).run();
 const persisted=await getWorkspaceNamespaces(db,userId);if(!persisted)throw new Error('Workspace namespace configuration could not be confirmed.');return persisted;
}
