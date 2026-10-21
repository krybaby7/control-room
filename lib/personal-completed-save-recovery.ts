import type {WorkspaceCommand} from './workspace-protocol.ts';
import {isConclusiveWorkspaceRejection} from './workspace-client.ts';
interface SaveStatus {hasResult:boolean;saving:boolean;savedLoaded:boolean;busy:boolean;pending:boolean}
export function canSavePersonalCompleted(status:SaveStatus,explicit=false){return status.hasResult&&!status.saving&&status.savedLoaded&&!status.busy&&(!status.pending||explicit);}
function freeze<T>(value:T):T{if(value!==null&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
/** Preserve the original owner save payload while its mutation outcome is uncertain. */
export class PersonalCompletedSaveRecovery {
 private commands=new Map<string,WorkspaceCommand>();
 private confirmed=new Set<string>();
 commandFor(requestId:string,create:()=>WorkspaceCommand){let command=this.commands.get(requestId);if(!command){command=freeze(structuredClone(create()));this.commands.set(requestId,command);}return command;}
 retainOriginal(requestId:string,command:WorkspaceCommand){this.commands.set(requestId,freeze(structuredClone(command)));this.confirmed.delete(requestId);}
 releaseRejected(requestId:string,error:unknown){if(!isConclusiveWorkspaceRejection(error))return false;this.commands.delete(requestId);this.confirmed.delete(requestId);return true;}
 pendingCommand(requestId:string){return this.confirmed.has(requestId)?null:this.commands.get(requestId)??null;}
 isConfirmed(requestId:string){return this.confirmed.has(requestId);}
 markConfirmed(requestId:string){this.confirmed.add(requestId);}
}
