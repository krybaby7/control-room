import {z} from 'zod';
import type {AttachmentManifestEntry,WorkspaceBundle} from './workspace-export.ts';
import {attachmentRecordSchema} from './evidence-module.ts';
import {evidenceIdSchema} from './evidence-validation.ts';
import {ATTACHMENT_POLICY,validateAttachmentMetadata} from './attachment-policy.ts';
const wrapper=z.object({id:evidenceIdSchema,rowRevision:z.number().int().positive().safe(),contentHash:z.string().regex(/^[a-f0-9]{64}$/),value:z.unknown()}).strict();
const legacy=z.object({kind:z.literal('legacy'),physicalId:evidenceIdSchema,record:z.unknown()}).strict();
export const attachmentManifestEntrySchema=z.object({id:evidenceIdSchema,filename:z.string().min(1).max(240),contentType:z.string(),bytes:z.number().int().nonnegative().max(ATTACHMENT_POLICY.fileBytes),sha256:z.string().regex(/^[a-f0-9]{64}$/),archivePath:z.null(),availability:z.enum(['missing','excluded'])}).strict().superRefine((value,ctx)=>{try{const metadata=validateAttachmentMetadata({filename:value.filename,mimeType:value.contentType,expectedBytes:value.bytes});if(metadata.mimeType!==value.contentType)throw new Error('MIME must be canonical.');}catch{ctx.addIssue({code:'custom',message:'Invalid attachment manifest metadata.'});}});
export interface AttachmentManifestInspection {entries:AttachmentManifestEntry[];unresolvedLegacy:number}
/** Metadata-only: a ready record proves its expected immutable digest, never backed-up bytes. */
export function inspectAttachmentManifest(modules:WorkspaceBundle['modules']):AttachmentManifestInspection{
 const attachmentModule=modules.attachments;if(!attachmentModule)return {entries:[],unresolvedLegacy:0};
 if(attachmentModule.schemaVersion!==1||!Array.isArray(attachmentModule.records)||attachmentModule.records.length>10000)throw new Error('Unsupported or oversized attachment metadata module.');
 const entries:AttachmentManifestEntry[]=[];const ids=new Set<string>();let bytes=0,unresolvedLegacy=0;
 for(const raw of attachmentModule.records){bytes+=new TextEncoder().encode(JSON.stringify(raw)).length;if(bytes>8_000_000)throw new Error('Attachment metadata exceeds manifest byte bound.');const row=wrapper.parse(raw);if(ids.has(row.id))throw new Error('Duplicate attachment metadata identity.');ids.add(row.id);
  const old=legacy.safeParse(row.value);if(old.success){if(old.data.physicalId!==row.id)throw new Error('Legacy attachment identity differs.');const record=old.data.record;if(record&&typeof record==='object'&&!Array.isArray(record)&&Object.hasOwn(record,'status'))throw new Error('Typed attachment cannot be downgraded to legacy.');unresolvedLegacy++;continue;}
  const record=attachmentRecordSchema.parse(row.value);if(record.id!==row.id)throw new Error('Attachment metadata identity differs.');
  if(record.status!=='ready')continue;
  if(record.actualBytes===null||record.sha256===null)throw new Error('Ready attachment lacks verified byte metadata.');
  entries.push(attachmentManifestEntrySchema.parse({id:record.id,filename:record.filename,contentType:record.mimeType,bytes:record.actualBytes,sha256:record.sha256,archivePath:null,availability:'excluded'}));
 }
 if(entries.length>ATTACHMENT_POLICY.ownerFiles||entries.reduce((sum,row)=>sum+row.bytes,0)>ATTACHMENT_POLICY.ownerBytes)throw new Error('Ready attachment manifest exceeds owner quota.');
 return {entries:entries.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0),unresolvedLegacy};
}
export function deriveAttachmentManifest(modules:WorkspaceBundle['modules']):AttachmentManifestEntry[]{return inspectAttachmentManifest(modules).entries;}
/** Old metadata-only bundles used []; accept that only through an explicit compatibility option.
 * Callers must derive missing file IDs from modules even when that old representation is accepted.
 */
export function validateAttachmentManifest(input:unknown,modules:WorkspaceBundle['modules'],options:{allowLegacyEmpty?:boolean}={}):AttachmentManifestEntry[]{
 const entries=z.array(attachmentManifestEntrySchema).max(ATTACHMENT_POLICY.ownerFiles).parse(input);const expected=deriveAttachmentManifest(modules);
 if(options.allowLegacyEmpty&&entries.length===0)return entries;
 if(new Set(entries.map(row=>row.id)).size!==entries.length)throw new Error('Duplicate attachment manifest identity.');
 if(entries.length!==expected.length)throw new Error('Attachment manifest omits or invents ready files.');
 const byId=new Map(expected.map(row=>[row.id,row]));for(const entry of entries){const record=byId.get(entry.id);if(!record||entry.filename!==record.filename||entry.contentType!==record.contentType||entry.bytes!==record.bytes||entry.sha256!==record.sha256)throw new Error('Attachment manifest differs from ready metadata.');}
 return entries;
}
