import type {SqlDatabase} from '../workspace-store.ts';
import {privateInsertGrowth} from '../private-growth.ts';
import {requirePrivateCapacity} from '../private-capacity.ts';

export interface HistoryObjectManifest {key:string;sha256:string;bytes:number}
export interface HistoryObjectScope {ownerId:string;sourceId:string;epoch:string;scopeRevision:number}
/** An adapter must enforce maxBytes before buffering a remote response. No public URL API. */
export interface PrivateHistoryBucket {
  put(key:string,bytes:Uint8Array):Promise<unknown>;
  get(key:string,maxBytes:number):Promise<Uint8Array|null>;
  delete(key:string):Promise<unknown>;
}
export interface HistoryObjectSqlGuard {sql:string;params:(string|number|null)[]}
export interface HistoryObjectDeps {
  db:SqlDatabase;
  bucket:PrivateHistoryBucket;
  /** Revalidate current principal, source epoch and scope revision; never a cached enrollment result. */
  authorize():Promise<boolean>;
  /** Persisted source/principal authority predicate, evaluated in the final metadata UPDATE. */
  guardSql?:HistoryObjectSqlGuard;
  now?:()=>string;
}
export class HistoryObjectCapacityError extends Error{}
export class HistoryObjectAttemptError extends Error{readonly code:'pending'|'failed';constructor(code:'pending'|'failed'){super('History object attempt '+code);this.code=code;}}
export const MAX_HISTORY_OBJECT_BYTES=16*1024*1024;
export const MAX_HISTORY_OWNER_OBJECT_BYTES=256*1024*1024;
const now=(deps:HistoryObjectDeps)=>deps.now?.()??new Date().toISOString();
function scopeValues(scope:HistoryObjectScope){
  if(!scope.ownerId||!scope.sourceId||!scope.epoch||!Number.isSafeInteger(scope.scopeRevision)||scope.scopeRevision<1)throw Error('Invalid history object scope.');
  return [scope.ownerId,scope.sourceId,scope.epoch,scope.scopeRevision];
}
function validateManifest(manifest:HistoryObjectManifest){
  if(!/^history\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/u.test(manifest.key)||! /^[a-f0-9]{64}$/u.test(manifest.sha256)||!Number.isSafeInteger(manifest.bytes)||manifest.bytes<0||manifest.bytes>MAX_HISTORY_OBJECT_BYTES)throw Error('Invalid history object manifest.');
}
async function digest(value:Uint8Array){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',Uint8Array.from(value).buffer)),byte=>byte.toString(16).padStart(2,'0')).join('');}
async function authorized(deps:HistoryObjectDeps){if(!await deps.authorize())throw Error('History object access denied.');}
async function verify(deps:HistoryObjectDeps,manifest:HistoryObjectManifest){
  const bytes=await deps.bucket.get(manifest.key,manifest.bytes);
  if(!bytes||bytes.byteLength!==manifest.bytes||await digest(bytes)!==manifest.sha256)throw Error('History object integrity verification failed.');
  return bytes;
}
/** Each call issues a new opaque key. Caller-supplied keys and overwrites are never accepted. */
export async function stageHistoryObject(deps:HistoryObjectDeps,input:HistoryObjectScope&{bytes:Uint8Array;sha256:string;reservationKey?:string}):Promise<HistoryObjectManifest>{
  scopeValues(input);
  if(!(input.bytes instanceof Uint8Array)||input.bytes.byteLength>MAX_HISTORY_OBJECT_BYTES)throw Error('History object exceeds bounded byte limit.');
  const value=input.bytes.slice();
  const manifest={key:input.reservationKey??`history/${crypto.randomUUID()}/${crypto.randomUUID()}`,sha256:input.sha256,bytes:value.byteLength};
  validateManifest(manifest);
  if(await digest(value)!==manifest.sha256)throw Error('History object digest mismatch.');
  await authorized(deps);
  if(input.reservationKey){
    const existing=await deps.db.prepare('SELECT source_id,epoch,scope_revision,sha256,bytes,status,pending_token,purged_at FROM history_object_ledger WHERE user_id=? AND key=?').bind(input.ownerId,manifest.key).first<{source_id:string;epoch:string;scope_revision:number;sha256:string;bytes:number;status:string;pending_token:string|null;purged_at:string|null}>();
    if(existing){
      if(existing.source_id!==input.sourceId||existing.epoch!==input.epoch||existing.scope_revision!==input.scopeRevision||existing.sha256!==manifest.sha256||existing.bytes!==manifest.bytes)throw Error('History upload identity was reused with different bytes or scope.');
      if(existing.status==='staging'||existing.pending_token!==null)throw new HistoryObjectAttemptError('pending');
      if(existing.status!=='ready'||existing.purged_at!==null)throw new HistoryObjectAttemptError('failed');
      if(deps.guardSql&&!await deps.db.prepare('SELECT 1 WHERE '+deps.guardSql.sql).bind(...deps.guardSql.params).first())throw Error('History upload authority changed.');
      await verify(deps,manifest);await authorized(deps);return manifest;
    }
  }
  const token=crypto.randomUUID();
  const createdAt=now(deps),row={user_id:input.ownerId,key:manifest.key,source_id:input.sourceId,epoch:input.epoch,scope_revision:input.scopeRevision,sha256:manifest.sha256,bytes:manifest.bytes,status:'staging',pending_token:token,created_at:createdAt};
  const capacity=await requirePrivateCapacity(deps.db,input.ownerId,{growth:[await privateInsertGrowth(deps.db,'history_object_ledger',row)]});
  let admitted;try{admitted=await deps.db.prepare(`INSERT INTO history_object_ledger(user_id,key,source_id,epoch,scope_revision,sha256,bytes,status,pending_token,created_at) SELECT ?,?,?,?,?,?,?,'staging',?,? WHERE ${capacity.sql} AND (SELECT COUNT(*) FROM history_object_ledger WHERE user_id=? AND purged_at IS NULL)<10000 AND (SELECT COALESCE(SUM(bytes),0) FROM history_object_ledger WHERE user_id=? AND purged_at IS NULL)<=?${deps.guardSql?` AND (${deps.guardSql.sql})`:''}`).bind(input.ownerId,manifest.key,input.sourceId,input.epoch,input.scopeRevision,manifest.sha256,manifest.bytes,token,createdAt,...capacity.bindings,input.ownerId,input.ownerId,MAX_HISTORY_OWNER_OBJECT_BYTES-manifest.bytes,...(deps.guardSql?.params??[])).run();}catch(error){
    if(input.reservationKey&&await deps.db.prepare('SELECT 1 FROM history_object_ledger WHERE user_id=? AND key=?').bind(input.ownerId,manifest.key).first())return stageHistoryObject(deps,input);
    throw error;
  }
  if(admitted.meta.changes!==1){await authorized(deps);if(deps.guardSql&&!await deps.db.prepare('SELECT 1 WHERE '+deps.guardSql.sql).bind(...deps.guardSql.params).first())throw Error('History object authority changed before staging.');throw new HistoryObjectCapacityError('History object capacity changed before staging.');}
  // The pending token stays persisted until the actual physical attempt settles. A timed-out
  // caller must not detach the PUT and clear it, or later cleanup could race a late write.
  try{
    await authorized(deps);
    await deps.bucket.put(manifest.key,value);
    await authorized(deps);
    await verify(deps,manifest);
    await authorized(deps);
    const guard=deps.guardSql;
    const result=await deps.db.prepare(`UPDATE history_object_ledger SET status='ready',pending_token=NULL,verified_at=? WHERE user_id=? AND key=? AND status='staging' AND pending_token=?${guard?` AND (${guard.sql})`:''}`).bind(now(deps),input.ownerId,manifest.key,token,...(guard?.params??[])).run();
    if(result.meta.changes!==1)throw Error('History object authority changed before finalization.');
    return manifest;
  }catch(error){
    await deps.db.prepare("UPDATE history_object_ledger SET status='abandoned',pending_token=NULL WHERE user_id=? AND key=? AND status='staging' AND pending_token=?").bind(input.ownerId,manifest.key,token).run();
    throw error;
  }
}
/** Embed this predicate in every ingestion write's successful transaction guard. */
export function finalizedHistoryObjectsGuard(scope:HistoryObjectScope,manifests:readonly HistoryObjectManifest[]):HistoryObjectSqlGuard{
  scopeValues(scope);
  for(const manifest of manifests)validateManifest(manifest);
  if(new Set(manifests.map(item=>item.key)).size!==manifests.length||manifests.length>1000)throw Error('Invalid history object manifest set.');
  // Bind the entire closed vector once: a legitimate 250-message page must
  // retain every object predicate without exceeding D1's 100-variable limit.
  const vector=JSON.stringify(manifests);
  if(new TextEncoder().encode(vector).length>2*1024*1024)throw Error('History manifest exceeds bound.');
  return {sql:"NOT EXISTS(SELECT 1 FROM json_each(?) manifest WHERE NOT EXISTS(SELECT 1 FROM history_object_ledger object WHERE object.user_id=? AND object.source_id=? AND object.epoch=? AND object.scope_revision=? AND object.key=json_extract(manifest.value,'$.key') AND object.sha256=json_extract(manifest.value,'$.sha256') AND object.bytes=json_extract(manifest.value,'$.bytes') AND object.status='ready' AND object.pending_token IS NULL AND object.purged_at IS NULL))",params:[vector,scope.ownerId,scope.sourceId,scope.epoch,scope.scopeRevision]};
}
export async function requireFinalizedHistoryObjects(deps:HistoryObjectDeps,scope:HistoryObjectScope,manifests:readonly HistoryObjectManifest[]):Promise<void>{
  await authorized(deps);
  const guard=finalizedHistoryObjectsGuard(scope,manifests);
  const row=await deps.db.prepare(`SELECT 1 AS valid WHERE ${guard.sql}`).bind(...guard.params).first();
  if(!row)throw Error('History object is not finalized in this owner/source scope.');
}
export async function readHistoryObject(deps:HistoryObjectDeps,scope:HistoryObjectScope,manifest:HistoryObjectManifest):Promise<Uint8Array>{
  await requireFinalizedHistoryObjects(deps,scope,[manifest]);
  const bytes=await verify(deps,manifest);
  await requireFinalizedHistoryObjects(deps,scope,[manifest]);
  return bytes;
}
/** Maintenance-only: ready objects are never candidates. Abandoned objects cannot be
 * referenced by ingestion, and can never return to ready or start another physical PUT. */
export async function purgeAbandonedHistoryObjects(deps:HistoryObjectDeps,ownerId:string,graceMs:number,isReferenced:(ownerId:string,key:string)=>Promise<boolean>,sourceId?:string):Promise<number>{
  if(!ownerId||!Number.isSafeInteger(graceMs)||graceMs<0)throw Error('Invalid history object cleanup policy.');
  await authorized(deps);
  const cutoff=new Date(Date.parse(now(deps))-graceMs).toISOString();
  const rows=(await deps.db.prepare(`SELECT key FROM history_object_ledger WHERE user_id=? AND status='abandoned' AND pending_token IS NULL AND purged_at IS NULL AND created_at<=?${sourceId?' AND source_id=?':''} ORDER BY key LIMIT 100`).bind(ownerId,cutoff,...(sourceId?[sourceId]:[])).all<{key:string}>()).results;
  let purged=0;
  for(const {key} of rows){
    if(await isReferenced(ownerId,key))continue;
    const eligible=await deps.db.prepare("SELECT 1 FROM history_object_ledger WHERE user_id=? AND key=? AND status='abandoned' AND pending_token IS NULL AND purged_at IS NULL AND created_at<=?").bind(ownerId,key,cutoff).first();
    if(!eligible||await isReferenced(ownerId,key))continue;
    await authorized(deps);
    await deps.bucket.delete(key);
    const result=await deps.db.prepare("UPDATE history_object_ledger SET purged_at=? WHERE user_id=? AND key=? AND status='abandoned' AND pending_token IS NULL AND purged_at IS NULL").bind(now(deps),ownerId,key).run();
    purged+=result.meta.changes??0;
  }
  return purged;
}
