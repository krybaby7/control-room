import {parseOwnerAction,type PersonalOwnerAction} from '../shared/personal-repository.mjs';
type EnqueueAction=Extract<PersonalOwnerAction,{action:'browse'|'analyze'|'brief'}>;
type RecoveryStorage=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
interface ObservedJob {id:string;kind:string;projectId?:string;repositoryKey?:string;provider?:string}
const key='control-room-personal-original-request-v1';
function enqueue(input:unknown):EnqueueAction{const action=parseOwnerAction(input);if(action.action!=='browse'&&action.action!=='analyze'&&action.action!=='brief')throw new Error('Only an original folder, analysis or briefing request can be retained.');return Object.freeze(action);}
/** Browser recovery is passive. Only the owner's Retry original request click resends an intent. */
export class PersonalRequestRecovery {
 private storage:RecoveryStorage;
 pending:EnqueueAction|null=null;
 constructor(storage:RecoveryStorage){this.storage=storage;const raw=storage.getItem(key);if(raw!==null){try{this.pending=enqueue(JSON.parse(raw));}catch{storage.removeItem(key);}}}
 begin(input:unknown){if(this.pending)throw new Error('Confirm the original request before starting another.');const action=enqueue(input);this.storage.setItem(key,JSON.stringify(action));this.pending=action;}
 reject(input:unknown,definitiveRejection:unknown){if(definitiveRejection!==true||!this.pending)return false;const action=enqueue(input),original=this.pending;if(action.action!==original.action||action.requestId!==original.requestId||action.action!=='browse'&&(original.action==='browse'||action.projectId!==original.projectId||action.repositoryKey!==original.repositoryKey||action.provider!==original.provider))return false;this.storage.removeItem(key);this.pending=null;return true;}
 observe(jobs:ReadonlyArray<ObservedJob>){const action=this.pending;if(!action)return;const job=jobs.find(job=>job.id===action.requestId);if(!job)return;if(job.kind!==action.action||action.action!=='browse'&&(job.projectId!==action.projectId||job.repositoryKey!==action.repositoryKey||job.provider!==action.provider))throw new Error('The original request binding differs from the recorded server request.');this.storage.removeItem(key);this.pending=null;}
}
