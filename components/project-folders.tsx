'use client';
import {useEffect,useId,useRef,useState,type ReactNode} from 'react';
import type {Command,Project} from '@/lib/types';
import type {PersonalConnectorView} from '@/lib/dashboard/contracts';
import {availableProjectFolders,firstDisabledReason,projectActionDisabledReason,personalCompanionStatus,personalJobFailureReason,type PersonalCompanionObservation} from '@/lib/project-action-reasons';
import {briefingRequest,loadSavedProjectBriefings,PersonalActionError,SavedBriefingReadError,sendPersonalAction} from '@/lib/project-briefing-client';
import {PersonalRequestRecovery} from '@/lib/personal-repository-request-recovery';
import {chooseProjectFolder,projectFolderEditCommand,type FolderPickerResult} from '@/lib/project-folder-picker';
import {SessionExpiredError} from '@/lib/workspace-client';
import {restoreProjectAssistant} from '@/lib/project-assistant-preference';

const folderKeys=(project:Project)=>project.personalRepositoryKeys??(project.personalRepositoryKey?[project.personalRepositoryKey]:[]);
const active=(job:{status:string})=>job.status==='queued'||job.status==='claimed';

export function ProjectFolderConnection({connector,projectId}:{connector:{companion?:PersonalCompanionObservation|null;jobs:readonly {id:string;kind:string;projectId?:string;status:string;error?:string}[]}|null;projectId:string}){
 const status=personalCompanionStatus(connector?.companion),latest=connector?.jobs.filter(job=>job.kind==='brief'&&job.projectId===projectId).at(-1),failure=latest?.status==='failed'?personalJobFailureReason(latest.error,latest.kind):null;
 return <div><p role="status">{status.label}</p><details><summary>PC app details</summary><p className="field-hint">{status.detail}</p></details>{failure&&<p role="alert">{failure}</p>}</div>;
}

export function ProjectFolderList({keys,repositories,busy,archived=false,onAdd,onRemove,children}:{keys:readonly string[];repositories:readonly {key:string;name:string}[];busy:boolean;archived?:boolean;onAdd?:()=>void;onRemove?:(key:string)=>void;children?:ReactNode}){
 const id=useId(),addReason=projectActionDisabledReason('add-folder',{saving:busy,folderCount:keys.length}),removeReason=projectActionDisabledReason('remove-folder',{saving:busy});
 return <section id="project-folders" className="panel data-panel" aria-label="Project folders">
  <div className="section-heading"><h2>Folders on your PC</h2>{onAdd&&!archived&&<button type="button" className="button secondary" disabled={!!addReason} aria-describedby={addReason?`${id}-add`:undefined} onClick={onAdd}>Add a folder from this PC</button>}</div>
  {addReason&&!archived&&<p id={`${id}-add`} className="field-hint">{addReason}</p>}
  {keys.length?<><ul>{keys.map((key,index)=>{const name=repositories.find(row=>row.key===key)?.name??`Folder ${index+1} · name unavailable`;return <li key={key}>{name} {onRemove&&!archived&&<button type="button" className="text-button" aria-label={`Remove ${name} from project`} disabled={!!removeReason} aria-describedby={removeReason?`${id}-remove`:undefined} onClick={()=>onRemove(key)}>Remove</button>}</li>;})}</ul><p className="field-hint">One briefing covers all these folders.</p></>:<p className="field-hint">Add up to four folders to brief this project.</p>}
  {removeReason&&!archived&&<p id={`${id}-remove`} className="field-hint">{removeReason}</p>}
  {archived?<p className="field-hint">Restore this project to change its folders.</p>:<p className="field-hint">Removing a folder keeps it registered on your PC and preserves saved briefings and technical analyses.</p>}
  {children}
 </section>;
}

export function ProjectFolders({project,projects,busy,onCommand,onHome}:{project:Project;projects:readonly Project[];busy:boolean;onCommand?:(command:Command)=>Promise<void>;onHome?:()=>void}){
 const id=useId(),[connector,setConnector]=useState<PersonalConnectorView|null>(null),[chooser,setChooser]=useState(false),[selected,setSelected]=useState(''),[working,setWorking]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[requested,setRequested]=useState(false),[provider,setProvider]=useState<'codex'|'claude'>('codex');
 const [recoveryReady,setRecoveryReady]=useState(false),[original,setOriginal]=useState<PersonalRequestRecovery['pending']>(null),[confirmationRequired,setConfirmationRequired]=useState(false);
 const recovery=useRef<PersonalRequestRecovery|null>(null),controller=useRef<AbortController|null>(null),flight=useRef(false),providerPicked=useRef(false),latest=useRef({project,projects,busy,onCommand});latest.current={project,projects,busy,onCommand};
 function expire(cause:unknown,signal?:AbortSignal){if(cause instanceof SessionExpiredError||cause instanceof PersonalActionError&&cause.status===401||cause instanceof SavedBriefingReadError&&cause.reason==='session'){window.dispatchEvent(new Event('control-room-session-expired'));const current=controller.current;if(current&&current.signal===signal)current.abort();return true;}return false;}
 const keys=folderKeys(project),archived=!!project.archivedAt,available=availableProjectFolders(connector?.repositories??[],projects);
 useEffect(()=>{
  const abort=new AbortController();controller.current=abort;
  if(window.location.hash==='#project-folders')document.getElementById('project-folders')?.scrollIntoView({behavior:'smooth',block:'start'});
  try{recovery.current=new PersonalRequestRecovery(sessionStorage);setOriginal(recovery.current.pending);setRecoveryReady(true);}catch{setError('Browser request recovery is unavailable. Allow session storage and reload before requesting PC actions.');}
  void import('@/lib/dashboard/feed').then(({readConnectorFeed})=>readConnectorFeed({signal:abort.signal})).then(value=>{if(abort.signal.aborted)return;setConnector(value);void restoreProjectAssistant({projectId:project.id,connector:value,signal:abort.signal,hasOwnerChoice:()=>providerPicked.current,readSaved:async signal=>(await loadSavedProjectBriefings({projectId:project.id,signal,timeoutMs:15000})).briefings,apply:setProvider}).catch(cause=>{expire(cause,abort.signal);});recovery.current?.observe(value.jobs);setOriginal(recovery.current?.pending??null);}).catch(cause=>{if(!expire(cause,abort.signal)&&!abort.signal.aborted)setError(cause instanceof Error?cause.message:'Your PC connection could not be checked.');});
  return()=>abort.abort();
 },[project.id]);
 const mutationReason=firstDisabledReason(projectActionDisabledReason('remove-folder',{archived,saving:busy||working}),!onCommand&&'Project saving is unavailable. Reload and try again.');
 const pcReason=firstDisabledReason(!recoveryReady&&'Request recovery is preparing. Try again in a moment.',!!original&&'Confirm the original PC request before starting another.');
 const choosing=connector?.jobs.some(job=>job.kind==='browse'&&active(job))??false,briefingRunning=connector?.jobs.some(job=>job.kind==='brief'&&job.projectId===project.id&&active(job))??false;
 const ready=connector?.providers[provider].ready??false;
 const browseReason=firstDisabledReason(projectActionDisabledReason('choose-folder',{archived,saving:busy||working,folderCount:keys.length,online:connector?.online??false,choosingFolder:choosing}),pcReason);
 const confirmReason=firstDisabledReason(projectActionDisabledReason('add-folder',{archived,saving:busy||working,folderCount:keys.length,folderSelected:!!selected&&selected!=='__browse__'}),!!selected&&!available.some(row=>row.key===selected)&&'That folder already belongs to a project. Choose another folder.');
 const briefReason=firstDisabledReason(projectActionDisabledReason('brief',{archived,saving:busy||working,folderCount:keys.length,online:connector?.online??false,choosingFolder:choosing,assistantReady:ready,assistant:provider,briefingRunning}),pcReason);
 async function readConnection(signal=controller.current?.signal){signal?.throwIfAborted();try{const {readConnectorFeed}=await import('@/lib/dashboard/feed');const value=await readConnectorFeed({signal});signal?.throwIfAborted();setConnector(value);recovery.current?.observe(value.jobs);setOriginal(recovery.current?.pending??null);return value;}catch(cause){expire(cause,signal);throw cause;}}
 async function saveKeys(next:string[],signal=controller.current?.signal){signal?.throwIfAborted();if(latest.current.project.id!==project.id)throw new Error('The selected project changed.');if(!latest.current.onCommand)throw new Error('Project saving is unavailable.');await latest.current.onCommand(projectFolderEditCommand(project.id,next));signal?.throwIfAborted();}
 async function remove(key:string){if(flight.current||mutationReason)return;const signal=controller.current?.signal;flight.current=true;setWorking(true);setError('');try{await saveKeys(folderKeys(latest.current.project).filter(value=>value!==key),signal);setNotice(`Removed ${connector?.repositories.find(row=>row.key===key)?.name??'Folder'} from ${project.name}.`);}catch(cause){if(!signal?.aborted)setError(cause instanceof Error?cause.message:'The folder change could not be saved.');}finally{flight.current=false;if(!signal?.aborted)setWorking(false);}}
 async function addExisting(key:string,signal:AbortSignal){const current=latest.current;if(projectActionDisabledReason('add-folder',{archived:!!current.project.archivedAt,saving:current.busy,folderCount:folderKeys(current.project).length,folderSelected:!!key}))return;if(!availableProjectFolders(connector?.repositories??[],current.projects).some(row=>row.key===key))throw new Error('That folder already belongs to a project. Choose another folder.');await saveKeys([...folderKeys(current.project),key],signal);setChooser(false);setSelected('');setConfirmationRequired(false);setNotice('Folder added. One briefing covers all folders in this project.');}
 function picked(result:FolderPickerResult){if(typeof result==='object'){setSelected(result.folderKey);setConfirmationRequired(true);setChooser(true);setNotice('');return;}setSelected('');setConfirmationRequired(false);if(result==='added'){setChooser(false);setNotice('Folder added. One briefing covers all folders in this project.');}else setNotice(result==='cancelled'?'No folder was chosen.':result==='existing'?'That folder is already on this PC. Choose it from the folder list below.':result==='review'?'Folder selection finished. Choose the folder below to add it to this project.':'Your PC is still choosing a folder. Refresh the connection to check its progress; do not start another selection.');}
 async function browse(requestId:string,signal:AbortSignal,retry=false){return chooseProjectFolder({projectId:project.id,requestId,signal,retry,read:readConnection,send:(action,operationSignal)=>send(action,retry,operationSignal),current:()=>({...latest.current,saving:latest.current.busy}),save:saveKeys});}
 async function send(action:NonNullable<PersonalRequestRecovery['pending']>,retry=false,signal=controller.current?.signal){
  if(!retry){if(!recovery.current)throw new Error('Request recovery is unavailable.');recovery.current.begin(action);setOriginal(recovery.current.pending);}
  signal?.throwIfAborted();try{await sendPersonalAction(action,{signal});signal?.throwIfAborted();}catch(cause){expire(cause,signal);if(cause instanceof PersonalActionError&&recovery.current?.reject(action,cause.definitive))setOriginal(null);throw cause;}
 }
 async function add(selection=selected){const signal=controller.current?.signal;if(!signal||flight.current||projectActionDisabledReason(selection==='__browse__'?'choose-folder':'add-folder',{archived,saving:busy||working,folderCount:keys.length,online:connector?.online??false,choosingFolder:choosing,folderSelected:!!selection})||(selection==='__browse__'&&pcReason))return;flight.current=true;setWorking(true);setError('');setNotice('');try{if(selection==='__browse__')picked(await browse(crypto.randomUUID(),signal));else await addExisting(selection,signal);}catch(cause){if(!signal.aborted)setError(cause instanceof Error?cause.message:'The folder request could not be confirmed.');}finally{flight.current=false;if(!signal.aborted)setWorking(false);}}
 async function brief(){const signal=controller.current?.signal;if(!signal||flight.current||briefReason)return;providerPicked.current=true;flight.current=true;setWorking(true);setError('');try{await send(briefingRequest(project.id,keys[0],provider),false,signal);await readConnection(signal);setRequested(true);setNotice('Briefing requested. You can read it at the top of this page and on Home when it is ready.');}catch(cause){if(!signal.aborted)setError(cause instanceof Error?cause.message:'The briefing request could not be confirmed.');}finally{flight.current=false;if(!signal.aborted)setWorking(false);}}
 async function retry(){const signal=controller.current?.signal;if(!signal||flight.current||!original||busy)return;flight.current=true;setWorking(true);setError('');try{if(original.action==='browse')picked(await browse(original.requestId,signal,true));else{await send(original,true,signal);await readConnection(signal);setNotice('Original PC request confirmed.');}}catch(cause){if(!signal.aborted)setError(cause instanceof Error?cause.message:'The original request is still unconfirmed.');}finally{flight.current=false;if(!signal.aborted)setWorking(false);}}
 return <ProjectFolderList keys={keys} repositories={connector?.repositories??[]} busy={busy||working} archived={archived} onAdd={()=>setChooser(true)} onRemove={key=>void remove(key)}>
  <ProjectFolderConnection connector={connector} projectId={project.id}/>
  {!archived&&<div className="panel data-panel" aria-label="Folder and briefing actions">
   {chooser&&<div>
    {confirmationRequired&&<p role="status">Your PC added a folder while another folder window was open. Check the folder below and add it.</p>}
    <label className="field"><span className="field-label">Folder to add</span><select aria-label="Folder to add" value={selected} onChange={event=>{const key=event.target.value;setSelected(key);if(key==='__browse__'){setConfirmationRequired(false);void add(key);}else if(key&&!confirmationRequired)void add(key);}} disabled={working} aria-describedby={working?`${id}-working`:browseReason?`${id}-browse`:undefined}><option value="">Choose a folder</option>{available.map(row=><option key={row.key} value={row.key}>{row.name}</option>)}<option value="__browse__" disabled={!!browseReason} aria-describedby={browseReason?`${id}-browse`:undefined}>Choose another folder on this PC…</option></select></label>
    {confirmationRequired&&<><button type="button" className="button secondary" disabled={!!confirmReason} aria-describedby={confirmReason?`${id}-confirm`:undefined} onClick={()=>void add()}>Add folder</button>{confirmReason&&<p id={`${id}-confirm`} className="field-hint">{confirmReason}</p>}</>}
    <button type="button" className="text-button" disabled={working} aria-describedby={working?`${id}-working`:undefined} onClick={()=>{setChooser(false);setSelected('');setConfirmationRequired(false);setNotice('');}}>Cancel</button>
    {browseReason&&<p id={`${id}-browse`} className="field-hint">{browseReason}</p>}<p className="field-hint">Only folders that do not belong to another active or archived project are listed.</p>
   </div>}
   <div className="data-actions"><label className="field"><span className="field-label">Assistant for this briefing</span><select aria-label="Assistant for this briefing" value={provider} disabled={working} aria-describedby={working?`${id}-working`:undefined} onChange={event=>{providerPicked.current=true;setProvider(event.target.value as 'codex'|'claude');}}><option value="codex">Codex</option><option value="claude">Claude Code</option></select></label><button type="button" className="button secondary" disabled={!!briefReason} aria-describedby={briefReason?`${id}-brief`:undefined} onClick={()=>void brief()}>Brief this project</button></div>{briefReason&&<p id={`${id}-brief`} className="field-hint">{briefReason}</p>}
   {working&&<p id={`${id}-working`} className="field-hint">Wait for the current request to finish.</p>}
   <button type="button" className="text-button" disabled={working} aria-describedby={working?`${id}-working`:undefined} onClick={()=>void readConnection().catch(cause=>setError(cause instanceof Error?cause.message:'Your PC connection could not be checked.'))}>Refresh connection</button>
   {original&&<div role="status"><p>The original PC request is unconfirmed. Refresh the connection or retry this exact request before starting another.</p><button type="button" className="button secondary" disabled={working||busy} aria-describedby={working?`${id}-working`:busy?`${id}-saving`:undefined} onClick={()=>void retry()}>Retry original request</button>{busy&&<p id={`${id}-saving`} className="field-hint">Saving… wait a moment.</p>}</div>}
  </div>}
  {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}{requested&&onHome&&<>
   {' '}
   {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- The shell callback preserves pending-change navigation guards. */}
   <a href="/?view=home" onClick={event=>{event.preventDefault();onHome();}}>Home</a>
  </>}</p>}
 </ProjectFolderList>;
}
