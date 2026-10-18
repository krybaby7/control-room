import type {SqlDatabase} from './workspace-store.ts';
import {BACKUP_LIMITS} from './workspace-backups.ts';
const countSql="(SELECT COUNT(*) FROM workspace_backups WHERE user_id=scope.owner)+(SELECT COUNT(*) FROM backup_archives a WHERE a.user_id=scope.owner AND a.status<>'retired' AND NOT EXISTS(SELECT 1 FROM workspace_backups b WHERE b.user_id=a.user_id AND b.id=a.id))";
const bytesSql="(SELECT COALESCE(SUM(bytes),0) FROM workspace_backups WHERE user_id=scope.owner)+(SELECT COALESCE(SUM(bytes),0) FROM backup_archive_objects WHERE user_id=scope.owner AND purged_at IS NULL)+(SELECT COALESCE(SUM(metadata_bytes),0) FROM backup_archives a WHERE a.user_id=scope.owner AND a.status<>'retired' AND NOT EXISTS(SELECT 1 FROM workspace_backups b WHERE b.user_id=a.user_id AND b.id=a.id))";
const invalidSql="EXISTS(SELECT 1 FROM backup_archive_objects WHERE user_id=scope.owner AND purged_at IS NULL AND (typeof(bytes)<>'integer' OR bytes<1)) OR EXISTS(SELECT 1 FROM backup_archives WHERE user_id=scope.owner AND (typeof(metadata_bytes)<>'integer' OR metadata_bytes<0 OR status NOT IN ('preparing','ready','failed','retired')))";
export async function readBackupQuotaUsage(db:SqlDatabase,owner:string):Promise<{count:number;bytes:number}>{
 const row=await db.prepare('WITH scope(owner) AS (SELECT ?) SELECT '+countSql+' AS count,'+bytesSql+' AS bytes,('+invalidSql+') AS invalid FROM scope').bind(owner).first<{count:number;bytes:number;invalid:number}>();
 if(!row||row.invalid!==0||!Number.isSafeInteger(row.count)||row.count<0||!Number.isSafeInteger(row.bytes)||row.bytes<0)throw new Error('Backup quota bookkeeping is unavailable.');return {count:row.count,bytes:row.bytes};
}
/** Embed in the same transaction BEFORE new reserved objects or D1 backup bytes. */
export function backupQuotaGuard(owner:string,additionalBytes=0,additionalSnapshots=0):{sql:string;bindings:(string|number|null)[]}{
 if(!owner||!Number.isSafeInteger(additionalBytes)||additionalBytes<0||!Number.isSafeInteger(additionalSnapshots)||additionalSnapshots<0)throw new Error('Invalid backup quota admission.');
 return {sql:'EXISTS(WITH scope(owner) AS (SELECT ?) SELECT 1 FROM scope WHERE NOT('+invalidSql+') AND '+countSql+'+?<=? AND '+bytesSql+'+?<=?)',bindings:[owner,additionalSnapshots,BACKUP_LIMITS.snapshots,additionalBytes,BACKUP_LIMITS.ownerBytes]};
}
