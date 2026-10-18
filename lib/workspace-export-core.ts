import type {RegisteredOwnerTable} from './workspace-modules.ts';
import type {ExportModule} from './workspace-export.ts';

export const BUNDLE_LIMITS = Object.freeze({ bytes: 8_000_000, rows: 10_000, pageSize: 200, attempts: 3 });

const forbidden = /(?:credential|password|authorization|approval|receipt|secret|(?:^|[_-])jobs?(?:$|[_-])|(?:access|refresh|lease|auth|device)[_-]?(?:token|key)|^tokens?$)/i;
export function assertPortable(value:unknown, depth=0):void {
  if (depth>40) throw new Error('Payload nesting exceeds limit.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) { for (const item of value) assertPortable(item,depth+1); return; }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value)!==Object.prototype) throw new Error('Payload must be portable JSON.');
  for (const [key,item] of Object.entries(value)) { if (forbidden.test(key) || ['__proto__','constructor','prototype'].includes(key)) throw new Error('Authority or unsafe payload field.'); assertPortable(item,depth+1); }
}
export function strictObject(value:unknown,keys:readonly string[],label:string):Record<string,unknown> {
  if(!value || typeof value!=='object' || Array.isArray(value) || Object.getPrototypeOf(value)!==Object.prototype) throw new Error(`Invalid ${label}.`);
  const record=value as Record<string,unknown>;
  if(Object.keys(record).some(key=>!keys.includes(key)) || keys.some(key=>!Object.hasOwn(record,key))) throw new Error(`Unknown or missing ${label} field.`);
  return record;
}
export const digest=(value:unknown):boolean=>typeof value==='string' && /^[a-f0-9]{64}$/.test(value);
function ownerRow(value:unknown,validate:(value:unknown)=>void):void {
  const row=strictObject(value,['id','rowRevision','contentHash','value'],'owner row');
  if(typeof row.id!=='string' || row.id.length<1 || row.id.length>128 || row.id.trim()!==row.id || !Number.isSafeInteger(row.rowRevision) || (row.rowRevision as number)<1 || !digest(row.contentHash)) throw new Error('Invalid owner row metadata.');
  assertPortable(row.value); validate(row.value);
}

export async function boundedPages<T extends {id:string}>(page:(after:string)=>Promise<T[]>):Promise<T[]> {
  const rows:T[]=[]; let after='';
  for (;;) { const next=await page(after); if (next.length>BUNDLE_LIMITS.pageSize) throw new Error('Page exceeds limit.'); for (const row of next) { if (typeof row.id!=='string' || row.id<=after) throw new Error('Invalid pagination order.'); after=row.id; rows.push(row); if(rows.length>BUNDLE_LIMITS.rows) throw new Error('Export row limit exceeded.'); } if(next.length<BUNDLE_LIMITS.pageSize) return rows; }
}
export function ownerExportModule(table:RegisteredOwnerTable,validate:(value:unknown)=>void):ExportModule {
  return {key:table,tables:[table],schemaVersion:1,policy:'replace',async exportRows(ctx) { const rows=await boundedPages(after=>ctx.query.list(table,{after,limit:BUNDLE_LIMITS.pageSize})); return rows.map(row=>{ const value=JSON.parse(row.payload_json); assertPortable(value); validate(value); const exported={id:row.id,rowRevision:row.row_revision,contentHash:row.content_hash,value}; ownerRow(exported,validate); return exported; }); },parseAndMigrate(input) { if(input.schemaVersion!==1) throw new Error('Unknown adapter version.'); for(const row of input.records) ownerRow(row,validate); return input.records; }};
}
