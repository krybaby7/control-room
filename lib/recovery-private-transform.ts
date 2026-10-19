import {PRIVATE_PROFILE_TABLES} from './private-profile.ts';
import {canonical} from './canonical-json.ts';
export type RecoveryPrivateScalar=string|number|null;
/** Trusted frozen native data only. Dispatch is revoked without rewriting history. */
export function recoveryPrivateTargetRow(table:typeof PRIVATE_PROFILE_TABLES[number],original:Record<string,RecoveryPrivateScalar>,now:string):Record<string,RecoveryPrivateScalar>{
 if(!(PRIVATE_PROFILE_TABLES as readonly string[]).includes(table)||!Number.isFinite(Date.parse(now)))throw new Error('Invalid closed recovery transformation.');
 const row={...original};
    if(table==='workspace_mutation_epochs'){row.status='retired';row.retired_at=row.retired_at??now;}
    if(table==='attachment_blob_namespaces')row.purpose='recovery-history';
    if(table==='attachment_archive_stages'&&(row.status==='preparing'||row.status==='verified'))row.status='failed';
    if(table==='job_approvals')row.revoked_at=row.revoked_at??now;
    if(table==='integration_jobs'){row.lease_token=null;row.lease_expires_at=null;row.lease_access_mode=null;row.lease_principal_ref=null;}
    if(table==='automation_runtime'){row.paused=1;row.principal_ref=null;}
    if(table==='source_sync_state')row.paused=1;
    if(table==='device_runtime')row.revoked_at=row.revoked_at??now;
    if(table==='device_sessions')row.retired_at=row.retired_at??now;
    if(table==='agent_budgets'){row.enabled=0;const payload=JSON.parse(String(row.payload_json));if(!payload||typeof payload!=='object'||Array.isArray(payload)||typeof payload.enabled!=='boolean')throw new Error('Budget configuration shape unavailable.');row.payload_json=canonical({...payload,enabled:false});}
    if(table==='workspace_job_intents'){
     if(row.status==='pending'||row.status==='awaiting_approval')row.status='cancelled';
     if(row.status==='running'){row.cancel_requested=1;if(row.kind!=='agent.execute')row.status='cancelled';}
    }
    if(table==='agent_job_state'){
     if(['leased','running','cancelling','reconcile_required'].includes(String(row.status))){
      if(!row.attempt_id)throw new Error('Active attempt identity unavailable.');
      row.status='reconcile_required';row.cancel_requested_at=row.cancel_requested_at??now;
     }else if(row.status==='queued'||row.status==='awaiting_approval')row.status='blocked';
    }

 return row;
}
