import type {BriefingView,ProjectTile} from '@/lib/dashboard/model';
import {firstDisabledReason,projectActionDisabledReason} from '@/lib/project-action-reasons';

/** The assistant a one-click briefing uses: the keep-current choice, else the last briefing's, else the first ready one. */
export function defaultBriefingProvider(view:BriefingView):'codex'|'claude'{return view.policy?.provider??view.report?.run.provider??(view.providers.find(row=>row.ready)?.id??'codex');}
/** Why a briefing cannot be requested right now, in the owner's words; null when it can. */
export function briefRequestReason(tile:ProjectTile,state:{working:boolean;busy:boolean;choosingFolder?:boolean;provider:'codex'|'claude'}):string|null{
 const view=tile.briefing,ready=view.providers.find(row=>row.id===state.provider)?.ready??false;
 return firstDisabledReason(projectActionDisabledReason('brief',{archived:!!tile.project.archivedAt,saving:state.working||state.busy,folderCount:view.repositories.length,online:view.connector==='online',choosingFolder:state.choosingFolder,briefingRunning:!!view.activeJob,assistantReady:ready,assistant:state.provider}),!view.repositoryKey&&'The linked folder is unavailable on your PC. Add it again from the project page.',!view.canRequest&&view.requestHint);
}
