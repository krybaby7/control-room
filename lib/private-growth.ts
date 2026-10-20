import {privateSchemaMetadata,capturePrivateSchema,type PrivateSchemaContext} from './private-schema.ts';
import {getTableColumns,getTableName,is} from 'drizzle-orm';
import {SQLiteTable} from 'drizzle-orm/sqlite-core';
import * as schema from '../db/schema.ts';
import {PRIVATE_PROFILE_TABLES} from './private-profile.ts';
import {PrivateCapacityError,privateRowGrowth,type PrivateGrowth} from './private-capacity.ts';
import type {SqlDatabase} from './workspace-store.ts';
export type PrivatePhysicalRow=Record<string,string|number|null>;
type Table=Exclude<PrivateGrowth['table'],'baselineRemovalFences'>;
function fail():never{throw new PrivateCapacityError();}
export type PrivateGrowthContext=PrivateSchemaContext;
type SchemaMetadata=Awaited<ReturnType<typeof privateSchemaMetadata>>;
/** One operation's owner-free immutable schema quote. Caller MUST conjoin guard
 * with its atomic admission/write proof. Never retain this context as authority. */
export const createPrivateGrowthContext=capturePrivateSchema;
async function schemaFor(db:SqlDatabase,context?:PrivateGrowthContext):Promise<SchemaMetadata>{
 try{return await privateSchemaMetadata(db,context);}catch{fail();}
}
const definitions=new Map<string,SQLiteTable>();for(const value of Object.values(schema))if(is(value,SQLiteTable))definitions.set(getTableName(value),value);
function scalar(value:unknown):value is string|number|null{return value===null||typeof value==='string'||typeof value==='number'&&Number.isFinite(value);}
function defaultValue(raw:unknown):string|number|null{
 if(raw===null)return null;if(typeof raw!=='string')fail();const text=raw.trim();
 if(/^NULL$/iu.test(text))return null;
 if(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(text)){const value=Number(text);if(!Number.isFinite(value))fail();return value;}
 if(/^'(?:[^']|'')*'$/u.test(text))return text.slice(1,-1).replaceAll("''","'");
 fail();
}
/** Server-only metadata hydration. No request may supply table names, predicates,
 * defaults or SQL. The actual DB schema must match the compiled closed profile. */
export async function privateInsertGrowth(db:SqlDatabase,table:Table,values:PrivatePhysicalRow,context?:PrivateGrowthContext):Promise<PrivateGrowth>{return hydratePrivateInsert(table,values,await schemaFor(db,context));}
function hydratePrivateInsert(table:Table,values:PrivatePhysicalRow,metadata:SchemaMetadata):PrivateGrowth{
 if(!PRIVATE_PROFILE_TABLES.includes(table))fail();const definition=definitions.get(table);if(!definition)fail();
 const actual=metadata.tables[table];
 const expected=Object.values(getTableColumns(definition)).map(column=>column.name).sort(),names=actual.map(column=>column.name).sort();
 if(JSON.stringify(names)!==JSON.stringify(expected)||new Set(names).size!==names.length||Object.keys(values).some(name=>!names.includes(name))||Object.values(values).some(value=>!scalar(value)))fail();
 const compiled=Object.values(getTableColumns(definition));const row:PrivatePhysicalRow={};
 for(const column of actual){
  const fallback=defaultValue(column.dflt_value),provided=Object.hasOwn(values,column.name),expectedColumn=compiled.find(value=>value.name===column.name);if(!expectedColumn||column.type.toUpperCase()!==expectedColumn.getSQLType().toUpperCase()||column.notnull!==(expectedColumn.notNull?1:0))fail();const declaredDefault=expectedColumn.default??null;if(!scalar(declaredDefault)||fallback!==declaredDefault)fail();if(column.name==='user_id')continue;
  if(!provided&&column.notnull===1&&fallback===null)fail();
  row[column.name]=provided?values[column.name]:fallback;
 }
 return privateRowGrowth(table,null,row);
}
/** Conservative full AFTER-row charge. UPDATE only: no INSERT/upsert may use it.
 * Absence rejects rather than quoting zero for a later concurrently inserted row. */
export async function privateUpdateGrowth(db:SqlDatabase,owner:string,table:Table,where:string,bindings:(string|number|null)[],changes:PrivatePhysicalRow,incrementRevision=false,context?:PrivateGrowthContext):Promise<PrivateGrowth>{
 if(!PRIVATE_PROFILE_TABLES.includes(table)||!owner||typeof where!=='string'||!where||where.length>1000||/[;\0]/u.test(where))fail();
 const metadata=await schemaFor(db,context);
 const rows=(await db.prepare('SELECT * FROM '+table+' WHERE user_id=? AND ('+where+') LIMIT 101').bind(owner,...bindings).all<PrivatePhysicalRow>()).results;
 if(!rows.length||rows.length>100)fail();const growth:PrivateGrowth={table,bytes:0,rows:0};
 for(const row of rows){const after={...row,...changes};if(incrementRevision){const revision=row.operational_revision;if(typeof revision!=='number'||!Number.isSafeInteger(revision)||!Number.isSafeInteger(revision+1))fail();after.operational_revision=revision+1;}
  const full=hydratePrivateInsert(table,after,metadata);growth.bytes+=full.bytes;
 }
 if(!Number.isSafeInteger(growth.bytes))fail();return growth;
}
export function combinePrivateGrowth(...values:PrivateGrowth[]):PrivateGrowth[]{
 const combined=new Map<PrivateGrowth['table'],PrivateGrowth>();for(const value of values){if(!Number.isSafeInteger(value.bytes)||value.bytes<0||!Number.isSafeInteger(value.rows)||value.rows<0)fail();const row=combined.get(value.table)??{table:value.table,bytes:0,rows:0};row.bytes+=value.bytes;row.rows+=value.rows;if(!Number.isSafeInteger(row.bytes)||!Number.isSafeInteger(row.rows))fail();combined.set(value.table,row);}return [...combined.values()];
}
