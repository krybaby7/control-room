import {BACKUP_LIMITS} from './workspace-backups.ts';
import {BUNDLE_LIMITS} from './workspace-export-core.ts';
import type {RegisteredOwnerTable} from './workspace-modules.ts';
/** Mirrors the existing compiler/import serializer argument bound. This is not a new quota.
 * Shared compiler/import callers may import this bound to keep serializer admission aligned.
 */
export const RECOVERABILITY_SQL_ARGUMENT_BYTES=1_800_000;
export interface RecoverabilityTableInput {table:RegisteredOwnerTable;beforeRowsJson:string;expandedAfterPayloadJson:string;beforeRowCount:number;afterRowCount:number}
export interface RecoverabilityMeasureInput {
 /** Exact JSON.stringify(full portable bundle), including every envelope and nested string escape. */
 serializedBundle:string;
 /** Exact aggregate preprojection physical import serializer, when applicable. */
 serializedExpandedImport?:string;
 /** Exact compiler arguments AFTER physical projection/typed expansion, not raw value sums. */
 tables:RecoverabilityTableInput[];
 historicalAudit?:{preparedJson:string;compiledWrappedJson:string;rowCount:number};
 /** Adapter/physical/aggregate counts, named according to each existing bounded collection. */
 counts?:Array<{name:string;rows:number}>;
 /** Additional exact single SQL bindings, e.g. complete reference assertions. */
 sqlArguments?:Array<{name:string;serialized:string}>;
}
export type RecoverabilityRefusalCode='d1_backup_bytes'|'bundle_bytes'|'expanded_import_bytes'|'sql_argument_bytes'|'row_limit'|'invalid_measurement';
export interface RecoverabilityRefusal {code:RecoverabilityRefusalCode;scope:string;actual:number|null;limit:number|null}
export interface RecoverabilityMeasurements {
 bundleBytes:number|null;d1BackupBytes:number|null;expandedImportBytes:number|null;
 tables:Array<{table:string;beforeRowsBytes:number|null;expandedAfterPayloadBytes:number|null;beforeRowCount:number|null;afterRowCount:number|null}>;
 historicalAudit:{preparedBytes:number|null;compiledWrappedBytes:number|null;rowCount:number|null}|null;
 counts:Array<{name:string;rows:number|null}>;
 sqlArguments:Array<{name:string;bytes:number|null}>;
}
export interface RecoverabilityMeasurement {allowed:boolean;reasons:RecoverabilityRefusal[];measurements:RecoverabilityMeasurements}
/** Exact serializer measurement only: no DB, storage, registry mutations or admission claim.
 * Callers must supply the prospective complete bundle and actual compiler strings/counts,
 * and independently validate their domain/schema, editor CAS and full operational vector.
 * Strings are deliberately not parsed/re-serialized: that would alter the bytes being bound.
 */
export function measureRecoverability(input:RecoverabilityMeasureInput):RecoverabilityMeasurement{
 const reasons:RecoverabilityRefusal[]=[],measurements:RecoverabilityMeasurements={bundleBytes:null,d1BackupBytes:null,expandedImportBytes:null,tables:[],historicalAudit:null,counts:[],sqlArguments:[]};const invalid=(scope:string)=>reasons.push({code:'invalid_measurement',scope,actual:null,limit:null});
 function bytes(value:string,scope:string):number|null{if(typeof value!=='string'){invalid(scope);return null;}return new TextEncoder().encode(value).byteLength;}
 function bound(actual:number|null,limit:number,scope:string,code:RecoverabilityRefusalCode){if(actual!==null&&actual>limit)reasons.push({code,scope,actual,limit});}
 function rows(value:number,scope:string):number|null{if(!Number.isSafeInteger(value)||value<0){invalid(scope);return null;}bound(value,BUNDLE_LIMITS.rows,scope,'row_limit');return value;}
 function named(value:string,scope:string){if(typeof value!=='string'||!value||value.length>256){invalid(scope);return '(invalid)';}return value;}
 if(!input||typeof input!=='object'||Array.isArray(input)){invalid('input');return {allowed:false,reasons,measurements};}
 measurements.bundleBytes=bytes(input.serializedBundle,'bundle');measurements.d1BackupBytes=measurements.bundleBytes;bound(measurements.bundleBytes,BUNDLE_LIMITS.bytes,'bundle','bundle_bytes');bound(measurements.d1BackupBytes,BACKUP_LIMITS.d1BundleBytes,'d1-backup','d1_backup_bytes');
 if(input.serializedExpandedImport!==undefined){measurements.expandedImportBytes=bytes(input.serializedExpandedImport,'expanded-import');bound(measurements.expandedImportBytes,BUNDLE_LIMITS.bytes,'expanded-import','expanded_import_bytes');}
 if(!Array.isArray(input.tables))invalid('tables');else{const seen=new Set<string>();for(const [index,table]of input.tables.entries()){if(!table||typeof table!=='object'){invalid(`tables[${index}]`);continue;}const name=named(table.table,`tables[${index}].table`);if(seen.has(name))invalid(`table:${name}:duplicate`);seen.add(name);const beforeRowsBytes=bytes(table.beforeRowsJson,`table:${name}:before`),expandedAfterPayloadBytes=bytes(table.expandedAfterPayloadJson,`table:${name}:expanded-after`),beforeRowCount=rows(table.beforeRowCount,`table:${name}:before-rows`),afterRowCount=rows(table.afterRowCount,`table:${name}:after-rows`);bound(beforeRowsBytes,RECOVERABILITY_SQL_ARGUMENT_BYTES,`table:${name}:before`,'sql_argument_bytes');bound(expandedAfterPayloadBytes,RECOVERABILITY_SQL_ARGUMENT_BYTES,`table:${name}:expanded-after`,'sql_argument_bytes');measurements.tables.push({table:name,beforeRowsBytes,expandedAfterPayloadBytes,beforeRowCount,afterRowCount});}}
 if(input.historicalAudit!==undefined){const history=input.historicalAudit;if(!history||typeof history!=='object')invalid('historical-audit');else{const preparedBytes=bytes(history.preparedJson,'historical-audit:prepared'),compiledWrappedBytes=bytes(history.compiledWrappedJson,'historical-audit:compiled'),rowCount=rows(history.rowCount,'historical-audit:rows');bound(preparedBytes,RECOVERABILITY_SQL_ARGUMENT_BYTES,'historical-audit:prepared','sql_argument_bytes');bound(compiledWrappedBytes,RECOVERABILITY_SQL_ARGUMENT_BYTES,'historical-audit:compiled','sql_argument_bytes');measurements.historicalAudit={preparedBytes,compiledWrappedBytes,rowCount};}}
 for(const kind of ['counts','sqlArguments']as const){const entries=input[kind];if(entries===undefined)continue;if(!Array.isArray(entries)){invalid(kind);continue;}const names=new Set<string>();for(const [index,entry]of entries.entries()){if(!entry||typeof entry!=='object'){invalid(`${kind}[${index}]`);continue;}const name=named(entry.name,`${kind}[${index}].name`);if(names.has(name))invalid(`${kind}:${name}:duplicate`);names.add(name);if(kind==='counts'){const count=entry as {name:string;rows:number};measurements.counts.push({name,rows:rows(count.rows,`count:${name}`)});}else{const argument=entry as {name:string;serialized:string},size=bytes(argument.serialized,`sql:${name}`);bound(size,RECOVERABILITY_SQL_ARGUMENT_BYTES,`sql:${name}`,'sql_argument_bytes');measurements.sqlArguments.push({name,bytes:size});}}}
 return {allowed:reasons.length===0,reasons,measurements};
}
