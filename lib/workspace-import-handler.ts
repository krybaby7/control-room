import {RECOVERABILITY_SQL_ARGUMENT_BYTES} from './recoverability-measure.ts';
import {prepareHistoricalAuditRows} from './audit-import.ts';
import {z} from 'zod';
import type {CommandHandler,MutationPlan,PrepareContext} from './workspace-transaction.ts';
import {assertPortable,BUNDLE_LIMITS,canonical,contentHash,exportRegistry,moduleTables,type ExportRegistry,type PhysicalImportRows} from './workspace-export.ts';
import {OWNER_TABLES,ownerTable,type ModuleRow,type RegisteredOwnerTable} from './workspace-modules.ts';
import type {JsonValue} from './workspace-protocol.ts';
import {previewPlanningMerge} from './workspace-merge.ts';
import {prepareNormalizedMerge} from './normalized-merge.ts';
const ids=z.array(z.string().min(1).max(160)).max(10000);
const commandSchema=z.object({type:z.literal('workspace.import.commit'),importId:z.string().min(1).max(160),hash:z.string().regex(/^[a-f0-9]{64}$/),targetRevision:z.number().int().positive(),mode:z.enum(['replace','merge']),normalizedReviewHash:z.string().regex(/^[a-f0-9]{64}$/).optional(),selection:z.object({areas:ids.optional(),projects:ids,milestones:ids,tasks:ids,captures:ids,activity:ids}).strict().optional()}).strict();
const physicalRecordSchema=z.object({id:z.string().min(1).max(128).refine(value=>value.trim()===value),value:z.unknown()}).strict();
const recordSchema=z.object({id:z.string().min(1).max(128).refine(value=>value.trim()===value),rowRevision:z.number().int().positive().safe(),contentHash:z.string().regex(/^[a-f0-9]{64}$/),value:z.unknown()}).strict();
/** Preparation is read-only. The central compiler alone writes the reviewed transaction. */
export function createReviewedImportHandler(registry:ExportRegistry=exportRegistry):CommandHandler {return {async prepare(context){
 const command=commandSchema.parse(context.command);
 if(context.before.revision!==command.targetRevision)throw new Error('Import preview is stale.');
 if(command.mode==='replace'&&(command.selection||command.normalizedReviewHash))throw new Error('Selection applies only to merge.');
 const {stage,provenance}=await context.readImport(command.importId);
 if(stage.hash!==command.hash||!stage.bundle||stage.diagnostics.length)throw new Error('Import is invalid or its digest changed.');
 if(command.mode==='merge')return prepareReviewedMerge(context,command,stage,provenance,registry);
 const bundle=stage.bundle;const replacements:NonNullable<MutationPlan['replacements']>=[];
 const adapters=registry.entries(),coverage=new Map<RegisteredOwnerTable,string>();
 for(const adapter of adapters){const tables=moduleTables(adapter);if(new Set(tables).size!==tables.length)throw new Error('Duplicate physical module coverage.');for(const raw of tables){const table=ownerTable(raw);if(coverage.has(table))throw new Error('Overlapping physical module coverage.');coverage.set(table,adapter.key);}}
 const incoming=new Map<RegisteredOwnerTable,PhysicalImportRows['records']>();let incomingBytes=0;
 for(const [key,incomingModule]of Object.entries(bundle.modules)) {
  const adapter=registry.get(key);
  if(adapter.policy==='append-only'){if(key!=='audit_events')throw new Error('Unsupported append-only import module.');continue;}
  const declared=moduleTables(adapter);
  if(key==='workspace_configuration'||declared.includes('workspace_configuration'))throw new Error('Configuration authority cannot be imported.');
  if(!incomingModule||!Number.isSafeInteger(incomingModule.schemaVersion)||incomingModule.schemaVersion<1||!Array.isArray(incomingModule.records)||incomingModule.records.length>BUNDLE_LIMITS.rows)throw new Error('Invalid module records.');
  const validated=[];const portableIds=new Set<string>();
  for(const raw of incomingModule.records){const record=recordSchema.parse(raw);if(portableIds.has(record.id))throw new Error('Duplicate portable module identity.');portableIds.add(record.id);assertPortable(record.value);if(await contentHash(canonical(record.value))!==record.contentHash)throw new Error('Module value digest mismatch.');validated.push(record);}
  const migrated=adapter.parseAndMigrate({schemaVersion:incomingModule.schemaVersion,records:validated});if(!Array.isArray(migrated)||migrated.length>BUNDLE_LIMITS.rows)throw new Error('Invalid migrated module records.');const restored=[];const migratedIds=new Set<string>();for(const raw of migrated){const row=recordSchema.parse(raw);if(migratedIds.has(row.id))throw new Error('Duplicate migrated module identity.');migratedIds.add(row.id);assertPortable(row.value);if(await contentHash(canonical(row.value))!==row.contentHash)throw new Error('Migrated module value digest mismatch.');restored.push(row);}
  if(!declared.length)throw new Error('Replaceable module declares no physical coverage.');
  const split=adapter.prepareReplace?await adapter.prepareReplace({planning:bundle.planning,modules:bundle.modules},restored):declared.length===1&&declared[0]===key?[{table:declared[0],records:restored.map(({id,value})=>({id,value:value as JsonValue}))}]:null;
  if(!Array.isArray(split)||split.length!==declared.length)throw new Error('Composite replacement must explicitly cover every declared table.');
  const seen=new Set<RegisteredOwnerTable>();
  for(const raw of split){if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(key=>!['table','records'].includes(key)))throw new Error('Invalid physical replacement wrapper.');const table=ownerTable(raw.table);if(!declared.includes(table)||seen.has(table)||incoming.has(table))throw new Error('Undeclared or duplicate physical replacement table.');seen.add(table);if(!Array.isArray(raw.records)||raw.records.length>BUNDLE_LIMITS.rows)throw new Error('Physical replacement row limit exceeded.');const ids=new Set<string>();const records=[];for(const input of raw.records){const record=physicalRecordSchema.parse(input);if(ids.has(record.id))throw new Error('Duplicate physical replacement identity.');ids.add(record.id);assertPortable(record.value);incomingBytes+=new TextEncoder().encode(JSON.stringify(record)).byteLength;if(incomingBytes>BUNDLE_LIMITS.bytes)throw new Error('Expanded physical import byte bound exceeded.');records.push({id:record.id,value:record.value as JsonValue});}incoming.set(table,records);}
 }
 {
  let bytes=0;
  for(const table of OWNER_TABLES){
   const beforeRows:ModuleRow[]=[];let after='';
   for(;;){const page=await context.query.list(table,{after,limit:BUNDLE_LIMITS.pageSize});if(page.length>BUNDLE_LIMITS.pageSize)throw new Error('Invalid module page size.');for(const row of page){if(typeof row.id!=='string'||row.id<=after)throw new Error('Invalid module pagination.');after=row.id;beforeRows.push(row);bytes+=new TextEncoder().encode(JSON.stringify(row)).byteLength;if(beforeRows.length>BUNDLE_LIMITS.rows||bytes>BUNDLE_LIMITS.bytes)throw new Error('Module snapshot bound exceeded.');}if(page.length<BUNDLE_LIMITS.pageSize)break;}
   const records=incoming.get(table);
   if(!records){if(beforeRows.length)throw new Error('Import omits populated normalized owner data.');continue;}
   if(beforeRows.length||records.length)replacements.push({table,beforeRows,records});
  }
 }
 const history=bundle.modules.audit_events?.records??[];
 if(history.length>BUNDLE_LIMITS.rows||new TextEncoder().encode(JSON.stringify(history)).byteLength>RECOVERABILITY_SQL_ARGUMENT_BYTES)throw new Error('Imported history exceeds transaction limit.');
 const historyImports:NonNullable<MutationPlan['historyImports']>=await prepareHistoricalAuditRows(history,bundle.source.auditNamespace??null,stage.hash);
 for(const [index,report] of (provenance?.reports??[]).entries()){
  const source={kind:'import-repair',parentHash:provenance!.parentHash,report:JSON.parse(report)};assertPortable(source);
  historyImports.push({id:`import_${stage.hash}_repair_${index}`,source:source as JsonValue,importHash:stage.hash});
 }
 const planningAfter=bundle.planning;
 if(historyImports.length>BUNDLE_LIMITS.rows||new TextEncoder().encode(JSON.stringify(historyImports)).byteLength>RECOVERABILITY_SQL_ARGUMENT_BYTES)throw new Error('Imported provenance exceeds transaction limit.');
 return {importSource:{id:command.importId,hash:stage.hash},planningAfter,writes:[],replacements,historyImports,restoreEpoch:true,backup:{reason:'restore'},jobs:[],events:[{id:crypto.randomUUID(),kind:'workspace.import.commit',entityType:'workspace',entityId:null,changes:[],origin:'owner',actorId:context.userId,occurredAt:context.now,sourceRef:stage.hash,undoOf:null}]};
}};}
async function prepareReviewedMerge(context:PrepareContext,command:z.infer<typeof commandSchema>,stage:import('./import-quarantine.ts').ImportStage,provenance:import('./import-staging.ts').ImportRepairProvenance|undefined,registry:ExportRegistry):Promise<MutationPlan>{
 if(!stage.bundle||!command.selection)throw new Error('Explicit merge selection is required.');
 const bundle=stage.bundle,planning=previewPlanningMerge(context.before.workspace,bundle.planning,command.selection);
 const normalized=await prepareNormalizedMerge({query:context.query,userId:context.userId,workspaceRevision:context.before.revision,planningAfter:planning.workspace,bundle,importHash:stage.hash,importedAt:new Date(stage.createdAt).toISOString(),verifyAttachment:context.verifyAttachment},registry);
 if(normalized.review.conflicts.length)throw new Error('Normalized merge identity conflict requires explicit review or mapping: '+normalized.review.conflicts.map(row=>row.module+'/'+row.id).slice(0,20).join(', '));
 if(normalized.writes.length&&command.normalizedReviewHash!==normalized.review.reviewHash)throw new Error('Review the exact normalized merge additions and disabled historical projections before committing.');
 if(command.normalizedReviewHash&&command.normalizedReviewHash!==normalized.review.reviewHash)throw new Error('Normalized merge review is stale.');
 const history=bundle.modules.audit_events?.records??[];
 if(history.length>BUNDLE_LIMITS.rows||new TextEncoder().encode(JSON.stringify(history)).byteLength>RECOVERABILITY_SQL_ARGUMENT_BYTES)throw new Error('Imported history exceeds transaction limit.');
 const historyImports:NonNullable<MutationPlan['historyImports']>=await prepareHistoricalAuditRows(history,bundle.source.auditNamespace??null,stage.hash);
 for(const source of planning.sourceClaims){assertPortable(source);historyImports.push({id:'import_merge_'+await contentHash(canonical([stage.hash,source.collection,source.id])),source:source as unknown as JsonValue,importHash:stage.hash});}
 for(const source of normalized.historyClaims){assertPortable(source);historyImports.push({id:'import_merge_'+await contentHash(canonical([stage.hash,source.module,source.id])),source:{kind:'normalized-merge-source-claim',...source},importHash:stage.hash});}
 for(const [index,report]of(provenance?.reports??[]).entries()){const source={kind:'import-repair',parentHash:provenance!.parentHash,report:JSON.parse(report)};assertPortable(source);historyImports.push({id:'import_'+stage.hash+'_repair_'+index,source:source as JsonValue,importHash:stage.hash});}
 if(historyImports.length>BUNDLE_LIMITS.rows||new TextEncoder().encode(JSON.stringify(historyImports)).byteLength>RECOVERABILITY_SQL_ARGUMENT_BYTES)throw new Error('Imported provenance exceeds transaction limit.');
 const boundary=normalized.writes.length?{normalizedMerge:{importHash:stage.hash,reviewHash:normalized.review.reviewHash,rows:normalized.review.rows,verifiedAttachments:normalized.verifiedAttachments}}:{preserveModules:true};
 return {...boundary,referenceSnapshot:normalized.referenceSnapshot,importSource:{id:command.importId,hash:stage.hash},planningAfter:planning.workspace,writes:normalized.writes,historyImports,restoreEpoch:true,backup:{reason:'restore'},jobs:[],events:[{id:crypto.randomUUID(),kind:'workspace.import.commit',entityType:'workspace',entityId:null,changes:[{path:['normalized-merge'],before:{exists:false,value:null},after:{exists:true,value:{reviewHash:normalized.review.reviewHash,added:normalized.review.rows.filter(row=>row.disposition==='insert').length,deduplicated:normalized.review.rows.filter(row=>row.disposition==='deduplicate').length,derivedQuota:normalized.review.rows.filter(row=>row.disposition==='derived-quota').length,warnings:normalized.review.warnings}}}],origin:'owner',actorId:context.userId,occurredAt:context.now,sourceRef:stage.hash,undoOf:null}]};
}
export const reviewedImportHandler=createReviewedImportHandler();
