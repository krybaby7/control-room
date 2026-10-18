import {z} from 'zod';
import type {CommandHandler,MutationPlan} from './workspace-transaction.ts';
import {assertPortable,BUNDLE_LIMITS,canonical,contentHash,exportRegistry} from './workspace-export.ts';
import {OWNER_TABLES,ownerTable,type ModuleRow} from './workspace-modules.ts';
import type {JsonValue} from './workspace-protocol.ts';
import {previewPlanningMerge} from './workspace-merge.ts';
const ids=z.array(z.string().min(1).max(160)).max(10000);
const commandSchema=z.object({type:z.literal('workspace.import.commit'),importId:z.string().min(1).max(160),hash:z.string().regex(/^[a-f0-9]{64}$/),targetRevision:z.number().int().positive(),mode:z.enum(['replace','merge']),selection:z.object({projects:ids,milestones:ids,tasks:ids,captures:ids,activity:ids}).strict().optional()}).strict();
const recordSchema=z.object({id:z.string().min(1).max(128),rowRevision:z.number().int().positive(),contentHash:z.string().regex(/^[a-f0-9]{64}$/),value:z.unknown()}).strict();
/** Preparation is read-only. The central compiler alone writes the reviewed transaction. */
export const reviewedImportHandler:CommandHandler={async prepare(context){
 const command=commandSchema.parse(context.command);
 if(context.before.revision!==command.targetRevision)throw new Error('Import preview is stale.');
 if(command.mode==='replace'&&command.selection)throw new Error('Selection applies only to merge.');
 const {stage,provenance}=await context.readImport(command.importId);
 if(stage.hash!==command.hash||!stage.bundle||stage.diagnostics.length)throw new Error('Import is invalid or its digest changed.');
 const bundle=stage.bundle;const replacements:NonNullable<MutationPlan['replacements']>=[];
 for(const [key,incomingModule]of Object.entries(bundle.modules)) {
  const adapter=exportRegistry.get(key);
  if(adapter.policy==='append-only'){if(key!=='audit_events')throw new Error('Unsupported append-only import module.');continue;}
  const table=ownerTable(key);
  if(table==='workspace_configuration')throw new Error('Configuration authority cannot be imported.');
  if(command.mode==='merge'&&incomingModule.records.length)throw new Error('Normalized module merge is not supported.');
 }
 if(command.mode==='replace')for(const table of OWNER_TABLES){
  const beforeRows:ModuleRow[]=[];let after='';
  for(;;){const page=await context.query.list(table,{after,limit:BUNDLE_LIMITS.pageSize});for(const row of page){if(row.id<=after)throw new Error('Invalid module pagination.');after=row.id;beforeRows.push(row);if(beforeRows.length>BUNDLE_LIMITS.rows)throw new Error('Module row limit exceeded.');}if(page.length<BUNDLE_LIMITS.pageSize)break;}
  const adapter=exportRegistry.entries().find(item=>item.key===table&&item.policy==='replace');
  const incomingModule=bundle.modules[table];
  if(!adapter||!incomingModule){if(beforeRows.length)throw new Error('Import omits populated normalized owner data.');continue;}
  if(table==='workspace_configuration')throw new Error('Configuration authority cannot be imported.');
  const records=[];
  for(const raw of incomingModule.records){const record=recordSchema.parse(raw);assertPortable(record.value);if(await contentHash(canonical(record.value))!==record.contentHash)throw new Error('Module value digest mismatch.');records.push({id:record.id,value:record.value as JsonValue});}
  if(beforeRows.length||records.length)replacements.push({table,beforeRows,records});
 }
 const history=bundle.modules.audit_events?.records??[];
 if(history.length>BUNDLE_LIMITS.rows||new TextEncoder().encode(JSON.stringify(history)).byteLength>1_800_000)throw new Error('Imported history exceeds transaction limit.');
 const historyImports=history.map((source,index)=>{assertPortable(source);return {id:`import_${stage.hash}_${index}`,source:source as JsonValue,importHash:stage.hash};});
 for(const [index,report] of (provenance?.reports??[]).entries()){
  const source={kind:'import-repair',parentHash:provenance!.parentHash,report:JSON.parse(report)};assertPortable(source);
  historyImports.push({id:`import_${stage.hash}_repair_${index}`,source:source as JsonValue,importHash:stage.hash});
 }
 let planningAfter=bundle.planning;
 if(command.mode==='merge'){
  if(!command.selection)throw new Error('Explicit merge selection is required.');
  const merge=previewPlanningMerge(context.before.workspace,bundle.planning,command.selection);planningAfter=merge.workspace;
  for(const source of merge.sourceClaims){assertPortable(source);const index=bundle.planning[source.collection].findIndex(row=>row.id===source.id);historyImports.push({id:`import_${stage.hash}_claim_${source.collection}_${index}`,source:source as unknown as JsonValue,importHash:stage.hash});}
 }
 if(historyImports.length>BUNDLE_LIMITS.rows||new TextEncoder().encode(JSON.stringify(historyImports)).byteLength>1_800_000)throw new Error('Imported provenance exceeds transaction limit.');
 return {importSource:{id:command.importId,hash:stage.hash},planningAfter,writes:[],replacements,historyImports,restoreEpoch:true,backup:{reason:'restore'},jobs:[],events:[{id:crypto.randomUUID(),kind:'workspace.import.commit',entityType:'workspace',entityId:null,changes:[],origin:'owner',actorId:context.userId,occurredAt:context.now,sourceRef:stage.hash,undoOf:null}]};
}};
