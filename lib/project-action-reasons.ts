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
