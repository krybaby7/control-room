import {z} from 'zod';
import {canonical,contentHash} from '../canonical-json.ts';
import {evidenceDateSchema} from '../evidence-validation.ts';
import {DEVICE_LIMITS} from '../devices/contracts.ts';
import {RUNTIME_LIMITS} from './contracts.ts';
import type {SqlDatabase,SqlStatement} from '../workspace-store.ts';
export interface RuntimePruneResult {heartbeats:number;observations:number;aggregates:number;windows:number;rateBuckets:number;floorsAdvanced:number}
/** Private bounded raw retention. Session tombstones/floors and copied latest bodies survive forever. */
export async function pruneRuntime(db:SqlDatabase,owner:string,now:string,options:{limit?:number}={}):Promise<RuntimePruneResult>{
 if(!owner||owner.trim()!==owner||owner.length>256)throw new Error('An authenticated owner is required.');evidenceDateSchema.parse(now);const limit=z.number().int().min(1).max(RUNTIME_LIMITS.retentionPage).parse(options.limit??RUNTIME_LIMITS.retentionPage),rawCutoff=new Date(Date.parse(now)-RUNTIME_LIMITS.rawRetentionMs).toISOString(),aggregateCutoff=new Date(Date.parse(now)-RUNTIME_LIMITS.aggregateRetentionMs).toISOString(),rateCutoff=new Date(Date.parse(now)-60000).toISOString();
 const result:RuntimePruneResult={heartbeats:0,observations:0,aggregates:0,windows:0,rateBuckets:0,floorsAdvanced:0};let budget=limit;
 const rows=(await db.prepare('SELECT device_id,boot_id,sequence,payload_hash,received_at FROM device_heartbeats WHERE user_id=? AND julianday(received_at)<julianday(?) ORDER BY received_at,device_id,boot_id,sequence LIMIT ?').bind(owner,rawCutoff,limit).all<{device_id:string;boot_id:string;sequence:number;payload_hash:string;received_at:string}>()).results;
 for(const row of rows){const count=await db.prepare('SELECT COUNT(*) n FROM runtime_observations WHERE user_id=? AND device_id=? AND boot_id=? AND sequence=?').bind(owner,row.device_id,row.boot_id,row.sequence).first<{n:number}>();const cost=2+(count?.n??0);if(cost>budget)continue;
 const token=crypto.randomUUID(),mutation='runtime-prune:'+token,keys=[owner,mutation,token],gate='EXISTS(SELECT 1 FROM workspace_command_guards WHERE user_id=? AND mutation_id=? AND claim_token=? AND valid=1)',where='user_id=? AND device_id=? AND boot_id=? AND sequence=?',identity=[owner,row.device_id,row.boot_id,row.sequence],statements:SqlStatement[]=[
 db.prepare('INSERT INTO workspace_command_guards(user_id,mutation_id,claim_token,valid) SELECT ?,?,?,1 WHERE EXISTS(SELECT 1 FROM device_heartbeats WHERE '+where+' AND payload_hash=? AND received_at=?) AND (SELECT COUNT(*) FROM runtime_observations WHERE '+where+')=?').bind(...keys,...identity,row.payload_hash,row.received_at,...identity,count?.n??0),
 db.prepare('UPDATE device_sessions SET compacted_through_sequence=MAX(compacted_through_sequence,?) WHERE user_id=? AND device_id=? AND boot_id=? AND '+gate).bind(row.sequence,owner,row.device_id,row.boot_id,...keys),
 db.prepare('DELETE FROM runtime_observations WHERE '+where+' AND '+gate).bind(...identity,...keys),
 db.prepare('DELETE FROM device_heartbeats WHERE '+where+' AND '+gate).bind(...identity,...keys),
 db.prepare('DELETE FROM workspace_command_guards WHERE user_id=? AND mutation_id=? AND claim_token=?').bind(...keys)];
 const effects=await db.batch(statements);if(effects[0]?.meta.changes===1){result.floorsAdvanced+=effects[1]?.meta.changes??0;result.observations+=effects[2]?.meta.changes??0;result.heartbeats+=effects[3]?.meta.changes??0;budget-=cost;}
 }
 if(budget>0){const deleted=await db.prepare('DELETE FROM runtime_minute_aggregates WHERE rowid IN (SELECT rowid FROM runtime_minute_aggregates WHERE user_id=? AND julianday(bucket_at)<julianday(?) ORDER BY bucket_at LIMIT ?)').bind(owner,aggregateCutoff,budget).run();result.aggregates=deleted.meta.changes??0;budget-=result.aggregates;}
 if(budget>0){const deleted=await db.prepare('DELETE FROM device_live_windows WHERE rowid IN (SELECT w.rowid FROM device_live_windows w JOIN device_sessions s ON s.user_id=w.user_id AND s.device_id=w.device_id AND s.boot_id=w.boot_id WHERE w.user_id=? AND julianday(w.issued_at)<julianday(?) AND w.sequence<=s.compacted_through_sequence ORDER BY w.issued_at LIMIT ?)').bind(owner,rawCutoff,budget).run();result.windows=deleted.meta.changes??0;budget-=result.windows;}
 if(budget>0){const devices=(await db.prepare('SELECT id FROM devices WHERE user_id=? ORDER BY id LIMIT ?').bind(owner,DEVICE_LIMITS.devices+1).all<{id:string}>()).results;if(devices.length>DEVICE_LIMITS.devices)throw new Error('Device retention scope exceeds bound.');for(const device of devices){if(budget<=0)break;const key='runtime-history:'+await contentHash(canonical([owner,device.id])),deleted=await db.prepare('DELETE FROM device_rate_buckets WHERE rowid IN (SELECT rowid FROM device_rate_buckets WHERE bucket_key=? AND julianday(bucket_at)<julianday(?) ORDER BY bucket_at LIMIT ?)').bind(key,rateCutoff,budget).run();result.rateBuckets+=deleted.meta.changes??0;budget-=deleted.meta.changes??0;}}
 return result;
}
