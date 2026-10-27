import {availableProjectFolders} from './project-action-reasons.ts';
interface FolderProject {id:string;archivedAt?:string|null;personalRepositoryKeys?:readonly string[];personalRepositoryKey?:string|null}
interface PickerState {repositories:readonly {key:string;name:string}[];jobs:readonly {id:string;status:string;error?:string}[]}
interface PickerOptions {
 projectId:string;requestId:string;signal:AbortSignal;retry?:boolean;attempts?:number;deadlineMs?:number;
 read:(signal:AbortSignal)=>Promise<PickerState>;send:(action:{action:'browse';requestId:string},signal:AbortSignal)=>Promise<unknown>;
 current:()=>{project:FolderProject;projects:readonly Pick<FolderProject,'personalRepositoryKeys'|'personalRepositoryKey'>[];saving?:boolean};save:(keys:string[],signal:AbortSignal)=>Promise<void>;
 wait?:(signal:AbortSignal)=>Promise<void>;
}
export type FolderPickerResult='added'|'existing'|'cancelled'|'pending'|'review';
const keys=(project:FolderProject)=>project.personalRepositoryKeys??(project.personalRepositoryKey?[project.personalRepositoryKey]:[]);
export function projectFolderEditCommand(projectId:string,folderKeys:readonly string[]){return {type:'project.edit' as const,id:projectId,patch:{personalRepositoryKeys:[...folderKeys]}};}
function pause(signal:AbortSignal){return new Promise<void>((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(signal.reason??new Error('Folder selection cancelled.'));};const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},3000);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});}
/** An owner picker request is bounded, abortable and can only attach one observed new key.
 * Recovered requests lack a trustworthy before snapshot and always require an explicit choice. */
export async function chooseProjectFolder(options:PickerOptions):Promise<FolderPickerResult>{
 const deadline=new AbortController(),signal=AbortSignal.any([options.signal,deadline.signal]);
 const timer=setTimeout(()=>deadline.abort(),options.deadlineMs??120000);
 try{
  signal.throwIfAborted();const before=await options.read(signal);signal.throwIfAborted();
  const known=new Set(before.repositories.map(row=>row.key));
  await options.send({action:'browse',requestId:options.requestId},signal);signal.throwIfAborted();
  for(let attempt=0;attempt<(options.attempts??40);attempt++){
   const after=await options.read(signal);signal.throwIfAborted();
   const job=after.jobs.find(row=>row.id===options.requestId);
   if(job&&job.status!=='queued'&&job.status!=='claimed'){
    if(job.status==='cancelled'||job.error==='cancelled')return 'cancelled';
    if(job.status!=='completed')throw new Error('Folder selection did not finish. Try choosing the folder again.');
    if(options.retry)return 'review';
    const added=after.repositories.filter(row=>!known.has(row.key));
    if(added.length>1)throw new Error('More than one new folder appeared. Choose the folder to add below.');
    if(!added.length)return 'existing';
    const current=options.current();
    if(current.project.id!==options.projectId||current.project.archivedAt||keys(current.project).length>=4||current.saving)throw new Error('The project changed while choosing a folder. Review its folders before adding another.');
    if(!availableProjectFolders(added,current.projects).length)throw new Error('That folder already belongs to a project. Choose another folder.');
    signal.throwIfAborted();await options.save([...keys(current.project),added[0].key],signal);signal.throwIfAborted();return 'added';
   }
   if(attempt+1<(options.attempts??40))await (options.wait??pause)(signal);
   signal.throwIfAborted();
  }
  return 'pending';
 }catch(error){if(deadline.signal.aborted&&!options.signal.aborted)return 'pending';throw error;}
 finally{clearTimeout(timer);}
}
