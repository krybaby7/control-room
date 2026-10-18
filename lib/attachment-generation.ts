import {z} from 'zod';
import type {SqlDatabase} from './workspace-store.ts';
import {ATTACHMENT_POLICY} from './attachment-policy.ts';
import {evidenceDateSchema} from './evidence-validation.ts';
/** SQL expressions are fixed server-owned identifiers/aliases only, never request strings. */
export interface AttachmentGenerationFields {owner:string;attachmentId:string;storageKey:string;bytes:string;sha256:string}
export interface VerifiedImportSql {id:string;hash:string;targetRevision:string;now:string}
const identifier=/^(?:(?:[A-Za-z_][A-Za-z0-9_]*\.)?[A-Za-z_][A-Za-z0-9_]*|json_extract\((?:[A-Za-z_][A-Za-z0-9_]*\.)?[A-Za-z_][A-Za-z0-9_]*,'\$\.(?:id|storageKey|expectedBytes|bytes|sha256)'\))$/;
function fields(value:AttachmentGenerationFields){for(const expression of Object.values(value))if(!identifier.test(expression))throw new Error('Generation predicates require trusted SQL aliases.');}
/** Historical safety only, NOT authority for the current key/stage. Cleanup must separately bind its exact key/token.
 * Excludes the current key so a legitimate cleanup claim can use this after inserting its own permanent fence.
 * A purged unverified archive orphan may share identity only with independent verified historical proof;
 * each old permanent fence still requires verified proof for its own exact key.
 */
export function attachmentPriorGenerationSql(f:AttachmentGenerationFields):string {
 fields(f);
 const oldFence=`generation_old_fence.user_id=${f.owner} AND generation_old_fence.attachment_id=${f.attachmentId} AND generation_old_fence.storage_key<>${f.storageKey}`;
 const oldIdentity=`generation_identity.user_id=${f.owner} AND generation_identity.attachment_id=${f.attachmentId} AND generation_identity.storage_key<>${f.storageKey}`;
 const purgedIdentity=`${oldIdentity} AND generation_identity.purged_at IS NOT NULL`;
 // Separate veto branches bound D1 expression depth. Group at most three SELECT terms
 // per compound query: D1 also limits compound SELECT width below desktop SQLite.
 const vetoSql=`SELECT 1 FROM attachment_blob_fences generation_old_fence WHERE ${oldFence} AND (generation_old_fence.purged_at IS NULL OR julianday(generation_old_fence.created_at) IS NULL OR julianday(generation_old_fence.purged_at) IS NULL OR julianday(generation_old_fence.purged_at)<julianday(generation_old_fence.created_at))
 UNION ALL SELECT 1 FROM attachment_blob_fences generation_old_fence WHERE ${oldFence} AND NOT EXISTS(
 SELECT 1 FROM attachment_blob_objects generation_history WHERE (generation_history.user_id,generation_history.storage_key,generation_history.namespace,generation_history.attachment_id,generation_history.bytes,generation_history.sha256)=(generation_old_fence.user_id,generation_old_fence.storage_key,generation_old_fence.namespace,${f.attachmentId},${f.bytes},${f.sha256}) AND generation_history.verified_at IS NOT NULL AND julianday(generation_history.verified_at) IS NOT NULL AND generation_history.purged_at IS NOT NULL AND julianday(generation_history.purged_at)>=julianday(generation_history.verified_at))
 UNION ALL SELECT 1 FROM attachment_upload_attempts generation_pending WHERE generation_pending.user_id=${f.owner} AND generation_pending.attachment_id=${f.attachmentId} AND generation_pending.settled_at IS NULL
 UNION ALL SELECT 1 FROM attachment_blob_objects generation_identity WHERE ${oldIdentity} AND generation_identity.bytes<>${f.bytes}
 UNION ALL SELECT 1 FROM attachment_blob_objects generation_identity WHERE ${oldIdentity} AND generation_identity.sha256 IS NOT NULL AND generation_identity.sha256<>${f.sha256}
 UNION ALL SELECT 1 FROM attachment_blob_objects generation_identity WHERE ${purgedIdentity} AND (generation_identity.sha256 IS NULL OR julianday(generation_identity.purged_at) IS NULL OR julianday(generation_identity.created_at) IS NULL OR julianday(generation_identity.purged_at)<julianday(generation_identity.created_at))
 UNION ALL SELECT 1 FROM attachment_blob_objects generation_identity WHERE ${purgedIdentity} AND generation_identity.verified_at IS NOT NULL AND (julianday(generation_identity.verified_at) IS NULL OR julianday(generation_identity.purged_at)<julianday(generation_identity.verified_at))
 UNION ALL SELECT 1 FROM attachment_blob_objects generation_identity WHERE ${purgedIdentity} AND generation_identity.verified_at IS NULL AND NOT EXISTS(
 SELECT 1 FROM attachment_blob_namespaces generation_orphan_namespace WHERE generation_orphan_namespace.user_id=generation_identity.user_id AND generation_orphan_namespace.namespace=generation_identity.namespace AND generation_orphan_namespace.purpose='archive-stage' AND generation_identity.storage_key='attachments/'||generation_orphan_namespace.namespace||'/'||${f.attachmentId})
 UNION ALL SELECT 1 FROM attachment_blob_objects generation_identity WHERE ${purgedIdentity} AND generation_identity.verified_at IS NULL AND NOT EXISTS(
 SELECT 1 FROM attachment_blob_objects generation_independent WHERE (generation_independent.user_id,generation_independent.attachment_id,generation_independent.bytes,generation_independent.sha256)=(${f.owner},${f.attachmentId},${f.bytes},${f.sha256}) AND generation_independent.storage_key<>${f.storageKey} AND generation_independent.storage_key<>generation_identity.storage_key AND generation_independent.verified_at IS NOT NULL AND julianday(generation_independent.verified_at) IS NOT NULL AND (generation_independent.purged_at IS NULL OR julianday(generation_independent.purged_at)>=julianday(generation_independent.verified_at)))`;
 const vetoes=vetoSql.split("\n UNION ALL ");const groups=[];for(let i=0;i<vetoes.length;i+=3)groups.push(`NOT EXISTS(${vetoes.slice(i,i+3).join(" UNION ALL ")})`);return `(${groups.join(" AND ")})`;

}
/** Full new-generation admission. Verified stages require the exact current reviewed import authority;
 * default access accepts committed stages only. This never permits ordinary base-key uploads or raw JSON claims.
 */
export function attachmentGenerationSql(f:AttachmentGenerationFields,verifiedImport?:VerifiedImportSql):string {
 fields(f);if(verifiedImport)for(const expression of Object.values(verifiedImport))if(!identifier.test(expression))throw new Error('Import predicates require trusted SQL aliases.');
 const verified=verifiedImport?` OR (generation_stage.status='verified' AND (generation_stage.import_id,generation_stage.import_hash,generation_stage.target_revision)=(${verifiedImport.id},${verifiedImport.hash},${verifiedImport.targetRevision}) AND generation_stage.expires_at>${verifiedImport.now} AND EXISTS(SELECT 1 FROM workspaces generation_workspace WHERE generation_workspace.user_id=${f.owner} AND generation_workspace.revision=${verifiedImport.targetRevision}))`:'';
 return `(${attachmentPriorGenerationSql(f)}
 AND NOT EXISTS(SELECT 1 FROM attachment_blob_fences generation_exact_fence WHERE generation_exact_fence.storage_key=${f.storageKey})
 AND NOT EXISTS(SELECT 1 FROM attachment_archive_cleanup_claims generation_cleanup WHERE generation_cleanup.storage_key=${f.storageKey})
 AND EXISTS(SELECT 1 FROM attachment_blob_namespaces generation_namespace JOIN attachment_archive_stages generation_stage ON generation_stage.user_id=generation_namespace.user_id AND generation_stage.namespace=generation_namespace.namespace JOIN attachment_blob_objects generation_object ON generation_object.user_id=generation_namespace.user_id AND generation_object.namespace=generation_namespace.namespace
 WHERE (generation_namespace.user_id,generation_namespace.purpose,generation_object.storage_key,generation_object.attachment_id,generation_object.bytes,generation_object.sha256)=(${f.owner},'archive-stage',${f.storageKey},${f.attachmentId},${f.bytes},${f.sha256}) AND generation_object.storage_key='attachments/'||generation_namespace.namespace||'/'||${f.attachmentId} AND generation_object.verified_at IS NOT NULL AND julianday(generation_object.verified_at) IS NOT NULL AND generation_object.purged_at IS NULL AND (generation_stage.status='committed'${verified})))`;
}
const inputSchema=z.object({attachmentId:z.string().uuid(),storageKey:z.string().min(1).max(500),bytes:z.number().int().nonnegative().max(ATTACHMENT_POLICY.fileBytes),sha256:z.string().regex(/^[a-f0-9]{64}$/),verifiedImport:z.object({id:z.string().min(1).max(160),hash:z.string().regex(/^[a-f0-9]{64}$/),targetRevision:z.number().int().positive().safe(),now:evidenceDateSchema}).strict().optional()}).strict();
export type AttachmentGenerationInput=z.infer<typeof inputSchema>;
export function attachmentGenerationPredicate(owner:string,input:AttachmentGenerationInput):{sql:string;bindings:(string|number)[]}{
 if(typeof owner!=='string'||!owner.trim()||owner.length>256)throw new Error('An authenticated owner is required.');const value=inputSchema.parse(input);const verified=value.verifiedImport;
 const alias:AttachmentGenerationFields={owner:'generation_input.owner',attachmentId:'generation_input.attachment_id',storageKey:'generation_input.storage_key',bytes:'generation_input.bytes',sha256:'generation_input.sha256'};
 const extra=verified?',? AS import_id,? AS import_hash,? AS target_revision,? AS now':'';
 return {sql:`EXISTS(SELECT 1 FROM (SELECT ? AS owner,? AS attachment_id,? AS storage_key,? AS bytes,? AS sha256${extra}) generation_input WHERE ${attachmentGenerationSql(alias,verified?{id:'generation_input.import_id',hash:'generation_input.import_hash',targetRevision:'generation_input.target_revision',now:'generation_input.now'}:undefined)})`,bindings:[owner,value.attachmentId,value.storageKey,value.bytes,value.sha256,...(verified?[verified.id,verified.hash,verified.targetRevision,verified.now]:[])]};
}
export async function isAdmittedAttachmentGeneration(db:SqlDatabase,owner:string,input:AttachmentGenerationInput):Promise<boolean>{const predicate=attachmentGenerationPredicate(owner,input);return Boolean(await db.prepare(`SELECT 1 AS admitted WHERE ${predicate.sql}`).bind(...predicate.bindings).first());}
