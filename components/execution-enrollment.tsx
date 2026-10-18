'use client';
import {useContext,useEffect,useRef,useState} from 'react';
import {z} from 'zod';
import {deviceDisplaySchema,deviceEnrollmentScopesSchema,deviceIdSchema,type GenericDeviceEnrollmentInput} from '@/lib/devices/validation';
import {evidenceDateSchema} from '@/lib/evidence-validation';
import {SessionExpiredError,isConclusiveWorkspaceRejection} from '@/lib/workspace-client';
import {SessionExpiredContext} from './session-state';
import {EnrollmentNotStartedError,EnrollmentSecretUnavailableError,type RuntimeEnrollmentResult} from './runtime-view';
export interface ExecutionEnrollmentProps {
 disabled:boolean;
 onEnroll:(input:GenericDeviceEnrollmentInput)=>Promise<RuntimeEnrollmentResult>;
 onRefreshWorkspace?:()=>void;
 onDirtyChange?:(dirty:boolean)=>void;
 onPendingChange?:(pending:boolean)=>void;
}
const inputSchema=z.object({label:deviceDisplaySchema.shape.label,scopes:deviceEnrollmentScopesSchema}).strict();
const resultSchema=z.object({deviceId:deviceIdSchema,enrollmentId:deviceIdSchema,secret:z.string().min(16).max(4096),expiresAt:evidenceDateSchema}).strict();
/** Private enrollment only; this component never enables a local policy or approves work. */
export function ExecutionEnrollment({disabled,onEnroll,onRefreshWorkspace,onDirtyChange,onPendingChange}:ExecutionEnrollmentProps){
 const contextExpired=useContext(SessionExpiredContext),[expired,setExpired]=useState(false),[label,setLabel]=useState(''),[purpose,setPurpose]=useState(''),[consent,setConsent]=useState(false),[working,setWorking]=useState(false),[pending,setPending]=useState(false),[ticket,setTicket]=useState<RuntimeEnrollmentResult|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const life=useRef({active:true,epoch:0}),original=useRef<GenericDeviceEnrollmentInput|null>(null),operation=useRef(false),guard=useRef({dirty:false,pending:false}),secret=useRef<RuntimeEnrollmentResult|null>(null),callbacks=useRef({onDirtyChange,onPendingChange}),dirty=label.length>0||purpose!==''||consent||ticket!==null;
 useEffect(()=>{callbacks.current={onDirtyChange,onPendingChange};guard.current={dirty,pending:pending||working};onDirtyChange?.(dirty);onPendingChange?.(pending||working);},[dirty,pending,working,onDirtyChange,onPendingChange]);
 useEffect(()=>{const session=life.current;session.active=true;const expire=()=>{session.epoch++;original.current=null;secret.current=null;setTicket(null);setLabel('');setPurpose('');setConsent(false);setPending(false);setError('');setNotice('');setExpired(true);};const leave=(event:BeforeUnloadEvent)=>{if(guard.current.dirty||guard.current.pending||operation.current)event.preventDefault();};window.addEventListener('beforeunload',leave);window.addEventListener('control-room-session-expired',expire);return()=>{session.active=false;session.epoch++;original.current=null;secret.current=null;callbacks.current.onDirtyChange?.(false);callbacks.current.onPendingChange?.(false);window.removeEventListener('beforeunload',leave);window.removeEventListener('control-room-session-expired',expire);};},[]);
 async function enroll(){
  if(disabled||operation.current)return;let input=original.current;
  if(!input){if(!consent||!purpose){setError('Choose one purpose and explicitly consent before enrolling.');return;}const parsed=inputSchema.safeParse({label,scopes:purpose==='jobs'?['jobs:poll','jobs:report']:['evaluations:write']});if(!parsed.success){setError('Enter a valid device label and choose one enrollment purpose.');return;}input=parsed.data;original.current=input;}
  operation.current=true;setWorking(true);setPending(true);setError('');const epoch=life.current.epoch;
  try{const result=resultSchema.parse(await onEnroll(input));if(!life.current.active||epoch!==life.current.epoch)return;original.current=null;secret.current=result;setTicket(result);setPending(false);setLabel('');setPurpose('');setConsent(false);setNotice('Enrollment issued. Copy or hide the one-time secret; it is not saved in a draft.');onRefreshWorkspace?.();}
  catch(reason){if(life.current.active&&epoch===life.current.epoch){if(reason instanceof SessionExpiredError)window.dispatchEvent(new Event('control-room-session-expired'));else if(reason instanceof EnrollmentSecretUnavailableError){original.current=null;setPending(false);setLabel('');setPurpose('');setConsent(false);setError('The original enrollment committed, but its secret cannot be recovered. Review and revoke that device before explicitly creating a replacement.');onRefreshWorkspace?.();}else if(reason instanceof EnrollmentNotStartedError){original.current=null;setPending(false);setError('Enrollment was not submitted. Review the request before trying again.');}else if(isConclusiveWorkspaceRejection(reason)){original.current=null;setPending(false);setError('Enrollment was rejected. Review the device and workspace before trying again.');}else setError('Enrollment outcome is unconfirmed. Retry only the unchanged original request; no replacement has been created.');}}
  finally{operation.current=false;if(life.current.active&&epoch===life.current.epoch)setWorking(false);}
 }
 async function copy(){const value=secret.current;if(!value)return;const epoch=life.current.epoch;try{await navigator.clipboard.writeText(value.secret);if(life.current.active&&epoch===life.current.epoch&&secret.current===value){secret.current=null;setTicket(null);setNotice('Enrollment secret copied and hidden.');}}catch{if(life.current.active&&epoch===life.current.epoch)setError('Copy was unavailable. Copy the visible secret manually, then hide it.');}}
 if(contextExpired||expired)return null;
 return <section aria-label="Execution device enrollment" className="panel"><h2>Enroll an execution or evaluation device</h2>
 <p>Private ingress remains unavailable until independently verified. Enrollment does not enable a local execution policy, approve a job, authorize spending or establish a connection.</p>
 <form onSubmit={event=>{event.preventDefault();void enroll();}}><fieldset disabled={disabled||working||pending||ticket!==null}>
 <label>Execution device label<input required maxLength={200} value={label} onChange={event=>setLabel(event.target.value)}/></label>
 <label>Enrollment purpose<select required value={purpose} onChange={event=>{setPurpose(event.target.value);setConsent(false);}}><option value="">Choose a purpose</option><option value="jobs">Job polling and result reporting</option><option value="evaluations">Evaluation reporting only</option></select></label>
 <label><input type="checkbox" checked={consent} onChange={event=>setConsent(event.target.checked)}/>I authorize only the selected device reporting scopes. Local execution policy, job approval and budgets require separate explicit review.</label>
 <button className="button primary" disabled={!consent||!purpose}>Create scoped enrollment</button></fieldset>
 {pending&&<button type="button" className="button secondary" disabled={disabled||working} onClick={()=>void enroll()}>Retry original scoped enrollment</button>}</form>
 {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
 {ticket&&<section aria-label="Scoped one-time enrollment"><p>Device {ticket.deviceId} · Enrollment {ticket.enrollmentId} · Expires {ticket.expiresAt}</p><output aria-label="Scoped enrollment secret" style={{overflowWrap:'anywhere'}}>{ticket.secret}</output><button type="button" onClick={()=>void copy()}>Copy scoped enrollment secret once</button><button type="button" onClick={()=>{secret.current=null;setTicket(null);setNotice('Enrollment secret hidden. It cannot be recovered.');}}>Hide scoped enrollment secret</button></section>}
 </section>;
}
