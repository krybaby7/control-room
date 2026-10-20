import {readCurrent,type SqlDatabase} from './workspace-store.ts';
import {ownerReader,type ModuleRow,type RegisteredOwnerTable} from './workspace-modules.ts';
import {canonical,contentHash} from './canonical-json.ts';
import {evidenceHeadSchema,evidenceVersionSchema,evidenceLinkSchema,evidenceDateSchema} from './evidence-validation.ts';
import {legacyEvidenceMappingSchema,type LegacyEvidenceMapping} from './evidence-migration.ts';
import {evidenceRequirementSchema} from './evidence-requirements.ts';
import {acceptanceRecordSchema} from './acceptance.ts';
import {decisionRecordSchema,decisionVersionSchema} from './decisions.ts';
import {attachmentRecordSchema,attachmentUsageSchema} from './evidence-module.ts';
import {versionRowId} from './version-identity.ts';
import type {AcceptanceRecord,AttachmentRecord,DecisionVersion,EvidenceLink,EvidenceRequirement,EvidenceVersion,VersionedRecordHead} from './evidence-contract.ts';
const TABLES=['evidence_records','evidence_versions','evidence_mappings','evidence_links','evidence_requirements','acceptance_records','decision_records','decision_versions','decisions','attachments','attachment_usage'] as const satisfies readonly RegisteredOwnerTable[];
type Table=typeof TABLES[number];
export const EVIDENCE_SNAPSHOT_LIMITS={rows:10000,bytes:8_000_000,attempts:3,pageSize:200} as const;
export type AttachmentSnapshot=Omit<AttachmentRecord,'storageKey'|'uploadMutationId'>;
export interface EvidenceSnapshot {
 physicalAttachmentUsage?:{bytes:number;files:number};
 attachmentStorage?:{configured:boolean;availability:'configured-unverified'|'not-configured'};
 requirementRowRevisions:Record<string,number>;revision:number;asOf:string;evidenceHeads:VersionedRecordHead[];evidenceVersions:EvidenceVersion[];evidenceMappings:LegacyEvidenceMapping[];
 links:EvidenceLink[];requirements:EvidenceRequirement[];acceptances:AcceptanceRecord[];decisionHeads:VersionedRecordHead[];decisionVersions:DecisionVersion[];
 attachments:AttachmentSnapshot[];attachmentUsage:{bytes:number;files:number}|null;legacyCounts:Partial<Record<Table,number>>;warnings:string[];attachmentRecovery:'metadata-only';
}
async function scan(db:SqlDatabase,userId:string):Promise<Record<Table,ModuleRow[]>>{
 const query=ownerReader(db,userId);const rows={} as Record<Table,ModuleRow[]>;let count=0,bytes=0;
 for(const table of TABLES){rows[table]=[];let after='';for(;;){const page=await query.list(table,{after,limit:EVIDENCE_SNAPSHOT_LIMITS.pageSize});for(const row of page){if(typeof row.id!=='string'||row.id<=after||!Number.isSafeInteger(row.row_revision)||row.row_revision<1)throw new Error('Invalid evidence snapshot row order or revision.');after=row.id;count++;bytes+=new TextEncoder().encode(canonical(row)).byteLength;if(count>EVIDENCE_SNAPSHOT_LIMITS.rows||bytes>EVIDENCE_SNAPSHOT_LIMITS.bytes)throw new Error('Evidence snapshot exceeds bounded read limits.');rows[table].push(row);}if(page.length<EVIDENCE_SNAPSHOT_LIMITS.pageSize)break;}}
 return rows;
}
function object(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value);}
async function parseSnapshot(rows:Record<Table,ModuleRow[]>,revision:number,now:string):Promise<EvidenceSnapshot>{
 const result:EvidenceSnapshot={requirementRowRevisions:{},revision,asOf:now,evidenceHeads:[],evidenceVersions:[],evidenceMappings:[],links:[],requirements:[],acceptances:[],decisionHeads:[],decisionVersions:[],attachments:[],attachmentUsage:null,legacyCounts:{},warnings:[],attachmentRecovery:'metadata-only'};
 for(const table of TABLES)for(const row of rows[table]){
  let value:unknown;try{value=JSON.parse(row.payload_json);}catch{throw new Error('Stored evidence metadata cannot be parsed.');}
  const legacy=table==='decisions'||table==='evidence_records'&&(!object(value)||!Object.hasOwn(value,'currentVersion'))||table==='evidence_links'&&(!object(value)||!Object.hasOwn(value,'evidenceId'))||table==='attachments'&&(!object(value)||!Object.hasOwn(value,'status'));
  if(legacy){result.legacyCounts[table]=(result.legacyCounts[table]??0)+1;continue;}
  if(!/^[a-f0-9]{64}$/.test(row.content_hash)||await contentHash(canonical(value))!==row.content_hash)throw new Error('Stored evidence metadata digest differs.');
  switch(table){
   case 'evidence_records':{const head=evidenceHeadSchema.parse(value);if(head.id!==row.id)throw new Error('Evidence head identity differs.');result.evidenceHeads.push(head);break;}
   case 'evidence_versions':{const version=evidenceVersionSchema.parse(value);if(await versionRowId(version.id,version.version)!==row.id)throw new Error('Evidence version physical identity differs.');result.evidenceVersions.push(version);break;}
   case 'evidence_mappings':result.evidenceMappings.push(legacyEvidenceMappingSchema.parse(value));break;
   case 'evidence_links':{const link=evidenceLinkSchema.parse(value);if(link.id!==row.id)throw new Error('Evidence link identity differs.');result.links.push(link);break;}
   case 'evidence_requirements':{const requirement=evidenceRequirementSchema.parse(value);if(requirement.id!==row.id)throw new Error('Requirement identity differs.');result.requirements.push(requirement);result.requirementRowRevisions[requirement.id]=row.row_revision;break;}
   case 'acceptance_records':{const acceptance=acceptanceRecordSchema.parse(value);if(acceptance.id!==row.id)throw new Error('Acceptance identity differs.');result.acceptances.push(acceptance);break;}
   case 'decision_records':{const head=evidenceHeadSchema.parse(value);if(head.id!==row.id)throw new Error('Decision head identity differs.');result.decisionHeads.push(head);break;}
   case 'decision_versions':{const version=decisionVersionSchema.parse(value);if(await versionRowId(version.id,version.version)!==row.id)throw new Error('Decision version physical identity differs.');result.decisionVersions.push(version);break;}
   case 'attachments':{const {storageKey,uploadMutationId,...safe}=attachmentRecordSchema.parse(value);if(safe.id!==row.id)throw new Error('Attachment identity differs.');void storageKey;void uploadMutationId;result.attachments.push(safe);break;}
   case 'attachment_usage':if(row.id!=='quota'||result.attachmentUsage)throw new Error('Attachment quota identity differs.');result.attachmentUsage=attachmentUsageSchema.parse(value);break;
  }
 }
 for(const head of result.evidenceHeads){const versions=result.evidenceVersions.filter(version=>version.id===head.id).sort((a,b)=>a.version-b.version);if(versions.length!==head.currentVersion||versions.some((version,index)=>version.version!==index+1))throw new Error('Evidence version chain differs from its head.');}
 if(result.evidenceVersions.some(version=>!result.evidenceHeads.some(head=>head.id===version.id)))throw new Error('Evidence version has no current head.');
 for(const head of result.decisionHeads)decisionRecordSchema.parse({head,versions:result.decisionVersions.filter(version=>version.id===head.id).sort((a,b)=>a.version-b.version)});
 if(result.decisionVersions.some(version=>!result.decisionHeads.some(head=>head.id===version.id)))throw new Error('Decision version has no current head.');
 for(const [table,count]of Object.entries(result.legacyCounts))result.warnings.push(`${count} legacy ${table} record(s) remain retained and require explicit review; no evidence or decision authority is inferred.`);
 result.warnings.push('Attachment records describe metadata only. This snapshot does not verify that attachment bytes are available or backed up.');return result;
}
/** A bounded owner-scoped read only: retries torn reads, never repairs data or creates namespace authority. */
export async function readEvidenceSnapshot(db:SqlDatabase,userId:string,now:string):Promise<EvidenceSnapshot>{
 if(typeof userId!=='string'||!userId.trim())throw new Error('An authenticated owner is required.');evidenceDateSchema.parse(now);
 for(let attempt=0;attempt<EVIDENCE_SNAPSHOT_LIMITS.attempts;attempt++){
  const before=await readCurrent(db,userId),rows=await scan(db,userId),again=await scan(db,userId),after=await readCurrent(db,userId);
  if(before.revision!==after.revision||canonical(before.workspace)!==canonical(after.workspace)||canonical(rows)!==canonical(again))continue;
  return parseSnapshot(rows,after.revision,now);
 }
 throw new Error('Evidence changed during snapshot read. Refresh before reviewing it.');
}
