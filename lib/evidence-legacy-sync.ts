import type {Workspace} from './types.ts';
import type {MutationPlan,PrepareContext} from './workspace-transaction.ts';
import type {ModuleRow,RegisteredOwnerTable} from './workspace-modules.ts';
import type {JsonValue} from './workspace-protocol.ts';
import {canonical,contentHash} from './canonical-json.ts';
import {legacyEvidenceId,legacyEvidenceMappingSchema} from './evidence-migration.ts';
import {evidenceHeadSchema,evidenceVersionSchema,evidenceDateSchema} from './evidence-validation.ts';
import {attachmentRecordSchema} from './evidence-module.ts';
import {versionRowId} from './version-identity.ts';
import {parseAuditEvent} from './audit-events.ts';
export type LegacyEvidenceSync=Pick<MutationPlan,'writes'|'preconditions'|'events'>;
/** Owner-scoped planning-handler additions, committed with the original inline edit.
 * Empty inline text preserves structured history and its mapping; it never invents a statement.
 * No source mapping means no implicit migration. Typed provenance is never reset by a correction.
 */
export async function prepareLegacyEvidenceSync(context:PrepareContext,planningAfter:Workspace):Promise<LegacyEvidenceSync>{
 const result:LegacyEvidenceSync={writes:[],preconditions:[],events:[]};const type=context.command.type;if(type!=='task.update'&&type!=='milestone.update')return result;
 const sourceId=context.command.id;if(typeof sourceId!=='string')throw new Error('Legacy source ID is invalid.');const subject={type:type==='task.update'?'task' as const:'milestone' as const,id:sourceId};
 const collection=subject.type==='task'?'tasks':'milestones',before=context.before.workspace[collection].find(row=>row.id===subject.id),after=planningAfter[collection].find(row=>row.id===subject.id);
 if(!before||!after)throw new Error('Legacy source is missing or unavailable.');if(before.evidence===after.evidence||!after.evidence.trim())return result;evidenceDateSchema.parse(context.now);
 const id=await legacyEvidenceId(subject),seen=new Map<string,ModuleRow>();
 async function read(table:RegisteredOwnerTable,rowId:string){const row=await context.query.get(table,rowId);if(row){if(row.id!==rowId||row.content_hash!==await contentHash(canonical(JSON.parse(row.payload_json))))throw new Error('Legacy evidence row identity or content differs.');seen.set(`${table}:${rowId}`,row);result.preconditions!.push({table,id:rowId,expectedRowRevision:row.row_revision,expectedHash:row.content_hash});}return row;}
 const mappingRow=await read('evidence_mappings',id);if(!mappingRow)return result;const mapping=legacyEvidenceMappingSchema.parse(JSON.parse(mappingRow.payload_json));if(mapping.evidenceId!==id||mapping.subject.type!==subject.type||mapping.subject.id!==subject.id)throw new Error('Legacy evidence mapping differs.');
 const headRow=await read('evidence_records',id);if(!headRow)throw new Error('Legacy evidence head is unavailable.');const head=evidenceHeadSchema.parse(JSON.parse(headRow.payload_json));if(head.id!==id||mapping.evidenceVersion>head.currentVersion)throw new Error('Legacy evidence head differs.');
 const currentRow=await read('evidence_versions',await versionRowId(id,head.currentVersion));if(!currentRow)throw new Error('Legacy evidence version is unavailable.');const current=evidenceVersionSchema.parse(JSON.parse(currentRow.payload_json));if(current.id!==id||current.version!==head.currentVersion||Date.parse(current.recordedAt)>Date.parse(context.now))throw new Error('Legacy evidence version or clock differs.');
 const sourceTextHash=await contentHash(after.evidence);let evidenceVersion=head.currentVersion;
 function write(table:RegisteredOwnerTable,rowId:string,value:unknown,row:ModuleRow|null){result.writes.push({table,id:rowId,operation:row?'update':'insert',expectedRowRevision:row?.row_revision??null,value:value as JsonValue});}
 if(current.statement!==after.evidence){
  for(const attachmentId of current.attachmentIds){const row=await read('attachments',attachmentId);if(!row)throw new Error('Preserved attachment is unavailable.');const attachment=attachmentRecordSchema.parse(JSON.parse(row.payload_json));if(attachment.id!==attachmentId||attachment.status!=='ready')throw new Error('Preserved attachment is not ready.');}
  evidenceVersion=head.currentVersion+1;const version=evidenceVersionSchema.parse({...current,statement:after.evidence,version:evidenceVersion,recordedAt:context.now,supersedesVersion:head.currentVersion}),physicalId=await versionRowId(id,evidenceVersion);if(await read('evidence_versions',physicalId))throw new Error('Legacy correction version already exists.');write('evidence_versions',physicalId,version,null);write('evidence_records',id,{...head,currentVersion:evidenceVersion},headRow);
 }
 const nextMapping={...mapping,sourceTextHash,evidenceVersion};if(canonical(nextMapping)!==canonical(mapping))write('evidence_mappings',id,nextMapping,mappingRow);
 if(result.writes.length)result.events.push(parseAuditEvent({id:crypto.randomUUID(),kind:'evidence.legacy-sync',entityType:'evidence',entityId:id,origin:'owner',actorId:context.userId,occurredAt:context.now,sourceRef:null,undoOf:null,changes:result.writes.map(write=>{const prior=seen.get(`${write.table}:${write.id}`);return {path:[write.table,write.id],before:{exists:!!prior,value:prior?JSON.parse(prior.payload_json):null},after:{exists:true,value:write.value!}};})}));
 return result;
}
