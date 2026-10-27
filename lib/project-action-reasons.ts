/** Shared owner-facing reasons. Conditions apply only to the action they can block. */
export function firstDisabledReason(...reasons: Array<string | false | null | undefined>):string|null {
 return reasons.find((reason):reason is string=>typeof reason==='string'&&reason.length>0)??null;
}
export type ProjectAction='add-folder'|'remove-folder'|'choose-folder'|'brief'|'navigate-folders';
export interface ProjectActionState {
 archived?:boolean;saving?:boolean;folderCount?:number;online?:boolean;choosingFolder?:boolean;
 assistantReady?:boolean;assistant?:'codex'|'claude';briefingRunning?:boolean;folderSelected?:boolean;
}
export function projectActionDisabledReason(action:ProjectAction,state:ProjectActionState):string|null {
 if(action==='navigate-folders')return null;
 const adding=action==='add-folder'||action==='choose-folder',pc=action==='choose-folder'||action==='brief';
 return firstDisabledReason(
  state.archived&&'Restore this project to change its folders.',
  state.saving&&'Saving… wait a moment.',
  adding&&(state.folderCount??0)>=4&&'A project can have up to four folders.',
  pc&&state.online===false&&'Your PC is offline. Open the Control Room PC app on your PC.',
  pc&&state.choosingFolder&&'Your PC is choosing a folder. Finish or cancel the folder window on your PC.',
  action==='add-folder'&&state.folderSelected===false&&'Choose a folder to add to this project.',
  action==='brief'&&state.folderCount===0&&'Add a folder first.',
  action==='brief'&&state.briefingRunning&&'A briefing is already running for this project.',
  action==='brief'&&state.assistantReady===false&&`${state.assistant==='claude'?'Claude Code':'Codex'} isn’t ready on your PC. Open ${state.assistant==='claude'?'Claude Code':'Codex'} on your PC and sign in.`,
 );
}
export function availableProjectFolders<T extends {key:string}>(repositories:readonly T[],projects:readonly {personalRepositoryKeys?:readonly string[];personalRepositoryKey?:string|null}[]):T[]{
 const owned=new Set(projects.flatMap(project=>project.personalRepositoryKeys??(project.personalRepositoryKey?[project.personalRepositoryKey]:[])));
 return repositories.filter(repository=>!owned.has(repository.key));
}

/** Last observed PC poll; connectivity alone does not establish briefing support. */
export interface PersonalCompanionObservation {protocol:number|null;kinds:readonly string[];legacy:boolean;release?:string;lastSeenAt:string|null}
export function personalCompanionStatus(companion?:PersonalCompanionObservation|null):{state:'current'|'outdated'|'unknown';label:string;detail:string}{
 if(!companion)return {state:'unknown',label:'PC app: not checked yet',detail:'Refresh the connection after the PC app checks in.'};
 const current=!companion.legacy&&companion.protocol!==null&&companion.protocol>=1&&companion.kinds.includes('brief');
 const details=[companion.protocol!==null?`Check-in version ${companion.protocol}.`:null,companion.release?`Release ${companion.release}.`:null,companion.legacy?'The last check-in came from an older PC app.':`The last check-in ${current?'supports':'does not support'} project briefings.`,companion.lastSeenAt?`Last check-in: ${companion.lastSeenAt}.`:null];
 return {state:current?'current':'outdated',label:current?'PC app: current':'PC app: out of date — update it',detail:details.filter(Boolean).join(' ')};
}
export function personalJobFailureReason(error:string|undefined,kind:string):string|null{
 if(error!=='companion_outdated'&&error!=='unsupported')return null;
 const action=kind==='brief'?'run this briefing':kind==='browse'?'choose a folder':kind==='analyze'?'analyze this folder':'run this request';
 return `Your Control Room PC app is out of date, so it couldn't ${action}. Close the old PC app; if it keeps happening, update the PC app.`;
}
