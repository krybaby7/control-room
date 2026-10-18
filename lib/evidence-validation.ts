import { z } from 'zod';
import { EVIDENCE_LIMITS, type EvidenceInput, type EvidenceVersion, type EvidenceLink, type EvidenceSubject, type EvidenceRef, type VersionedRecordHead } from './evidence-contract.ts';
export const evidenceIdSchema=z.string().min(1).max(128).refine(value=>value.trim()===value,'IDs cannot have surrounding whitespace.');
export const evidenceDateSchema=z.string().datetime({offset:true}).refine(value=>{
 const calendar=value.slice(0,10);try{return Number.isFinite(Date.parse(value))&&new Date(`${calendar}T00:00:00Z`).toISOString().slice(0,10)===calendar;}catch{return false;}
},'A real ISO timestamp is required.');
export const evidenceUrlSchema=z.string().max(EVIDENCE_LIMITS.urlCharacters).refine(value=>{try{const url=new URL(value);return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password&&!/[\u0000-\u0020\u007f]/.test(value);}catch{return false;}},'A credential-free HTTP or HTTPS URL is required.');
export const evidenceBasisSchema=z.enum(['observed-artifact','documented-result','owner-statement','connector-observation']);
export const claimScopeSchema=z.enum(['implementation','software-verification','physical-acceptance','operation','release-acceptance','economics']);
const positiveVersion=z.number().int().positive().safe();
const nullableContext=(max:number)=>z.string().min(1).max(max).refine(value=>Boolean(value.trim()),'Use null for unknown context.').nullable();
export const evidenceSubjectSchema=z.object({type:z.enum(['project','milestone','task','capture']),id:evidenceIdSchema}).strict();
export const evidenceRefSchema=z.object({id:evidenceIdSchema,version:positiveVersion}).strict();
export const evidenceHeadSchema=z.object({id:evidenceIdSchema,currentVersion:positiveVersion,archivedAt:evidenceDateSchema.nullable()}).strict();
export const evidenceInputSchema=z.object({
 basis:evidenceBasisSchema,scope:claimScopeSchema,title:z.string().min(1).max(EVIDENCE_LIMITS.titleCharacters).refine(value=>Boolean(value.trim())),statement:z.string().min(1).max(EVIDENCE_LIMITS.statementCharacters).refine(value=>Boolean(value.trim())),
 observedAt:evidenceDateSchema.nullable(),candidate:nullableContext(500),environment:nullableContext(1000),sourceUrl:evidenceUrlSchema.nullable(),sourceRevision:nullableContext(200),sourceRecordId:evidenceIdSchema.nullable(),
 attachmentIds:z.array(evidenceIdSchema).max(EVIDENCE_LIMITS.attachmentsPerVersion).refine(ids=>new Set(ids).size===ids.length,'Attachment references must be unique.'),
}).strict();
export const evidenceVersionSchema=evidenceInputSchema.extend({id:evidenceIdSchema,version:positiveVersion,recordedAt:evidenceDateSchema,supersedesVersion:positiveVersion.nullable()}).strict().superRefine((value,ctx)=>{
 if(value.supersedesVersion!==(value.version===1?null:value.version-1))ctx.addIssue({code:z.ZodIssueCode.custom,path:['supersedesVersion'],message:'Evidence revisions must supersede the immediately preceding version.'});
});
export const evidenceLinkInputSchema=z.object({evidenceId:evidenceIdSchema,evidenceVersion:positiveVersion,subject:evidenceSubjectSchema,requirementId:evidenceIdSchema.nullable(),relation:z.enum(['supports','contradicts','context'])}).strict();
export const evidenceLinkSchema=evidenceLinkInputSchema.extend({id:evidenceIdSchema}).strict();
export function parseEvidenceInput(value:unknown):EvidenceInput{return evidenceInputSchema.parse(value);}
export function parseEvidenceVersion(value:unknown):EvidenceVersion{return evidenceVersionSchema.parse(value);}
export function parseEvidenceHead(value:unknown):VersionedRecordHead{return evidenceHeadSchema.parse(value);}
export function parseEvidenceSubject(value:unknown):EvidenceSubject{return evidenceSubjectSchema.parse(value);}
export function parseEvidenceRef(value:unknown):EvidenceRef{return evidenceRefSchema.parse(value);}
export function parseEvidenceLink(value:unknown):EvidenceLink{return evidenceLinkSchema.parse(value);}
/** Lookups MUST be built from the authenticated owner's live/tombstoned subject and attachment scope. */
export interface EvidenceReferenceContext {
 hasSubject:(subject:EvidenceSubject)=>boolean;
 isAttachmentReady:(id:string)=>boolean;
 hasEvidenceVersion?:(ref:EvidenceRef)=>boolean;
 hasRequirement?:(id:string,subject:EvidenceSubject)=>boolean;
}
export function validateEvidenceReferences(value:EvidenceInput,context:EvidenceReferenceContext):void {
 const input=parseEvidenceInput(value);for(const id of input.attachmentIds)if(!context.isAttachmentReady(id))throw new Error('Attachment is missing, unavailable or not ready for this owner.');
}
export function validateEvidenceLinkReferences(value:EvidenceLink,context:EvidenceReferenceContext):void {
 const link=parseEvidenceLink(value);
 if(!context.hasSubject(link.subject))throw new Error('Subject is missing or unavailable for this owner.');
 if(!context.hasEvidenceVersion?.({id:link.evidenceId,version:link.evidenceVersion}))throw new Error('Evidence version is missing or unavailable for this owner.');
 if(link.requirementId!==null&&!context.hasRequirement?.(link.requirementId,link.subject))throw new Error('Requirement is missing or unavailable for this subject.');
}
