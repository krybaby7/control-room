import {canonical} from './canonical-json.ts';
import {PRIVATE_PROFILE_TABLES} from './private-profile.ts';
import type {SqlDatabase} from './workspace-store.ts';
import {assertPrivateSchemaContract,type PrivateSchemaColumn} from './private-schema-contract.ts';
export type {PrivateSchemaColumn} from './private-schema-contract.ts';
type Table=typeof PRIVATE_PROFILE_TABLES[number];
export interface PrivateSchemaGuard {sql:string;bindings:(string|number|null)[]}
export interface PrivateSchemaMetadata {readonly tables:Readonly<Record<Table,readonly PrivateSchemaColumn[]>>;readonly guard:PrivateSchemaGuard}
/** Opaque, DB-bound capture for ONE operation. Its exact guard must fence every
 * atomic write using the captured columns; this is never capacity/owner authority. */
export interface PrivateSchemaContext {readonly guard:{readonly sql:string;readonly bindings:readonly (string|number|null)[]}}
const captures=new WeakMap<PrivateSchemaContext,{db:SqlDatabase;metadata:PrivateSchemaMetadata}>();
export async function capturePrivateSchema(db:SqlDatabase):Promise<PrivateSchemaContext>{
 const metadata=await privateSchemaMetadata(db),context=Object.freeze({guard:metadata.guard});
 captures.set(context,{db,metadata});return context;
}
type SchemaRow={name:string;sql:string};
type Entry={fingerprint:string;columns:Promise<Readonly<Record<Table,readonly PrivateSchemaColumn[]>>>};
const caches=new WeakMap<SqlDatabase,Entry>();
const inventory=canonical([...PRIVATE_PROFILE_TABLES]);
const schemaQuery="SELECT name,sql FROM sqlite_master WHERE type='table' AND name IN(SELECT value FROM json_each(?)) ORDER BY name";
function fail():never{throw new Error('Private storage schema is unavailable.');}
async function discover(db:SqlDatabase,rows:SchemaRow[]):Promise<Readonly<Record<Table,readonly PrivateSchemaColumn[]>>>{
 const entries=await Promise.all(rows.map(async row=>{
  // Only the compiled closed inventory supplies identifiers.
  const name=row.name as Table;
  const columns=(await db.prepare('PRAGMA table_info('+name+')').all<PrivateSchemaColumn>()).results;
  if(!columns.length||new Set(columns.map(column=>column.name)).size!==columns.length||columns.some(column=>!Number.isSafeInteger(column.cid)||column.cid<0||!/^[a-z_][a-z0-9_]*$/u.test(column.name)||typeof column.type!=='string'||!Number.isInteger(column.notnull)||![0,1].includes(column.notnull)||(column.dflt_value!==null&&typeof column.dflt_value!=='string')||!Number.isSafeInteger(column.pk)||column.pk<0))fail();
  return [name,Object.freeze(columns.map(column=>Object.freeze({...column})))] as const;
 }));
 const tables=Object.freeze(Object.fromEntries(entries)) as Readonly<Record<Table,readonly PrivateSchemaColumn[]>>;
 assertPrivateSchemaContract(tables);
 return tables;
}
/** Only physical schema metadata is cached, never owner rows, quota values,
 * principal state or authorization. Every uncaptured call reads the current closed schema
 * fingerprint. Parallel misses share discovery, installed before PRAGMAs start.
 * The returned guard MUST be included in the same atomic write admission as
 * every quota proof relying on these columns. A schema change never receives
 * implicit permission because an earlier metadata promise happened to resolve. */
export async function privateSchemaMetadata(db:SqlDatabase,context?:PrivateSchemaContext):Promise<PrivateSchemaMetadata>{
 if(context!==undefined){const capture=captures.get(context);if(!capture||capture.db!==db)fail();return capture.metadata;}
 const rows=(await db.prepare(schemaQuery).bind(inventory).all<SchemaRow>()).results;
 if(rows.length!==PRIVATE_PROFILE_TABLES.length||new Set(rows.map(row=>row.name)).size!==rows.length||rows.some(row=>!PRIVATE_PROFILE_TABLES.includes(row.name as Table)||typeof row.sql!=='string'||!row.sql||row.sql.length>100000)||rows.some((row,index)=>index>0&&rows[index-1].name>=row.name))fail();
 const fingerprint=canonical(rows);
 if(new TextEncoder().encode(fingerprint).byteLength>180000)fail();
 let entry=caches.get(db);
 if(!entry||entry.fingerprint!==fingerprint){
  // Queue discovery after this synchronous cache installation. Concurrent callers
  // completing their own fingerprint reads see this same in-flight promise.
  const columns=Promise.resolve().then(()=>discover(db,rows));
  entry={fingerprint,columns};caches.set(db,entry);
  const selected=entry;void columns.catch(()=>{if(caches.get(db)===selected)caches.delete(db);});
 }
 const tables=await entry.columns;
 const guard:PrivateSchemaGuard={sql:"(SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN(SELECT value FROM json_each(?)))=? AND NOT EXISTS(SELECT name,sql FROM sqlite_master WHERE type='table' AND name IN(SELECT value FROM json_each(?)) EXCEPT SELECT json_extract(value,'$.name'),json_extract(value,'$.sql') FROM json_each(?))",bindings:[inventory,rows.length,inventory,fingerprint]};
 return Object.freeze({tables,guard:Object.freeze({sql:guard.sql,bindings:Object.freeze([...guard.bindings]) as unknown as (string|number|null)[]})});
}
