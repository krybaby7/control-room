import {getTableColumns,getTableName,is} from 'drizzle-orm';
import {SQLiteTable} from 'drizzle-orm/sqlite-core';
import * as schema from '../db/schema.ts';
import {PRIVATE_PROFILE_TABLES} from './private-profile.ts';
export interface PrivateSchemaColumn {readonly cid:number;readonly name:string;readonly type:string;readonly notnull:number;readonly dflt_value:string|null;readonly pk:number}
type Table=typeof PRIVATE_PROFILE_TABLES[number];
export type PrivateSchemaTables=Readonly<Record<Table,readonly PrivateSchemaColumn[]>>;
const definitions=new Map<string,SQLiteTable>();
for(const value of Object.values(schema))if(is(value,SQLiteTable))definitions.set(getTableName(value),value);
function fail():never{throw new Error('Private storage schema differs from the compiled contract.');}
function scalar(value:unknown):value is string|number|null{return value===null||typeof value==='string'||typeof value==='number'&&Number.isFinite(value);}
function scalarDefault(raw:string|null):string|number|null{
 if(raw===null)return null;const value=raw.trim();
 if(/^NULL$/iu.test(value))return null;
 if(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(value)){const number=Number(value);if(Number.isFinite(number))return number;fail();}
 if(/^'(?:[^']|'')*'$/u.test(value))return value.slice(1,-1).replaceAll("''","'");
 fail();
}
/** Closed compiled physical-column contract. A newer unsupported database is not
 * a reason to silently hydrate fewer columns or accept a different default.
 * No owner records, private credentials, authority state or quota data are read. */
export function assertPrivateSchemaContract(tables:PrivateSchemaTables):void{
 const keys=Object.keys(tables);if(keys.length!==PRIVATE_PROFILE_TABLES.length||keys.some(key=>!PRIVATE_PROFILE_TABLES.includes(key as Table)))fail();
 for(const table of PRIVATE_PROFILE_TABLES){
  const definition=definitions.get(table),actual=tables[table];if(!definition||!actual?.length)fail();
  const compiled=Object.values(getTableColumns(definition)),expected=compiled.map(column=>column.name).sort(),names=actual.map(column=>column.name).sort();
  if(JSON.stringify(expected)!==JSON.stringify(names)||new Set(names).size!==names.length)fail();
  for(const column of actual){const declared=compiled.find(value=>value.name===column.name);if(!declared||column.type.toUpperCase()!==declared.getSQLType().toUpperCase()||column.notnull!==(declared.notNull?1:0))fail();const fallback=scalarDefault(column.dflt_value),compiledDefault=declared.default??null;if(!scalar(compiledDefault)||fallback!==compiledDefault)fail();}
 }
}
export const assertSchemaContract=assertPrivateSchemaContract;
