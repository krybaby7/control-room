import type {ExportModule,ImportContext} from '../workspace-export.ts';
import type {ReferenceDescriptor,TypedReference} from '../workspace-references.ts';
import type {JsonValue} from '../workspace-protocol.ts';
import {ownerExportModule} from '../workspace-export-core.ts';
import {canonical,contentHash} from '../canonical-json.ts';
import {parseHistoryRecord,historyRecordId,type HistoryRecord} from './record.ts';

async function logicalId(row:HistoryRecord):Promise<string>{
 if(row.kind==='roadmap_scope')return row.value.id+'@'+row.value.revision;
 if(row.kind==='ingest_page')return contentHash(canonical([row.value.acknowledgement.sourceId,row.value.acknowledgement.epoch,row.value.acknowledgement.scopeRevision,row.value.acknowledgement.pageId]));
 if('id' in row.value&&typeof row.value.id==='string')return row.value.id;
 if(row.kind==='cursor')return row.value.sourceId;
 if(row.kind==='inventory_membership')return contentHash(canonical([row.value.sourceId,row.value.epoch,row.value.scopeRevision,row.value.generation,row.value.conversationId]));
 throw new Error('History record lacks a supported logical identity.');
}
function refs(row:HistoryRecord):TypedReference[]{
 const result:TypedReference[]=[];const value=row.value as unknown as Record<string,unknown>;
 for(const [key,kind]of [['projectId','project'],['areaId','area'],['taskId','task']] as const){const id=value[key];if(typeof id==='string')result.push({kind,id,path:['value',key]});}
 if(row.kind==='roadmap_scope')for(const [i,c]of row.value.checkpoints.entries()){
  if(c.milestoneId)result.push({kind:'milestone',id:c.milestoneId,path:['value','checkpoints',i,'milestoneId']});
  for(const [j,id]of c.taskIds.entries())result.push({kind:'task',id,path:['value','checkpoints',i,'taskIds',j]});
 }
 return result;
}
function validateReferences(context:ImportContext,input:unknown[]):void{
 const rows=input.map(raw=>parseHistoryRecord((raw as {value:unknown}).value));
 const sources=new Set(rows.filter(r=>r.kind==='source').map(r=>r.value.id));
 const conversations=new Map(rows.filter(r=>r.kind==='conversation').map(r=>[r.value.id,r.value]));
 const messages=new Map(rows.filter(r=>r.kind==='message').map(r=>[r.value.id,r.value]));
 const snapshots=new Map(rows.filter(r=>r.kind==='repository_evidence').map(r=>[r.value.id,r.value]));
 const claims=new Map(rows.filter(r=>r.kind==='claim').map(r=>[r.value.id,r.value]));
 for(const row of rows){
  const value=row.value as unknown as Record<string,unknown>;
  if(typeof value.sourceId==='string'&&!sources.has(value.sourceId))throw new Error('History source is missing.');
  if(typeof value.projectId==='string'&&!context.planning.projects.some(p=>p.id===value.projectId))throw new Error('History project is missing.');
  if(typeof value.areaId==='string'&&!context.planning.areas?.some(a=>a.id===value.areaId&&a.projectId===value.projectId))throw new Error('History area belongs to a different or missing project.');
  for(const ref of refs(row))if(ref.kind==='task'&&!context.planning.tasks.some(t=>t.id===ref.id&&t.projectId===value.projectId)||ref.kind==='milestone'&&!context.planning.milestones.some(m=>m.id===ref.id&&m.projectId===value.projectId))throw new Error('History planning reference is missing or foreign.');
  if(typeof value.conversationId==='string'){
   const conversation=conversations.get(value.conversationId);
   if(!conversation||typeof value.sourceId==='string'&&conversation.sourceId!==value.sourceId)throw new Error('History conversation is missing or foreign.');
  }
  if(row.kind==='ingest_page'&&!sources.has(row.value.acknowledgement.sourceId))throw new Error('History acknowledgement source is missing.');
  if(row.kind==='attachment'&&!messages.has(row.value.messageRevisionId))throw new Error('History attachment message is missing.');
  if(row.kind==='claim'){
   const conversation=conversations.get(row.value.context.conversationId),message=messages.get(row.value.context.messageRevisionId);
   if(!conversation||conversation.sourceId!==row.value.context.sourceId||!message||message.conversationId!==conversation.id)throw new Error('Claim source context is missing or foreign.');
   for(const citation of row.value.citations){const message=messages.get(citation.messageRevisionId);if(!message||message.revisionDigest!==citation.revisionDigest)throw new Error('Claim citation is missing or changed.');}
   for(const ref of row.value.supportingEvidence){const snapshot=snapshots.get(ref.snapshotId);if(!snapshot||snapshot.contentDigest!==ref.digest)throw new Error('Repository evidence is missing or changed.');}
  }
  if(row.kind==='work_item')for(const id of row.value.claimIds){const claim=claims.get(id);if(!claim||claim.projectId!==row.value.projectId||claim.areaId!==row.value.areaId)throw new Error('Work item claim is missing or foreign.');}
 }
}
const base=ownerExportModule('project_history',parseHistoryRecord);
export const historyExportAdapter:ExportModule={...base,legacyOptional:true,validateReferences,
 async exportRows(context){const rows=await base.exportRows(context);for(const raw of rows){const row=raw as {id:string;contentHash:string;value:unknown};const record=parseHistoryRecord(row.value);if(record.id!==row.id||record.id!==await historyRecordId(record.kind,await logicalId(record))||row.contentHash!==await contentHash(canonical(record)))throw new Error('History export identity or digest differs.');
 if(record.kind==='source'){
  const portable={...record,value:{...record.value,configuration:{...record.value.configuration,roots:[],accountId:null,deviceId:null,exclusions:[]}}};
  row.value=portable;row.contentHash=await contentHash(canonical(portable));
 }
 }return rows;},
 async prepareReplace(_context,input){const records=[];for(const raw of input){const row=raw as {id:string;contentHash:string;value:unknown};let value=parseHistoryRecord(row.value);if(value.id!==row.id||value.id!==await historyRecordId(value.kind,await logicalId(value))||await contentHash(canonical(value))!==row.contentHash)throw new Error('History restore identity or digest differs.');
  if(value.kind==='source'){const epoch=value.value.epoch,scopeRevision=value.value.scopeRevision;value={...value,value:{...value.value,epoch,scopeRevision,paused:true,configuration:{...value.value.configuration,epoch,scopeRevision},capability:{...value.value.capability,inventory:'unverified',contentRead:'unverified',unattendedRead:false,verifiedAt:null,proofRef:null,limitation:'Restored source requires fresh enrollment and scope verification.'}}};}
  records.push({id:row.id,value:value as unknown as JsonValue});
 }return [{table:'project_history',records}];},
};
export const historyReferenceDescriptor:ReferenceDescriptor={key:'project_history',schemaVersion:1,parse:parseHistoryRecord,references:value=>refs(parseHistoryRecord(value))};

/** Generic normalized merge has no authenticated private-byte proof. Imported
 * history therefore preserves identities/provenance but cannot import runnable
 * sources, native namespaces, current agreement or readable object authority.
 * The original portable record is retained by normalized merge's historyClaims.
 * Verified byte recovery uses the separate staged history artifact workflow. */
export function inertHistoryMergeValue(input:unknown):JsonValue{
 let record=parseHistoryRecord(input);
 if(record.kind==='source')record={...record,value:{...record.value,paused:true,configuration:{...record.value.configuration,roots:[],accountId:null,deviceId:null,exclusions:[]},capability:{...record.value.capability,inventory:'unverified',contentRead:'unverified',unattendedRead:false,verifiedAt:null,proofRef:null,limitation:'Imported historical source requires fresh owner enrollment and scope verification.'}}};
 else if(record.kind==='message'||record.kind==='repository_evidence')record={...record,value:{...record.value,bodyObjectKey:`unavailable:history-import:${record.id}`,availability:'unavailable'}} as HistoryRecord;
 else if(record.kind==='segment'||record.kind==='attachment')record={...record,value:{...record.value,objectKey:null,sha256:null,bytes:null,availability:'unavailable',unavailableReason:'Imported metadata only; private history bytes require explicit verified recovery.'}} as HistoryRecord;
 else if(record.kind==='roadmap_head'||record.kind==='roadmap_scope')record={...record,value:{...record.value,agreedAt:null}} as HistoryRecord;
 return parseHistoryRecord(record) as unknown as JsonValue;
}
