import {recoveryPrivateTargetRow} from './recovery-private-transform.ts';
import type {SqlDatabase,SqlStatement} from './workspace-store.ts';
import {writeInactiveRecoveryTarget,bindFrozenPrivateContinuity,type RecoveryMaintenanceReceipt} from './recovery-maintenance.ts';

/**
 * Privileged local operator boundary, never a request-body SQL interpreter.
 * Every application write remains inside the target fence transaction. The
 * original database results are returned; no success/row-count is synthesized.
 * The receipt must originate from prepareInactiveRecoveryTarget, not JSON.
 */
export function inactiveRecoveryDatabase(db:SqlDatabase,receipt:RecoveryMaintenanceReceipt):SqlDatabase{
 const originals=new WeakMap<object,SqlStatement>();
 function wrap(statement:SqlStatement):SqlStatement{
  const value:SqlStatement={
   bind(...bindings){return wrap(statement.bind(...bindings));},
   first:statement.first.bind(statement),
   all:statement.all.bind(statement),
   async run(){const results=await writeInactiveRecoveryTarget(db,receipt,[statement]);return results[0];},
  };
  originals.set(value,statement);return value;
 }
 return {
  prepare(sql){return wrap(db.prepare(sql));},
  async batch(statements){
   const actual=statements.map(statement=>{
    const original=originals.get(statement);
    if(!original)throw new Error('Recovery batch contains a statement from a different database boundary.');
    return original;
   });
   return writeInactiveRecoveryTarget(db,receipt,actual);
  },
 };
}

import {PRIVATE_CONTINUITY_TABLES,verifyNativeOwnerAttribution,validateRecoveryPrivateContinuity,type RecoveryPrivateContinuity} from './recovery-private-continuity.ts';
import {getWorkspaceNamespaces} from './workspace-namespaces.ts';
import {canonical} from './canonical-json.ts';
type Scalar=string|number|null;
/**
 * Closed single-owner restoration policy. All dispatch authority is removed;
 * attempt journals, reservations, receipts and permanent removal fences remain.
 * Backup-chunk rekeying is handled separately by copyRecoveryBackupArchives.
 */
export async function installRecoveryPrivateContinuity(
 source:SqlDatabase,sourceReceipt:RecoveryMaintenanceReceipt,
 target:SqlDatabase,targetReceipt:RecoveryMaintenanceReceipt,
 raw:RecoveryPrivateContinuity,expectedPrivateSha256:string,
):Promise<{retainedAttempts:number;retainedRemovalFences:number}>{
 const value=await validateRecoveryPrivateContinuity(raw,{sha256:expectedPrivateSha256,
  manifestSha256:sourceReceipt.manifestSha256,ownerContextHash:sourceReceipt.ownerContextHash,
  sourceContext:sourceReceipt.sourceContext,ownerId:sourceReceipt.ownerId});
 await bindFrozenPrivateContinuity(source,sourceReceipt,value,expectedPrivateSha256);
 if(targetReceipt.ownerId!==sourceReceipt.ownerId||targetReceipt.manifestSha256!==sourceReceipt.manifestSha256||
  targetReceipt.ownerContextHash!==sourceReceipt.ownerContextHash||canonical(targetReceipt.sourceContext)!==canonical(sourceReceipt.sourceContext))
  throw new Error('Source and inactive target recovery identities differ.');
 
 const db=inactiveRecoveryDatabase(target,targetReceipt),owner=sourceReceipt.ownerId,now=sourceReceipt.createdAt;
 const sourceNamespaces=await getWorkspaceNamespaces(source,owner),targetNamespaces=await getWorkspaceNamespaces(target,owner);
 if(!sourceNamespaces||!targetNamespaces||targetNamespaces.blobNamespace===sourceNamespaces.blobNamespace||targetNamespaces.blobNamespace===sourceNamespaces.auditNamespace||canonical(Array.from(targetNamespaces.cursorSecret))===canonical(Array.from(sourceNamespaces.cursorSecret)))throw new Error('Recovery requires fresh target blob/cursor authority.');
 await db.prepare('UPDATE workspace_source_namespaces SET audit_namespace=? WHERE user_id=?').bind(sourceNamespaces.auditNamespace,owner).run();
 const tables=PRIVATE_CONTINUITY_TABLES.filter(table=>!['backup_archives','backup_archive_objects','backup_archive_cleanup_claims','backup_archive_retained_objects','workspace_backups'].includes(table)),remaining=new Set(tables),order:string[]=[];
 // FK order comes from the exact fingerprinted target schema, never package SQL.
 while(remaining.size){
  let progressed=false;
  for(const table of [...remaining]){
   const dependencies=(await target.prepare('PRAGMA foreign_key_list("'+table+'")').all<{table:string}>()).results
    .map(row=>row.table).filter(other=>other!==table&&remaining.has(other as typeof table));
   if(!dependencies.length){order.push(table);remaining.delete(table);progressed=true;}
  }
  if(!progressed)throw new Error('Unsupported private continuity foreign key cycle.');
 }
 for(const table of order){
  const rows=value.tables[table as keyof typeof value.tables] as unknown as Record<string,Scalar>[];
  const pending:Record<string,Scalar>[]=[];
  for(const original of rows){
   if(table==='workspace_job_intents'){
    const expected=recoveryPrivateTargetRow('workspace_job_intents',original,now),columns=Object.keys(expected);
    const existing=await target.prepare('SELECT '+columns.join(',')+' FROM workspace_job_intents WHERE user_id=? AND id=?').bind(owner,original.id).first<Record<string,Scalar>>();
    if(existing){if(canonical(existing)!==canonical(expected))throw new Error('Existing recovery intent root differs.');continue;}
   }
   pending.push(original);
  }
  for(let offset=0;offset<pending.length;offset+=32){
   const statements=pending.slice(offset,offset+32).map(original=>{
    const row=recoveryPrivateTargetRow(table as typeof PRIVATE_CONTINUITY_TABLES[number],original,now);
    const columns=Object.keys(row);if(columns.some(name=>!/^[a-z_][a-z0-9_]*$/.test(name)))throw new Error('Invalid closed private column.');
    return db.prepare('INSERT INTO '+table+'(user_id,'+columns.join(',')+') VALUES('+['user_id',...columns].map(()=>'?').join(',')+')')
     .bind(owner,...columns.map(column=>row[column]));
   });
   if(statements.length)await db.batch(statements);
  }
 }
 // These are independently recaptured native owner deletion fences from the
 // frozen database, not imported historical claims promoted to authority.
 for(const row of value.baselineRemovalFences){
  const actual=await target.prepare('SELECT kind,entity_type,entity_id,occurred_at,payload_json FROM audit_events WHERE user_id=? AND event_id=?').bind(owner,row.event_id).first<Record<string,Scalar>>();
  if(!actual||canonical(actual)!==canonical({kind:row.kind,entity_type:row.entity_type,entity_id:row.entity_id,occurred_at:row.occurred_at,payload_json:row.payload_json}))throw new Error('Original native removal event was not preserved.');
 }
 await verifyNativeOwnerAttribution(target,owner,value);
 const epoch=sourceReceipt.sourceContext.executionEpoch;
 if(!Number.isSafeInteger(epoch+1))throw new Error('Recovery execution epoch exhausted.');
 await db.prepare('INSERT INTO workspace_execution_state(user_id,epoch,restored_at) VALUES(?,?,?)').bind(owner,epoch+1,now).run();
 return {retainedAttempts:value.tables.job_attempts.length,retainedRemovalFences:value.baselineRemovalFences.length};
}

/** Root rows must precede normalized agent_jobs' real FK children. They remain
 * inert and target-fenced; only exact actual-source private proof is accepted. */
export async function installRecoveryIntentRoots(source:SqlDatabase,sourceReceipt:RecoveryMaintenanceReceipt,target:SqlDatabase,targetReceipt:RecoveryMaintenanceReceipt,raw:RecoveryPrivateContinuity,expectedPrivateSha256:string):Promise<number>{
 const value=await validateRecoveryPrivateContinuity(raw,{sha256:expectedPrivateSha256,manifestSha256:sourceReceipt.manifestSha256,ownerContextHash:sourceReceipt.ownerContextHash,sourceContext:sourceReceipt.sourceContext,ownerId:sourceReceipt.ownerId});
 await bindFrozenPrivateContinuity(source,sourceReceipt,value,expectedPrivateSha256);
 if(targetReceipt.ownerId!==sourceReceipt.ownerId||targetReceipt.manifestSha256!==sourceReceipt.manifestSha256||targetReceipt.ownerContextHash!==sourceReceipt.ownerContextHash||canonical(targetReceipt.sourceContext)!==canonical(sourceReceipt.sourceContext))throw new Error('Source and inactive target recovery identities differ.');
 const owner=sourceReceipt.ownerId,db=inactiveRecoveryDatabase(target,targetReceipt);
 if((await target.prepare('SELECT COUNT(*) count FROM workspace_job_intents').first<{count:number}>())?.count!==0)throw new Error('Recovery intent root target must be empty.');
 const rows=value.tables.workspace_job_intents;
 for(let offset=0;offset<rows.length;offset+=32){
  const statements=rows.slice(offset,offset+32).map(original=>{
   const row=recoveryPrivateTargetRow('workspace_job_intents',original,sourceReceipt.createdAt),columns=Object.keys(row);
   return db.prepare('INSERT INTO workspace_job_intents(user_id,'+columns.join(',')+') VALUES('+['user_id',...columns].map(()=>'?').join(',')+')').bind(owner,...columns.map(column=>row[column]));
  });
  if(statements.length)await db.batch(statements);
 }
 return rows.length;
}
