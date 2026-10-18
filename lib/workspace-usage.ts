import {RECEIPT_CAPACITY} from './workspace-capacity.ts';
import type {SqlDatabase} from './workspace-store.ts';
import {OWNER_TABLES,ownerTable} from './workspace-modules.ts';
import {DRAFT_MAX_BYTES,DRAFT_TTL_MS} from './drafts.ts';
import {IMPORT_STAGING_LIMITS} from './import-staging.ts';
import {BACKUP_LIMITS} from './workspace-backups.ts';

/** Reporting window only. No age-based expiry, retirement, or permission to retry is inferred. */
export const RECENT_RETRY_HORIZON_DAYS=30;
export const RECEIPT_RETENTION_POLICY=Object.freeze({
 recentRetryHorizonDays:RECENT_RETRY_HORIZON_DAYS,
 recentRetryWindowPurpose:'reporting-only',
 legacyReceiptRetention:'indefinite',
 epochTombstoneRetention:'permanent',
 automaticPruning:false,
 automaticEpochRetirement:false,
 bulkDetailCompaction:'internal-only-after-retirement-and-draft-guard',
 compactionBlocker:'Epoch retirement is never automatic. Internal detail compaction requires an existing permanent retired tombstone and an atomic guard against unexpired server-draft references; retired device retries remain rejected.',
});
interface Size {count:number;bytes:number}
interface ExpiringSize extends Size {activeCount:number;expiredCount:number;activeBytes:number;expiredBytes:number}
export interface WorkspaceUsage {
 generatedAt:string;
 byteAccounting:'logical stored payload and metadata bytes; excludes owner identifiers, SQLite indexes and page overhead';
 planning:Size;
 receipts:Size & {legacyCount:number;epochCount:number;recentCount:number;olderCount:number;recentSince:string;limits:{soft:number;hard:number}};
 epochs:Size & {activeCount:number;retiredCount:number};
 drafts:ExpiringSize & {limits:{activeCount:number;perDraftBytes:number;retentionMs:number}};
 imports:ExpiringSize & {storedBytes:number;limits:{activeCount:number;rawBytes:number;perStageBytes:number;retentionMs:number}};
 backups:Size & {pinnedCount:number;readyCount:number;limits:{count:number;bytes:number;perBundleBytes:number}};
 modules:Array<Size & {module:typeof OWNER_TABLES[number]}>;
 audit:Size;
 receiptPolicy:typeof RECEIPT_RETENTION_POLICY;
}
const textBytes=(column:string)=>`length(CAST(${column} AS BLOB))`;
async function one<T>(db:SqlDatabase,sql:string,owner:string,...values:(string|number)[]):Promise<T>{const result=await db.prepare(sql).bind(...values,owner).first<T>();if(!result)throw new Error('Storage usage unavailable.');return result;}
function sizeSql(table:string,bytes:string){return `SELECT COUNT(*) AS count,COALESCE(SUM(${bytes}),0) AS bytes FROM ${table} WHERE user_id=?`;}
function expiringSql(table:string,bytes:string){return `SELECT COUNT(*) AS count,COALESCE(SUM(${bytes}),0) AS bytes,COALESCE(SUM(CASE WHEN expires_at>? THEN 1 ELSE 0 END),0) AS activeCount,COALESCE(SUM(CASE WHEN expires_at<=? THEN 1 ELSE 0 END),0) AS expiredCount,COALESCE(SUM(CASE WHEN expires_at>? THEN ${bytes} ELSE 0 END),0) AS activeBytes,COALESCE(SUM(CASE WHEN expires_at<=? THEN ${bytes} ELSE 0 END),0) AS expiredBytes FROM ${table} WHERE user_id=?`;}
/** Authenticated server identity only. Aggregates never return owner, record, epoch or mutation IDs. */
export async function readWorkspaceUsage(db:SqlDatabase,owner:string,now=new Date().toISOString()):Promise<WorkspaceUsage>{
 if(!owner)throw new Error('An authenticated owner is required.');const instant=Date.parse(now);if(!Number.isFinite(instant))throw new Error('Invalid usage timestamp.');const generatedAt=new Date(instant).toISOString();const recentSince=new Date(instant-RECENT_RETRY_HORIZON_DAYS*86400000).toISOString();
 const receiptBytes=`${textBytes('mutation_id')}+${textBytes('command_hash')}+${textBytes('committed_at')}+8`;
 const draftBytes=`${textBytes('id')}+${textBytes('payload_json')}+${textBytes('expires_at')}+8`;
 const [planning,receipts,epochs,drafts,imports,importStorage,backups,modules,audit]=await Promise.all([
  one<Size>(db,sizeSql('workspaces',`${textBytes('content')}+${textBytes('updated_at')}+8`),owner),
  one<Size & {legacyCount:number;epochCount:number;recentCount:number;olderCount:number}>(db,`SELECT COUNT(*) AS count,COALESCE(SUM(${receiptBytes}),0) AS bytes,COALESCE(SUM(CASE WHEN substr(mutation_id,1,3)='m1_' THEN 0 ELSE 1 END),0) AS legacyCount,COALESCE(SUM(CASE WHEN substr(mutation_id,1,3)='m1_' THEN 1 ELSE 0 END),0) AS epochCount,COALESCE(SUM(CASE WHEN committed_at>=? THEN 1 ELSE 0 END),0) AS recentCount,COALESCE(SUM(CASE WHEN committed_at<? THEN 1 ELSE 0 END),0) AS olderCount FROM workspace_mutations WHERE user_id=?`,owner,recentSince,recentSince),
  one<Size & {activeCount:number;retiredCount:number}>(db,`SELECT COUNT(*) AS count,COALESCE(SUM(${textBytes('epoch')}+${textBytes('status')}+${textBytes('created_at')}+COALESCE(${textBytes('retired_at')},0)),0) AS bytes,COALESCE(SUM(CASE WHEN status='active' THEN 1 ELSE 0 END),0) AS activeCount,COALESCE(SUM(CASE WHEN status='retired' THEN 1 ELSE 0 END),0) AS retiredCount FROM workspace_mutation_epochs WHERE user_id=?`,owner),
  one<ExpiringSize>(db,expiringSql('workspace_drafts',draftBytes),owner,generatedAt,generatedAt,generatedAt,generatedAt),
  one<ExpiringSize>(db,expiringSql('workspace_imports','bytes'),owner,generatedAt,generatedAt,generatedAt,generatedAt),
  one<{bytes:number}>(db,`SELECT COALESCE((SELECT SUM(${textBytes('id')}+${textBytes('content_hash')}+${textBytes('created_at')}+${textBytes('expires_at')}+${textBytes('metadata_json')}+8) FROM workspace_imports WHERE user_id=?),0)+COALESCE((SELECT SUM(${textBytes('import_id')}+${textBytes('content_base64')}+8) FROM workspace_import_chunks WHERE user_id=?),0) AS bytes`,owner,owner),
  one<Size & {pinnedCount:number;readyCount:number}>(db,`SELECT COUNT(*) AS count,COALESCE(SUM(bytes),0) AS bytes,COALESCE(SUM(CASE WHEN pinned<>0 THEN 1 ELSE 0 END),0) AS pinnedCount,COALESCE(SUM(CASE WHEN status='ready' THEN 1 ELSE 0 END),0) AS readyCount FROM workspace_backups WHERE user_id=?`,owner),
  Promise.all(OWNER_TABLES.map(async module=>({...await one<Size>(db,sizeSql(ownerTable(module),`${textBytes('id')}+${textBytes('payload_json')}+${textBytes('content_hash')}+8`),owner),module}))),
  one<Size>(db,sizeSql('audit_events',`${textBytes('payload_json')}+${textBytes('event_id')}+${textBytes('kind')}+${textBytes('entity_type')}+COALESCE(${textBytes('entity_id')},0)+${textBytes('occurred_at')}+COALESCE(${textBytes('stream_id')},0)+COALESCE(length(workspace_revision),0)+COALESCE(length(ordinal),0)+COALESCE(length(stream_sequence),0)`),owner),
 ]);
 return {generatedAt,byteAccounting:'logical stored payload and metadata bytes; excludes owner identifiers, SQLite indexes and page overhead',planning,receipts:{...receipts,recentSince,limits:RECEIPT_CAPACITY},epochs,drafts:{...drafts,limits:{activeCount:100,perDraftBytes:DRAFT_MAX_BYTES,retentionMs:DRAFT_TTL_MS}},imports:{...imports,storedBytes:importStorage.bytes,limits:{activeCount:IMPORT_STAGING_LIMITS.stages,rawBytes:IMPORT_STAGING_LIMITS.ownerBytes,perStageBytes:IMPORT_STAGING_LIMITS.bytes,retentionMs:IMPORT_STAGING_LIMITS.ttlMs}},backups:{...backups,limits:{count:BACKUP_LIMITS.snapshots,bytes:BACKUP_LIMITS.ownerBytes,perBundleBytes:BACKUP_LIMITS.d1BundleBytes}},modules,audit,receiptPolicy:RECEIPT_RETENTION_POLICY};
}
