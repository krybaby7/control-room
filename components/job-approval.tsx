'use client';
import {useEffect,useState} from 'react';
import type {WorkspaceCommand} from '@/lib/workspace-protocol';
import type {JobReadModel} from '@/lib/agents/read-model';
type JobRow=JobReadModel['jobs'][number];
export function JobApproval({job,disabled,onCommand,onDirtyChange,executionEnabled=false}:{job:JobRow;disabled:boolean;onCommand:(command:WorkspaceCommand)=>Promise<unknown>;onDirtyChange?:(dirty:boolean)=>void;executionEnabled?:boolean}){
 const [reviewed,setReviewed]=useState(false),[error,setError]=useState('');
 useEffect(()=>{onDirtyChange?.(reviewed);return()=>onDirtyChange?.(false);},[reviewed,onDirtyChange]);
 const candidate=job.approvalCandidate,eligible=executionEnabled&&job.status==='awaiting_approval'&&!job.record.historical&&candidate!==null;
 return <section aria-label="Job execution approval"><h3>Execution approval</h3><p>Approval authorizes one exact specification, device, runtime binding and finite budget. It does not accept a result or complete a task.</p>
 {!eligible?<p>Approval is unavailable. Install verified renewable private ingress, enable the exact device operation, repository and model, report fresh capability and configure a finite execution budget. Historical jobs cannot execute.</p>:<><p>Device {candidate.deviceId} · Candidate expires {candidate.expiresAt}</p><p>Specification digest {job.record.specSha256}</p><p>Capability digest {candidate.capabilityHash} · Binding digest {candidate.bindingHash} · Budget {candidate.budgetId}</p><details><summary>Review exact execution binding</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify(candidate.binding,null,2)}</pre></details><label className="check-card"><input type="checkbox" disabled={disabled} checked={reviewed} onChange={event=>setReviewed(event.target.checked)}/>I approve this exact device, runtime and bounded attempt</label></>}
 <button type="button" className="button primary" disabled={disabled||!eligible||!reviewed} onClick={()=>{if(!candidate)return;setError('');void onCommand({type:'jobs.approve',id:job.record.id,expectedOperationalRevision:job.operationalRevision,deviceId:candidate.deviceId,expectedCapabilityHash:candidate.capabilityHash,expectedBindingHash:candidate.bindingHash,budgetId:candidate.budgetId}).then(()=>setReviewed(false)).catch(reason=>setError(reason instanceof Error?reason.message:'Approval was not confirmed. Keep the original request.'));}}>Approve bounded attempt</button>{error&&<p role="alert">{error}</p>}
 </section>;
}
