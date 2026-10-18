import {reviewExportAdapters} from './reviews/module.ts';
import {sourceExportAdapters} from './sources/module.ts';
import {readOperationalWatermarks,validateOperationalWatermarks} from './operational-watermarks.ts';
import {deriveAttachmentManifest,validateAttachmentManifest} from './attachment-manifest.ts';
import {evidenceExportAdapters} from './evidence-module.ts';
import {getWorkspaceNamespaces} from './workspace-namespaces.ts';
import {BUNDLE_LIMITS,assertPortable,strictObject,digest,boundedPages} from './workspace-export-core.ts';
export {BUNDLE_LIMITS,assertPortable,ownerExportModule} from './workspace-export-core.ts';
import {canonical,contentHash} from './canonical-json.ts';
export {canonical,contentHash} from './canonical-json.ts';
import {planningExportAdapters} from './planning-module.ts';
import type { Workspace, WorkspaceEnvelope } from './types.ts';
import type { SqlDatabase } from './workspace-store.ts';
import { readCurrent } from './workspace-store.ts';
import { OWNER_TABLES, ownerReader, ownerTable, type OwnerScopedReader, type RegisteredOwnerTable } from './workspace-modules.ts';
import type {JsonValue} from './workspace-protocol.ts';
import { parsePlanningImport } from './workspace-codec.ts';

export interface AttachmentManifestEntry { id: string; filename: string; contentType: string; bytes: number; sha256: string; archivePath: string | null; availability: 'included' | 'missing' | 'excluded'; }
export interface WorkspaceBundle {
  format: 'control-room'; bundleVersion: 1; exportedAt: string;
  source: { auditNamespace?:string; operationalWatermarks?:Record<string,number>; workspaceRevision: number; planningSchemaVersion: number; moduleWatermarks: Record<string,string>; sourceHashes: Record<string,string> };
  planning: Workspace; modules: Record<string,{schemaVersion:number; records:unknown[]}>;
  attachments: AttachmentManifestEntry[]; completeness: 'complete' | 'metadata-only';
}
export interface ExportContext { userId: string; sourceRevision: number; query: OwnerScopedReader; db: SqlDatabase; operationalWatermarks?:Record<string,number>; }
export interface ImportContext { planning: Workspace; modules: WorkspaceBundle['modules']; }
export interface PhysicalImportRows {table:RegisteredOwnerTable;records:Array<{id:string;value:JsonValue}>}
export interface ExportModule {
 legacyOptional?:boolean;key:string;schemaVersion:number;policy:'replace'|'append-only';
 tables?:readonly RegisteredOwnerTable[];
 exportRows(context:ExportContext):Promise<unknown[]>;
 parseAndMigrate(input:{schemaVersion:number;records:unknown[]}):unknown[];
 validateReferences?(context:ImportContext,rows:unknown[]):void;
 /** Pure split only; the central compiler supplies owner/CAS/backup authority. */
 prepareReplace?(context:ImportContext,rows:unknown[]):Promise<PhysicalImportRows[]>|PhysicalImportRows[];
}
export function moduleTables(adapter:ExportModule):RegisteredOwnerTable[]{
 if(adapter.policy==='append-only')return [];
 return adapter.tables?[...adapter.tables]:((OWNER_TABLES as readonly string[]).includes(adapter.key)?[ownerTable(adapter.key)]:[]);
}
const forbiddenModule = /(?:credential|token|secret|password|authorization|approval|receipt|job|device_key|workspace_mutation|command_guard)/i;
/** Actor metadata is semantic provenance; authenticated owner identifiers stay in the internal ledger. */
function portableAudit(value:unknown):unknown {
  if(Array.isArray(value)) return value.map(portableAudit);
  if(value && typeof value==='object') return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,key==='actorId'?'owner':portableAudit(item)]));
  return value;
}
export class ExportRegistry {
  private modules = new Map<string,ExportModule>();
  register(adapter:ExportModule):void {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(adapter.key) || forbiddenModule.test(adapter.key) || this.modules.has(adapter.key) || !Number.isSafeInteger(adapter.schemaVersion) || adapter.schemaVersion<1) throw new Error('Invalid or duplicate export adapter.');
    const tables=moduleTables(adapter);for(const table of tables)ownerTable(table);
    if(new Set(tables).size!==tables.length||tables.some(table=>this.entries().some(other=>moduleTables(other).includes(table))))throw new Error('Duplicate physical module coverage.');
    this.modules.set(adapter.key,Object.freeze({...adapter,...(adapter.tables?{tables:Object.freeze([...tables])}:{})}));
  }
  entries():ExportModule[] { return [...this.modules.values()].sort((a,b)=>a.key.localeCompare(b.key)); }
  get(key:string):ExportModule { const adapter=this.modules.get(key); if (!adapter) throw new Error('Unknown export adapter.'); return adapter; }
}
export const exportRegistry = new ExportRegistry();
export function registerExportModule(adapter:ExportModule):void { exportRegistry.register(adapter); }
export function serializePortableAuditRow(row:Record<string,unknown> & {event_id:string;payload_json:string}):unknown {
 const {payload_json,...metadata}=row;return {id:row.event_id,...metadata,payload:portableAudit(JSON.parse(payload_json))};
}
export async function buildWorkspaceBundle(input:{planning:WorkspaceBundle['planning'];modules:WorkspaceBundle['modules'];workspaceRevision:number;operationalWatermarks:Record<string,number>;auditNamespace?:string;exportedAt:string},options:{enforceByteLimit?:boolean;registry?:ExportRegistry}={}):Promise<WorkspaceBundle>{
 const registry=options.registry??exportRegistry,hashes:Record<string,string>={};
 for(const adapter of registry.entries()){const exportedModule=input.modules[adapter.key];if(!exportedModule)throw new Error('Missing export module.');assertPortable(exportedModule.records);if(exportedModule.records.length>BUNDLE_LIMITS.rows)throw new Error('Export row limit exceeded.');adapter.validateReferences?.({planning:input.planning,modules:input.modules},exportedModule.records);hashes[adapter.key]=await contentHash(canonical(exportedModule.records));}
 hashes.planning=await contentHash(canonical(input.planning));
 const bundle:WorkspaceBundle={format:'control-room',bundleVersion:1,exportedAt:input.exportedAt,source:{...(input.auditNamespace?{auditNamespace:input.auditNamespace}:{}),operationalWatermarks:input.operationalWatermarks,workspaceRevision:input.workspaceRevision,planningSchemaVersion:input.planning.schemaVersion,moduleWatermarks:{...hashes},sourceHashes:hashes},planning:input.planning,modules:input.modules,attachments:deriveAttachmentManifest(input.modules),completeness:'metadata-only'};
 if(options.enforceByteLimit!==false&&new TextEncoder().encode(JSON.stringify(bundle)).length>BUNDLE_LIMITS.bytes)throw new Error('Export byte limit exceeded.');return bundle;
}
const auditColumns='event_id, workspace_revision, ordinal, stream_id, stream_sequence, kind, entity_type, entity_id, occurred_at, payload_json';
exportRegistry.register({key:'audit_events',schemaVersion:1,policy:'append-only',async exportRows(ctx) {
  const rows=await boundedPages<Record<string,unknown> & {id:string}>(async after=>(await ctx.db.prepare(`SELECT ${auditColumns} FROM audit_events WHERE user_id = ? AND event_id > ? AND NOT EXISTS(SELECT 1 FROM json_each(?) frozen WHERE frozen.key=audit_events.stream_id AND audit_events.stream_sequence>frozen.value) ORDER BY event_id LIMIT ?`).bind(ctx.userId,after,JSON.stringify(ctx.operationalWatermarks??{}),BUNDLE_LIMITS.pageSize).all<Record<string,unknown>>()).results.map(row=>({id:row.event_id as string,...row})));
  return rows.map(({id:_,...row})=>{void _;return serializePortableAuditRow(row as Record<string,unknown>&{event_id:string;payload_json:string});});
},parseAndMigrate(input) { if(input.schemaVersion!==1) throw new Error('Unknown audit version.'); for(const row of input.records) { assertPortable(row); if(!row || typeof row!=='object' || typeof (row as {id:unknown}).id!=='string') throw new Error('Invalid audit record.'); } return input.records; }});
for(const adapter of [...planningExportAdapters,...evidenceExportAdapters,...sourceExportAdapters,...reviewExportAdapters])exportRegistry.register(adapter);
export async function exportWorkspaceBundle(db:SqlDatabase,userId:string,options:{now?:()=>string;registry?:ExportRegistry}={}):Promise<WorkspaceBundle> {
  if(!userId) throw new Error('A signed-in owner is required.'); const registry=options.registry??exportRegistry;
  const namespaces=await getWorkspaceNamespaces(db,userId);
  const snapshotAt=(options.now??(()=>new Date().toISOString()))();
  for(let attempt=0;attempt<BUNDLE_LIMITS.attempts;attempt++) {
    const before=await readCurrent(db,userId,snapshotAt),operationalWatermarks=await readOperationalWatermarks(db,userId); const ctx={db,userId,sourceRevision:before.revision,query:ownerReader(db,userId),operationalWatermarks};
    for(const table of OWNER_TABLES) if(!registry.entries().some(adapter=>moduleTables(adapter).includes(table)) && (await ctx.query.list(table,{limit:1})).length) throw new Error('Populated owner adapter has no export adapter.');
    const modules:WorkspaceBundle['modules']={}; const hashes:Record<string,string>={}; let stable=true;
    for(const adapter of registry.entries()) { const records=await adapter.exportRows(ctx); assertPortable(records); if(records.length>BUNDLE_LIMITS.rows) throw new Error('Export row limit exceeded.'); modules[adapter.key]={schemaVersion:adapter.schemaVersion,records}; hashes[adapter.key]=await contentHash(canonical(records)); }
    for(const adapter of registry.entries()) { if(await contentHash(canonical(await adapter.exportRows(ctx)))!==hashes[adapter.key]) stable=false; }
    const after=await readCurrent(db,userId,snapshotAt); if(!stable || before.revision!==after.revision || canonical(before.workspace)!==canonical(after.workspace)||canonical(operationalWatermarks)!==canonical(await readOperationalWatermarks(db,userId))) continue;
    return buildWorkspaceBundle({planning:before.workspace,modules,workspaceRevision:before.revision,operationalWatermarks,...(namespaces?{auditNamespace:namespaces.auditNamespace}:{}),exportedAt:snapshotAt},{registry});
  }
  throw new Error('Workspace changed during export; retry.');
}
export function parseWorkspaceBundle(value:unknown,registry:ExportRegistry=exportRegistry):WorkspaceBundle {
  if(!value || typeof value!=='object') throw new Error('Invalid bundle.'); const raw=value as WorkspaceBundle;
  strictObject(raw,['format','bundleVersion','exportedAt','source','planning','modules','attachments','completeness'],'bundle');
  strictObject(raw.source,['workspaceRevision','planningSchemaVersion','moduleWatermarks','sourceHashes',...(raw.source&&Object.hasOwn(raw.source,'auditNamespace')?['auditNamespace']:[]),...(raw.source&&Object.hasOwn(raw.source,'operationalWatermarks')?['operationalWatermarks']:[])],'source');
  if(raw.source.operationalWatermarks!==undefined)validateOperationalWatermarks(raw.source.operationalWatermarks);
  if(raw.source.auditNamespace!==undefined&&!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(raw.source.auditNamespace))throw new Error('Invalid source audit namespace.');
  assertPortable(raw);
  if(raw.completeness!=='complete' && raw.completeness!=='metadata-only') throw new Error('Invalid completeness.');
  if(raw.format!=='control-room' || raw.bundleVersion!==1) throw new Error('Unknown bundle version.');
  if(!raw.modules || typeof raw.modules!=='object' || Array.isArray(raw.modules) || Object.getPrototypeOf(raw.modules)!==Object.prototype) throw new Error('Invalid modules.');
  if(!raw.source || !Number.isSafeInteger(raw.source.workspaceRevision) || raw.source.workspaceRevision<1) throw new Error('Invalid source revision.');
  for(const key of Object.keys(raw.modules)) registry.get(key);
  for(const map of [raw.source.moduleWatermarks,raw.source.sourceHashes]) {
    if(!map || typeof map!=='object' || Array.isArray(map) || Object.getPrototypeOf(map)!==Object.prototype) throw new Error('Invalid source hash or watermark map.');
    for(const [key,hash] of Object.entries(map)) if((key!=='planning' && !Object.hasOwn(raw.modules,key)) || !digest(hash)) throw new Error('Invalid source hash or watermark.');
  }
  if(!Array.isArray(raw.attachments))throw new Error('Invalid attachment manifest.');
  if(new TextEncoder().encode(JSON.stringify(raw)).length>BUNDLE_LIMITS.bytes) throw new Error('Import byte limit exceeded.');
  if(raw.source.planningSchemaVersion!==(raw.planning as Workspace)?.schemaVersion || !Number.isFinite(Date.parse(raw.exportedAt))) throw new Error('Invalid planning version or export date.');
  const planning=parsePlanningImport(raw.planning,raw.exportedAt); const modules:WorkspaceBundle['modules']={};
  for(const [key,input] of Object.entries(raw.modules)) { const adapter=registry.get(key); strictObject(input,['schemaVersion','records'],'module wrapper'); if(!Number.isSafeInteger(input.schemaVersion)||input.schemaVersion<1) throw new Error('Invalid module version.'); if(!input || !Array.isArray(input.records) || input.records.length>BUNDLE_LIMITS.rows) throw new Error('Invalid adapter records.'); const records=adapter.parseAndMigrate(input); assertPortable(records); const ids=new Set<string>(); for(const row of records) { const id=(row as {id?:unknown})?.id; if(typeof id!=='string'||!id||ids.has(id)) throw new Error('Invalid or duplicate adapter identity.'); ids.add(id); } modules[key]={schemaVersion:adapter.schemaVersion,records}; }
  for(const adapter of registry.entries())if(!Object.hasOwn(modules,adapter.key)){if(!adapter.legacyOptional)throw new Error('Bundle is missing a registered adapter.');modules[adapter.key]={schemaVersion:adapter.schemaVersion,records:adapter.parseAndMigrate({schemaVersion:adapter.schemaVersion,records:[]})};}
  for(const adapter of registry.entries()) adapter.validateReferences?.({planning,modules},modules[adapter.key].records);
  validateAttachmentManifest(raw.attachments,modules,{allowLegacyEmpty:true});
  return {...raw,planning,modules};
}
/** Historical provenance only; a transaction adapter must append these without replacing the target ledger. */
export function historicalAuditRows(bundle:WorkspaceBundle,importHash:string):unknown[] { if(!/^[a-f0-9]{64}$/.test(importHash)) throw new Error('Invalid import hash.'); return (bundle.modules.audit_events?.records??[]).map((source,index)=>({id:`import:${importHash}:${index}`,kind:'imported-history',importHash,sourceRevision:bundle.source.workspaceRevision,sourceClaim:source})); }
export type { WorkspaceEnvelope };
