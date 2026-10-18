import type { Workspace, WorkspaceEnvelope } from './types.ts';
import type { SqlDatabase } from './workspace-store.ts';
import { readCurrent } from './workspace-store.ts';
import { OWNER_TABLES, ownerReader, type RegisteredOwnerTable, type OwnerScopedReader } from './workspace-modules.ts';
import { parsePlanningImport } from './workspace-codec.ts';

export const BUNDLE_LIMITS = Object.freeze({ bytes: 8_000_000, rows: 10_000, pageSize: 200, attempts: 3 });
export interface AttachmentManifestEntry { id: string; filename: string; contentType: string; bytes: number; sha256: string; archivePath: string | null; availability: 'included' | 'missing' | 'excluded'; }
export interface WorkspaceBundle {
  format: 'control-room'; bundleVersion: 1; exportedAt: string;
  source: { workspaceRevision: number; planningSchemaVersion: number; moduleWatermarks: Record<string,string>; sourceHashes: Record<string,string> };
  planning: Workspace; modules: Record<string,{schemaVersion:number; records:unknown[]}>;
  attachments: AttachmentManifestEntry[]; completeness: 'complete' | 'metadata-only';
}
export interface ExportContext { userId: string; sourceRevision: number; query: OwnerScopedReader; db: SqlDatabase; }
export interface ImportContext { planning: Workspace; modules: WorkspaceBundle['modules']; }
export interface ExportModule { key:string; schemaVersion:number; policy:'replace'|'append-only'; exportRows(context:ExportContext):Promise<unknown[]>; parseAndMigrate(input:{schemaVersion:number;records:unknown[]}):unknown[]; validateReferences?(context:ImportContext,rows:unknown[]):void; }
const forbiddenModule = /(?:credential|token|secret|password|authorization|approval|receipt|job|device_key|workspace_mutation|command_guard)/i;
const forbidden = /(?:credential|password|authorization|approval|receipt|secret|(?:^|[_-])jobs?(?:$|[_-])|(?:access|refresh|lease|auth|device)[_-]?(?:token|key)|^tokens?$)/i;
export function assertPortable(value:unknown, depth=0):void {
  if (depth>40) throw new Error('Payload nesting exceeds limit.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) { for (const item of value) assertPortable(item,depth+1); return; }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value)!==Object.prototype) throw new Error('Payload must be portable JSON.');
  for (const [key,item] of Object.entries(value)) { if (forbidden.test(key) || ['__proto__','constructor','prototype'].includes(key)) throw new Error('Authority or unsafe payload field.'); assertPortable(item,depth+1); }
}
function strictObject(value:unknown,keys:readonly string[],label:string):Record<string,unknown> {
  if(!value || typeof value!=='object' || Array.isArray(value) || Object.getPrototypeOf(value)!==Object.prototype) throw new Error(`Invalid ${label}.`);
  const record=value as Record<string,unknown>;
  if(Object.keys(record).some(key=>!keys.includes(key)) || keys.some(key=>!Object.hasOwn(record,key))) throw new Error(`Unknown or missing ${label} field.`);
  return record;
}
const digest=(value:unknown):boolean=>typeof value==='string' && /^[a-f0-9]{64}$/.test(value);
function ownerRow(value:unknown,validate:(value:unknown)=>void):void {
  const row=strictObject(value,['id','rowRevision','contentHash','value'],'owner row');
  if(typeof row.id!=='string' || row.id.length<1 || row.id.length>128 || row.id.trim()!==row.id || !Number.isSafeInteger(row.rowRevision) || (row.rowRevision as number)<1 || !digest(row.contentHash)) throw new Error('Invalid owner row metadata.');
  assertPortable(row.value); validate(row.value);
}
/** Actor metadata is semantic provenance; authenticated owner identifiers stay in the internal ledger. */
function portableAudit(value:unknown):unknown {
  if(Array.isArray(value)) return value.map(portableAudit);
  if(value && typeof value==='object') return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,key==='actorId'?'owner':portableAudit(item)]));
  return value;
}
export function canonical(value:unknown):string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value==='object') return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical((value as Record<string,unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export async function contentHash(value:string|Uint8Array):Promise<string> { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',(typeof value==='string'?new TextEncoder().encode(value):value) as BufferSource)),n=>n.toString(16).padStart(2,'0')).join(''); }
export class ExportRegistry {
  private modules = new Map<string,ExportModule>();
  register(adapter:ExportModule):void {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(adapter.key) || forbiddenModule.test(adapter.key) || this.modules.has(adapter.key) || !Number.isSafeInteger(adapter.schemaVersion) || adapter.schemaVersion<1) throw new Error('Invalid or duplicate export adapter.');
    this.modules.set(adapter.key,Object.freeze({...adapter}));
  }
  entries():ExportModule[] { return [...this.modules.values()].sort((a,b)=>a.key.localeCompare(b.key)); }
  get(key:string):ExportModule { const adapter=this.modules.get(key); if (!adapter) throw new Error('Unknown export adapter.'); return adapter; }
}
async function boundedPages<T extends {id:string}>(page:(after:string)=>Promise<T[]>):Promise<T[]> {
  const rows:T[]=[]; let after='';
  for (;;) { const next=await page(after); if (next.length>BUNDLE_LIMITS.pageSize) throw new Error('Page exceeds limit.'); for (const row of next) { if (typeof row.id!=='string' || row.id<=after) throw new Error('Invalid pagination order.'); after=row.id; rows.push(row); if(rows.length>BUNDLE_LIMITS.rows) throw new Error('Export row limit exceeded.'); } if(next.length<BUNDLE_LIMITS.pageSize) return rows; }
}
export function ownerExportModule(table:RegisteredOwnerTable,validate:(value:unknown)=>void):ExportModule {
  return {key:table,schemaVersion:1,policy:'replace',async exportRows(ctx) { const rows=await boundedPages(after=>ctx.query.list(table,{after,limit:BUNDLE_LIMITS.pageSize})); return rows.map(row=>{ const value=JSON.parse(row.payload_json); assertPortable(value); validate(value); const exported={id:row.id,rowRevision:row.row_revision,contentHash:row.content_hash,value}; ownerRow(exported,validate); return exported; }); },parseAndMigrate(input) { if(input.schemaVersion!==1) throw new Error('Unknown adapter version.'); for(const row of input.records) ownerRow(row,validate); return input.records; }};
}
export const exportRegistry = new ExportRegistry();
export function registerExportModule(adapter:ExportModule):void { exportRegistry.register(adapter); }
const auditColumns='event_id, workspace_revision, ordinal, stream_id, stream_sequence, kind, entity_type, entity_id, occurred_at, payload_json';
exportRegistry.register({key:'audit_events',schemaVersion:1,policy:'append-only',async exportRows(ctx) {
  const rows=await boundedPages<Record<string,unknown> & {id:string}>(async after=>(await ctx.db.prepare(`SELECT ${auditColumns} FROM audit_events WHERE user_id = ? AND event_id > ? ORDER BY event_id LIMIT ?`).bind(ctx.userId,after,BUNDLE_LIMITS.pageSize).all<Record<string,unknown>>()).results.map(row=>({id:row.event_id as string,...row})));
  return rows.map(({payload_json,...row})=>({...row,payload:portableAudit(JSON.parse(payload_json as string))}));
},parseAndMigrate(input) { if(input.schemaVersion!==1) throw new Error('Unknown audit version.'); for(const row of input.records) { assertPortable(row); if(!row || typeof row!=='object' || typeof (row as {id:unknown}).id!=='string') throw new Error('Invalid audit record.'); } return input.records; }});
export async function exportWorkspaceBundle(db:SqlDatabase,userId:string,options:{now?:()=>string;registry?:ExportRegistry}={}):Promise<WorkspaceBundle> {
  if(!userId) throw new Error('A signed-in owner is required.'); const registry=options.registry??exportRegistry;
  for(let attempt=0;attempt<BUNDLE_LIMITS.attempts;attempt++) {
    const before=await readCurrent(db,userId); const ctx={db,userId,sourceRevision:before.revision,query:ownerReader(db,userId)};
    for(const table of OWNER_TABLES) if(!registry.entries().some(adapter=>adapter.key===table) && (await ctx.query.list(table,{limit:1})).length) throw new Error('Populated owner adapter has no export adapter.');
    const modules:WorkspaceBundle['modules']={}; const hashes:Record<string,string>={}; let stable=true;
    for(const adapter of registry.entries()) { const records=await adapter.exportRows(ctx); assertPortable(records); if(records.length>BUNDLE_LIMITS.rows) throw new Error('Export row limit exceeded.'); modules[adapter.key]={schemaVersion:adapter.schemaVersion,records}; hashes[adapter.key]=await contentHash(canonical(records)); }
    for(const adapter of registry.entries()) { if(await contentHash(canonical(await adapter.exportRows(ctx)))!==hashes[adapter.key]) stable=false; }
    const after=await readCurrent(db,userId); if(!stable || before.revision!==after.revision || canonical(before.workspace)!==canonical(after.workspace)) continue;
    hashes.planning=await contentHash(canonical(before.workspace));
    const bundle:WorkspaceBundle={format:'control-room',bundleVersion:1,exportedAt:(options.now??(()=>new Date().toISOString()))(),source:{workspaceRevision:before.revision,planningSchemaVersion:before.workspace.schemaVersion,moduleWatermarks:{...hashes},sourceHashes:hashes},planning:before.workspace,modules,attachments:[],completeness:'metadata-only'};
    if(new TextEncoder().encode(JSON.stringify(bundle)).length>BUNDLE_LIMITS.bytes) throw new Error('Export byte limit exceeded.'); return bundle;
  }
  throw new Error('Workspace changed during export; retry.');
}
export function parseWorkspaceBundle(value:unknown,registry:ExportRegistry=exportRegistry):WorkspaceBundle {
  if(!value || typeof value!=='object') throw new Error('Invalid bundle.'); const raw=value as WorkspaceBundle;
  strictObject(raw,['format','bundleVersion','exportedAt','source','planning','modules','attachments','completeness'],'bundle');
  strictObject(raw.source,['workspaceRevision','planningSchemaVersion','moduleWatermarks','sourceHashes'],'source');
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
  if(!Array.isArray(raw.attachments) || raw.attachments.length) throw new Error('Attachment restore is not supported by the core importer.');
  if(new TextEncoder().encode(JSON.stringify(raw)).length>BUNDLE_LIMITS.bytes) throw new Error('Import byte limit exceeded.');
  if(raw.source.planningSchemaVersion!==(raw.planning as Workspace)?.schemaVersion || !Number.isFinite(Date.parse(raw.exportedAt))) throw new Error('Invalid planning version or export date.');
  const planning=parsePlanningImport(raw.planning,raw.exportedAt); const modules:WorkspaceBundle['modules']={};
  for(const [key,input] of Object.entries(raw.modules)) { const adapter=registry.get(key); strictObject(input,['schemaVersion','records'],'module wrapper'); if(!Number.isSafeInteger(input.schemaVersion)||input.schemaVersion<1) throw new Error('Invalid module version.'); if(!input || !Array.isArray(input.records) || input.records.length>BUNDLE_LIMITS.rows) throw new Error('Invalid adapter records.'); const records=adapter.parseAndMigrate(input); assertPortable(records); const ids=new Set<string>(); for(const row of records) { const id=(row as {id?:unknown})?.id; if(typeof id!=='string'||!id||ids.has(id)) throw new Error('Invalid or duplicate adapter identity.'); ids.add(id); } modules[key]={schemaVersion:adapter.schemaVersion,records}; }
  for(const adapter of registry.entries()) if(!Object.hasOwn(modules,adapter.key)) throw new Error('Bundle is missing a registered adapter.');
  for(const adapter of registry.entries()) adapter.validateReferences?.({planning,modules},modules[adapter.key].records);
  return {...raw,planning,modules};
}
/** Historical provenance only; a transaction adapter must append these without replacing the target ledger. */
export function historicalAuditRows(bundle:WorkspaceBundle,importHash:string):unknown[] { if(!/^[a-f0-9]{64}$/.test(importHash)) throw new Error('Invalid import hash.'); return (bundle.modules.audit_events?.records??[]).map((source,index)=>({id:`import:${importHash}:${index}`,kind:'imported-history',importHash,sourceRevision:bundle.source.workspaceRevision,sourceClaim:source})); }
export type { WorkspaceEnvelope };
