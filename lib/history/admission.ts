import {canonical} from '../canonical-json.ts';
import {readOperationalWatermarks} from '../operational-watermarks.ts';
import {measureProspectiveRecoverability} from '../recoverability-snapshot.ts';
import {recoverabilityAssertions,RecoverabilityCapacityError} from '../recoverability-admission.ts';
import {privateInsertGrowth,privateUpdateGrowth,combinePrivateGrowth} from '../private-growth.ts';
import {requirePrivateCapacity} from '../private-capacity.ts';
import type {SqlDatabase,SqlStatement} from '../workspace-store.ts';
import type {JsonValue} from '../workspace-protocol.ts';
import type {HistoryAdmissionContext} from './store.ts';
/** Server-only adapter. Quotes the actual portable module image and every private
 * head/job byte; all returned assertions must precede DML in the caller's batch. */
export function historyRecoveryAdmission(db:SqlDatabase):(context:HistoryAdmissionContext)=>Promise<SqlStatement[]>{
 return async context=>{
  const {owner,now,mutationId,guard,guardBindings,rows,job,watermark}=context;
  const watermarks=await readOperationalWatermarks(db,owner);
  if((watermarks.history??0)+1!==watermark)throw Error('History admission watermark differs.');
  const operationalWrites=rows.map(row=>({table:'project_history' as const,value:row.value as unknown as JsonValue,streamSequence:row.streamSequence,...(row.previous?{operation:'update' as const,expectedRowRevision:row.previous.rowRevision}:{operation:'insert' as const})}));
  const quote=await measureProspectiveRecoverability(db,owner,{now,operationalWrites,operationalWatermarksAfter:{...watermarks,history:watermark}});
  if(quote.boundaryRevision!==context.planningRevision)throw Error('History admission planning boundary differs.');
  if(!quote.measurement.allowed)throw new RecoverabilityCapacityError();
  const jobGrowth=await privateInsertGrowth(db,'workspace_job_intents',{user_id:owner,id:job.id,kind:job.kind,dedupe_key:job.dedupeKey,payload_json:canonical(job.payload),not_before:now,status:'pending',execution_epoch:job.executionEpoch,cancel_requested:0});
  const head=await db.prepare("SELECT revision FROM operational_stream_heads WHERE user_id=? AND stream_id='history'").bind(owner).first<{revision:number}>();
  const headGrowth=head?await privateUpdateGrowth(db,owner,'operational_stream_heads',"stream_id='history'",[],{revision:head.revision+1,last_sequence:watermark}):await privateInsertGrowth(db,'operational_stream_heads',{user_id:owner,stream_id:'history',revision:1,last_sequence:watermark});
  const capacity=await requirePrivateCapacity(db,owner,{growth:combinePrivateGrowth(jobGrowth,headGrowth)});
  return [...recoverabilityAssertions(db,owner,mutationId,quote,guard,guardBindings),db.prepare(`INSERT INTO workspace_assertions(user_id,mutation_id,valid) SELECT ?,?,CASE WHEN ${capacity.sql} THEN 1 ELSE 0 END WHERE ${guard}`).bind(owner,mutationId,...capacity.bindings,...guardBindings)];
 };
}
