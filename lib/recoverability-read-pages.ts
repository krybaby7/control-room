import {canonical} from './canonical-json.ts';
import {compareSqliteText} from './sqlite-text-order.ts';
import {OWNER_TABLES,ownerTable,type RegisteredOwnerTable,type ModuleRow} from './workspace-modules.ts';
import type {SqlDatabase} from './workspace-store.ts';
import {BUNDLE_LIMITS} from './workspace-export-core.ts';
import {validateOperationalWatermarks} from './operational-watermarks.ts';
export const RECOVERY_READ_GROUP_PAGES=37;
export const RECOVERY_READ_COMPOUND_TERMS=5;
const auditTag='__audit__';
const streamTables=new Set<RegisteredOwnerTable>(['agent_results','evaluation_runs','source_observations','source_sync_runs','integration_history','review_snapshots','review_analysis_runs','notification_events','automation_occurrences']);
const columns=['snapshot_tag','snapshot_empty','id','row_revision','payload_json','content_hash','stream_sequence','workspace_revision','ordinal','stream_id','kind','entity_type','entity_id','occurred_at'] as const;
const orderedColumns=[...columns].sort(),nullAudit='NULL AS workspace_revision,NULL AS ordinal,NULL AS stream_id,NULL AS kind,NULL AS entity_type,NULL AS entity_id,NULL AS occurred_at';
type AuditPage={after:string;watermarks:Record<string,number>};
export interface RecoveryReadPageInput {tables:readonly {table:RegisteredOwnerTable;after:string}[];audit?:AuditPage}
export type RecoveryPhysicalRow=ModuleRow&{stream_sequence?:number};
export interface RecoveryReadPages {physical:Map<RegisteredOwnerTable,RecoveryPhysicalRow[]>;auditPage?:Record<string,unknown>[]}
function fail():never{throw new Error('Invalid closed recovery page response.');}
function validateInput(input:RecoveryReadPageInput):void{
 if(!input||OWNER_TABLES.length>36||BUNDLE_LIMITS.pageSize!==200||!Array.isArray(input.tables)||!input.tables.length||input.tables.length>36||new Set(input.tables.map(value=>value?.table)).size!==input.tables.length)fail();
 for(const value of input.tables)if(!value||!OWNER_TABLES.includes(value.table)||typeof value.after!=='string')fail();
 if(input.audit){if(typeof input.audit.after!=='string')fail();validateOperationalWatermarks(input.audit.watermarks);}
}
/** Closed compiled inventory only. One owner binding per grouped statement and independently bounded
 * BINARY key cursors; no table name/predicate/limit comes from a request.
 * Each branch certifies its presence even when its own page is empty. */
export function buildRecoveryReadPageQueries(owner:string,input:RecoveryReadPageInput):Array<{sql:string;bindings:(string|number|null)[]}>{
 if(typeof owner!=='string'||!owner)fail();validateInput(input);
 const pages:Array<{tag:string;page:string;rows:string;bindings:(string|number|null)[]}> = [];
 for(const {table,after}of input.tables){
  if(!OWNER_TABLES.includes(table)||typeof after!=='string')fail();const name=ownerTable(table);
  const sequence=streamTables.has(table)?'stream_sequence':'NULL AS stream_sequence';
  pages.push({tag:name,page:`SELECT id,row_revision,payload_json,content_hash,${sequence} FROM ${name} WHERE user_id=(SELECT owner FROM recovery_page_scope) AND id>? ORDER BY id COLLATE BINARY LIMIT 200`,rows:`p.id,p.row_revision,p.payload_json,p.content_hash,p.stream_sequence,${nullAudit}`,bindings:[after]});
 }
 if(input.audit){
  if(typeof input.audit.after!=='string')fail();validateOperationalWatermarks(input.audit.watermarks);
  pages.push({tag:auditTag,page:`SELECT event_id,workspace_revision,ordinal,stream_id,stream_sequence,kind,entity_type,entity_id,occurred_at,payload_json FROM audit_events WHERE user_id=(SELECT owner FROM recovery_page_scope) AND event_id>? AND NOT EXISTS(SELECT 1 FROM json_each(?) frozen WHERE frozen.key=audit_events.stream_id AND audit_events.stream_sequence>frozen.value) ORDER BY event_id COLLATE BINARY LIMIT 200`,rows:'p.event_id AS id,NULL AS row_revision,p.payload_json,NULL AS content_hash,p.stream_sequence,p.workspace_revision,p.ordinal,p.stream_id,p.kind,p.entity_type,p.entity_id,p.occurred_at',bindings:[input.audit.after,canonical(input.audit.watermarks)]});
 }
 // Independent MATERIALIZED page CTEs retain their own BINARY cursor and
 // LIMIT. A separate empty branch certifies absence without padding or dropping a selected tag.
 // Full inventory has 37 bounded page/result pairs, never an aggregate blob.
 pages.sort((a,b)=>compareSqliteText(a.tag,b.tag));
 const queries:Array<{sql:string;bindings:(string|number|null)[]}>=[];
 for(let offset=0;offset<pages.length;offset+=RECOVERY_READ_GROUP_PAGES){
  const group=pages.slice(offset,offset+RECOVERY_READ_GROUP_PAGES),bindings:(string|number|null)[]=[owner,...group.flatMap(page=>page.bindings)];
  const definitions=group.map((page,index)=>`recovery_page_${index} AS MATERIALIZED (${page.page})`);
  const leaves=group.map((page,index)=>{
   const name=`recovery_result_${index}`;
   definitions.push(`${name} AS MATERIALIZED (SELECT '${page.tag}' AS snapshot_tag,0 AS snapshot_empty,${page.rows} FROM recovery_page_${index} p UNION ALL SELECT '${page.tag}' AS snapshot_tag,1 AS snapshot_empty,${columns.slice(2).map(column=>`NULL AS ${column}`).join(',')} WHERE NOT EXISTS(SELECT 1 FROM recovery_page_${index}))`);
   return name;
  });
  // D1 permits at most five terms in EACH compound SELECT. A bounded tree
  // of named materialized CTEs keeps every compound below that native cap;
  // no limit is raised and no selected table/page is omitted or aggregated.
  let level=0,current=leaves;
  while(current.length>1){
   const following:string[]=[];
   for(let index=0;index<current.length;index+=RECOVERY_READ_COMPOUND_TERMS){const name=`recovery_merge_${level}_${index}`;definitions.push(`${name} AS MATERIALIZED (${current.slice(index,index+RECOVERY_READ_COMPOUND_TERMS).map(source=>`SELECT * FROM ${source}`).join(' UNION ALL ')})`);following.push(name);}
   current=following;level++;if(level>3)fail();
  }
  const sql='WITH recovery_page_scope AS MATERIALIZED(SELECT ? AS owner), '+definitions.join(', ')+' SELECT * FROM '+current[0]+' ORDER BY snapshot_tag COLLATE BINARY,id COLLATE BINARY';
  if(bindings.length>100||new TextEncoder().encode(sql).byteLength>100000)fail();queries.push({sql,bindings});
 }
 if(queries.length>1)fail();return queries;
}
/** Decode only the exact selected tags. Missing empty certificates, malformed
 * padding, repeated keys and mixed empty/nonempty branches all fail closed. */
export function decodeRecoveryReadPages(input:RecoveryReadPageInput,raws:unknown):RecoveryReadPages{
 validateInput(input);
 const tags=new Map<string,{after:string;table?:RegisteredOwnerTable;empty:boolean;count:number;physicalRows:RecoveryPhysicalRow[];auditRows:Record<string,unknown>[]}>();
 for(const value of input.tables){if(tags.has(value.table))fail();tags.set(value.table,{after:value.after,table:value.table,empty:false,count:0,physicalRows:[],auditRows:[]});}
 if(input.audit)tags.set(auditTag,{after:input.audit.after,empty:false,count:0,physicalRows:[],auditRows:[]});
 if(!Array.isArray(raws)||raws.length>tags.size*BUNDLE_LIMITS.pageSize)fail();
 let previousTag:string|undefined,previousId:string|null=null;
 for(const raw of raws){
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||canonical(Object.keys(raw).sort())!==canonical(orderedColumns))fail();
  const row:Record<string,unknown>={};for(const [key,value]of Object.entries(raw))row[key]=value;
  if(typeof row.snapshot_tag!=='string'||(row.snapshot_empty!==0&&row.snapshot_empty!==1))fail();
  const tag=row.snapshot_tag,selected=tags.get(tag);if(!selected)fail();
  if(previousTag!==undefined&&(compareSqliteText(tag,previousTag)<0||tag===previousTag&&previousId!==null&&(typeof row.id!=='string'||compareSqliteText(row.id,previousId)<=0)))fail();
  previousTag=tag;
  if(row.snapshot_empty===1){
   if(selected.empty||selected.count||columns.slice(2).some(key=>row[key]!==null))fail();
   selected.empty=true;previousId=null;continue;
  }
  if(selected.empty||typeof row.id!=='string'||compareSqliteText(row.id,selected.after)<=0||typeof row.payload_json!=='string')fail();
  if(selected.count>=BUNDLE_LIMITS.pageSize)fail();selected.count++;selected.after=row.id;previousId=row.id;
  if(selected.table){
   if(typeof row.row_revision!=='number'||!Number.isSafeInteger(row.row_revision)||row.row_revision<1||typeof row.content_hash!=='string'||!/^[a-f0-9]{64}$/u.test(row.content_hash)||columns.slice(7).some(key=>row[key]!==null))fail();
   const value:RecoveryPhysicalRow={id:row.id,row_revision:row.row_revision,payload_json:row.payload_json,content_hash:row.content_hash};
   if(streamTables.has(selected.table)){if(typeof row.stream_sequence!=='number'||!Number.isSafeInteger(row.stream_sequence)||row.stream_sequence<0)fail();value.stream_sequence=row.stream_sequence;}else if(row.stream_sequence!==null)fail();
   selected.physicalRows.push(value);
  }else{
   if(row.row_revision!==null||row.content_hash!==null)fail();
   selected.auditRows.push({event_id:row.id,workspace_revision:row.workspace_revision,ordinal:row.ordinal,stream_id:row.stream_id,stream_sequence:row.stream_sequence,kind:row.kind,entity_type:row.entity_type,entity_id:row.entity_id,occurred_at:row.occurred_at,payload_json:row.payload_json});
  }
 }
 const physical=new Map<RegisteredOwnerTable,RecoveryPhysicalRow[]>();let auditPage:Record<string,unknown>[]|undefined;
 for(const [tag,value]of tags){if(!value.empty&&!value.count)fail();if(tag===auditTag)auditPage=value.auditRows;else physical.set(value.table!,value.physicalRows);}
 return {physical,...(input.audit?{auditPage}:{} )};
}
export async function readRecoveryReadPages(db:SqlDatabase,owner:string,input:RecoveryReadPageInput):Promise<RecoveryReadPages>{
 const queries=buildRecoveryReadPageQueries(owner,input),results=await db.batch(queries.map(query=>db.prepare(query.sql).bind(...query.bindings)));
 if(!Array.isArray(results)||results.length!==queries.length)fail();
 const rows:unknown[]=[];for(const result of results){if(!Array.isArray(result?.results))fail();rows.push(...result.results);}
 return decodeRecoveryReadPages(input,rows);
}
