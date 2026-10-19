import { z } from 'zod';
import type { Workspace } from './types.ts';
import type { EvidenceSubject, EvidenceVersion } from './evidence-contract.ts';
import { contentHash } from './canonical-json.ts';
import { evidenceDateSchema, evidenceIdSchema, evidenceSubjectSchema, parseEvidenceVersion } from './evidence-validation.ts';
export interface LegacyEvidenceMapping {subject:EvidenceSubject;evidenceId:string;sourceTextHash:string;evidenceVersion:number;}
export const legacyEvidenceMappingSchema=z.object({subject:evidenceSubjectSchema.refine(subject=>subject.type==='task'||subject.type==='milestone'),evidenceId:evidenceIdSchema,sourceTextHash:z.string().regex(/^[a-f0-9]{64}$/),evidenceVersion:z.number().int().positive().safe()}).strict();
export function parseLegacyEvidenceMapping(value:unknown):LegacyEvidenceMapping{return legacyEvidenceMappingSchema.parse(value);}
export interface LegacyEvidenceMigration {
 status:'create'|'revise'|'unchanged';subject:EvidenceSubject;evidenceId:string;sourceHash:string;
 mapping:LegacyEvidenceMapping;version:EvidenceVersion|null;
 warnings:string[];
}
export async function legacyEvidenceId(subject:EvidenceSubject):Promise<string>{const checked=evidenceSubjectSchema.parse(subject);return `legacy:${checked.type}:${await contentHash(checked.id)}`;}
/** Prepares data only. The owner command must claim mapping/head versions atomically before applying it.
 * The narrow implementation scope is compatibility context, never verification or acceptance.
 */
export async function prepareLegacyEvidenceMigration(workspace:Workspace,subject:EvidenceSubject,recordedAt:string,previous?:LegacyEvidenceMapping,currentVersion=previous?.evidenceVersion??0):Promise<LegacyEvidenceMigration|null> {
 const checked=evidenceSubjectSchema.parse(subject);evidenceDateSchema.parse(recordedAt);
 if(!['task','milestone'].includes(checked.type))throw new Error('Only task and milestone records have legacy inline evidence.');
 const rows=checked.type==='task'?workspace.tasks:workspace.milestones;
 const source=rows.find(row=>row.id===checked.id);if(!source)throw new Error('Legacy source is missing or unavailable.');
 if(typeof source.evidence!=='string')throw new Error('Legacy evidence must contain text.');
 const statement=source.evidence;if(!statement.trim())return null;
 // Capture every mutable source value before hashing yields control.
 const originalSubject=structuredClone(checked),prior=previous?parseLegacyEvidenceMapping(previous):undefined;
 const evidenceId=await legacyEvidenceId(originalSubject),sourceHash=await contentHash(statement);
 if(!Number.isSafeInteger(currentVersion)||currentVersion<0)throw new Error('A valid current evidence version is required.');
 if(prior&&(prior.evidenceId!==evidenceId||prior.subject.id!==checked.id||prior.subject.type!==checked.type||!Number.isSafeInteger(prior.evidenceVersion)||prior.evidenceVersion<1||prior.evidenceVersion>currentVersion||!/^[a-f0-9]{64}$/.test(prior.sourceTextHash)))throw new Error('Legacy source mapping differs or has an invalid version/hash.');
 if(!prior&&currentVersion!==0)throw new Error('Existing evidence requires its explicit legacy source mapping.');
 const warnings=['Migration time is the record time, not the observation time. Observation date, candidate and environment remain unknown.','Legacy notes are unassessed owner context in implementation scope. No completion, verification or acceptance is inferred.'];
 if(prior?.sourceTextHash===sourceHash)return {status:'unchanged',subject:originalSubject,evidenceId,sourceHash,mapping:prior,version:null,warnings};
 const version=currentVersion+1;
 const record=parseEvidenceVersion({id:evidenceId,version,basis:'owner-statement',scope:'implementation',title:`Imported legacy ${checked.type} notes`,statement,observedAt:null,recordedAt,candidate:null,environment:null,sourceUrl:null,sourceRevision:null,sourceRecordId:checked.id,attachmentIds:[],supersedesVersion:currentVersion||null});
 return {status:prior?'revise':'create',subject:originalSubject,evidenceId,sourceHash,mapping:{subject:structuredClone(originalSubject),evidenceId,sourceTextHash:sourceHash,evidenceVersion:version},version:record,warnings};
}
