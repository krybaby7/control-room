import {z} from 'zod';
import type {SqlDatabase} from './workspace-store.ts';
import {readStagedImport,IMPORT_STAGING_LIMITS} from './import-staging.ts';
import type {ImportDiagnostic} from './import-quarantine.ts';
const ownerSchema=z.string().min(1).max(256).refine(value=>value.trim()===value&&!/[\u0000-\u001f\u007f]/u.test(value));
const uuid=z.string().uuid().refine(value=>value===value.toLowerCase());
const stamp=z.string().datetime({offset:true});
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const count=z.number().int().nonnegative().safe();
const rowSchema=z.object({id:uuid,status:z.enum(['preparing','verified','failed','committed']),created_at:stamp,expires_at:stamp,target_revision:z.number().int().positive().safe(),source_manifest_hash:digest,files:count,bytes:count,charged_files:count,charged_bytes:count,pending:count,import_id:z.string().nullable(),import_hash:z.string().nullable(),import_bytes:z.unknown()});
export interface ArchiveStageSummary {
 id:string;status:'preparing'|'verified'|'failed'|'committed';createdAt:string;expiresAt:string;targetRevision:number;sourceManifestHash:string;
 files:number;bytes:number;physicalCharged:{files:number;bytes:number};pendingUploadCount:number;
 recoverableStagedImport?:{id:string;hash:string;bytes:number;diagnostics:ImportDiagnostic[];expiresAt:string};
}
/** Owner-scoped operational metadata only: no keys, namespaces, raw manifests or import bodies escape. */
export async function listArchiveStages(db:SqlDatabase,owner:string,input:{after?:string;limit?:number;now:string}):Promise<{stages:ArchiveStageSummary[];nextAfter:string|null}>{
 ownerSchema.parse(owner);const options=z.object({after:uuid.optional(),limit:z.number().int().min(1).max(50).default(50),now:stamp}).strict().parse(input);
 const rows=(await db.prepare(`SELECT s.id,s.status,s.created_at,s.expires_at,s.target_revision,s.source_manifest_hash,s.import_id,s.import_hash,i.bytes AS import_bytes,
 (SELECT COUNT(*) FROM attachment_blob_objects o WHERE o.user_id=s.user_id AND o.namespace=s.namespace) AS files,
 (SELECT COALESCE(SUM(bytes),0) FROM attachment_blob_objects o WHERE o.user_id=s.user_id AND o.namespace=s.namespace) AS bytes,
 (SELECT COUNT(*) FROM attachment_blob_objects o WHERE o.user_id=s.user_id AND o.namespace=s.namespace AND o.purged_at IS NULL) AS charged_files,
 (SELECT COALESCE(SUM(bytes),0) FROM attachment_blob_objects o WHERE o.user_id=s.user_id AND o.namespace=s.namespace AND o.purged_at IS NULL) AS charged_bytes,
 (SELECT COUNT(*) FROM attachment_upload_attempts a WHERE a.user_id=s.user_id AND a.settled_at IS NULL AND EXISTS(SELECT 1 FROM attachment_blob_objects o WHERE o.user_id=s.user_id AND o.namespace=s.namespace AND o.storage_key=a.storage_key)) AS pending
 FROM attachment_archive_stages s LEFT JOIN workspace_imports i ON i.user_id=s.user_id AND i.id=s.import_id AND i.content_hash=s.import_hash
 WHERE s.user_id=? AND s.id>? ORDER BY s.id LIMIT ?`).bind(owner,options.after??'',options.limit+1).all()).results;
 const stages:ArchiveStageSummary[]=[];let importBytes=0;
 for(const raw of rows.slice(0,options.limit)){
  const row=rowSchema.parse(raw);const summary:ArchiveStageSummary={id:row.id,status:row.status,createdAt:row.created_at,expiresAt:row.expires_at,targetRevision:row.target_revision,sourceManifestHash:row.source_manifest_hash,files:row.files,bytes:row.bytes,physicalCharged:{files:row.charged_files,bytes:row.charged_bytes},pendingUploadCount:row.pending};
  const candidateBytes=row.import_bytes;
  if(row.status==='verified'&&Date.parse(row.expires_at)>Date.parse(options.now)&&uuid.safeParse(row.import_id).success&&digest.safeParse(row.import_hash).success&&typeof candidateBytes==='number'&&Number.isSafeInteger(candidateBytes)&&candidateBytes>=0&&candidateBytes<=IMPORT_STAGING_LIMITS.bytes&&importBytes+candidateBytes<=IMPORT_STAGING_LIMITS.ownerBytes){
   importBytes+=candidateBytes;
   try{const imported=await readStagedImport(db,owner,row.import_id!,options.now);const stage=imported.stage;
    if(stage.id===row.import_id&&stage.hash===row.import_hash&&stage.bytes===candidateBytes&&stage.bundle&&stage.diagnostics.length===0&&stage.expiresAt>Date.parse(options.now)&&await db.prepare("SELECT id FROM attachment_archive_stages WHERE user_id=? AND id=? AND status='verified' AND import_id=? AND import_hash=? AND expires_at>?").bind(owner,row.id,stage.id,stage.hash,options.now).first())summary.recoverableStagedImport={id:stage.id,hash:stage.hash,bytes:stage.bytes,diagnostics:stage.diagnostics.map(({path,code})=>({path,code})),expiresAt:new Date(stage.expiresAt).toISOString()};
   }catch{/* A corrupt or expired import never hides the retained physical stage or grants recovery authority. */}
  }
  stages.push(summary);
 }
 if(new TextEncoder().encode(JSON.stringify(stages)).length>8_000_000)throw new Error('Archive recovery summary exceeds its bounded response limit.');
 return {stages,nextAfter:rows.length>options.limit?stages.at(-1)!.id:null};
}
/** Discard quarantine authority, not physical bytes. Batches serialize with the owner import transaction. */
export async function discardArchiveStage(db:SqlDatabase,owner:string,id:string,now:string):Promise<boolean>{
 ownerSchema.parse(owner);uuid.parse(id);stamp.parse(now);
 const eligible=`s.user_id=? AND s.id=? AND s.status IN ('preparing','verified') AND NOT EXISTS(SELECT 1 FROM attachment_archive_stages committed WHERE committed.user_id=s.user_id AND committed.import_id=s.import_id AND committed.import_hash=s.import_hash AND committed.status='committed')`;
 const result=await db.batch([
  db.prepare(`DELETE FROM workspace_import_chunks WHERE user_id=? AND EXISTS(SELECT 1 FROM attachment_archive_stages s JOIN workspace_imports i ON i.user_id=s.user_id AND i.id=s.import_id AND i.content_hash=s.import_hash WHERE ${eligible} AND i.id=workspace_import_chunks.import_id)`).bind(owner,owner,id),
  db.prepare(`DELETE FROM workspace_imports WHERE user_id=? AND EXISTS(SELECT 1 FROM attachment_archive_stages s WHERE ${eligible} AND s.import_id=workspace_imports.id AND s.import_hash=workspace_imports.content_hash)`).bind(owner,owner,id),
  db.prepare(`UPDATE attachment_archive_stages AS s SET status='failed' WHERE ${eligible}`).bind(owner,id),
 ]);
 return result[2].meta.changes===1;
}
