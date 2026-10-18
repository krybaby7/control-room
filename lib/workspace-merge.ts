import type { Workspace } from './types.ts';
import { parsePlanningImport } from './workspace-codec.ts';
import { WorkspaceValidationError } from './workspace-validation.ts';
const collections=['projects','milestones','tasks','captures','activity'] as const;
export type PlanningCollection=typeof collections[number];
export type PlanningMergeSelection={[K in PlanningCollection]:string[]};
type PlanningRecord=Workspace[PlanningCollection][number];
export interface PlanningMergePreview {
  workspace:Workspace;
  conflicts:{collection:PlanningCollection;id:string;before:PlanningRecord;after:PlanningRecord}[];
  added:number;
  changed:number;
  sourceClaims:{collection:'tasks'|'milestones';id:string;record:PlanningRecord}[];
}
function fail(message:string):never { throw new WorkspaceValidationError(message); }
function same(left:unknown,right:unknown):boolean {
  if(left===right)return true;
  if(!left || !right || typeof left!=='object' || typeof right!=='object')return false;
  const a=Object.keys(left),b=Object.keys(right);
  return a.length===b.length && a.every(key=>Object.hasOwn(right,key) && same((left as Record<string,unknown>)[key],(right as Record<string,unknown>)[key]));
}
/** A pure review result; accepting this preview still requires an explicit owner command. */
export function previewPlanningMerge(current:Workspace,incoming:Workspace,selection:PlanningMergeSelection):PlanningMergePreview {
  const target=parsePlanningImport(current),source=parsePlanningImport(incoming);
  if(!selection || typeof selection!=='object' || Array.isArray(selection) || Object.keys(selection).length!==collections.length || Object.keys(selection).some(key=>!collections.includes(key as PlanningCollection)))fail('Merge selection must name every planning collection.');
  const preview:PlanningMergePreview={workspace:structuredClone(target),conflicts:[],added:0,changed:0,sourceClaims:[]};
  for(const collection of collections) {
    const selected=selection[collection];
    if(!Array.isArray(selected) || selected.some(id=>typeof id!=='string') || new Set(selected).size!==selected.length)fail(`Merge selection for ${collection} must contain unique IDs.`);
    const sourceRows=new Map<string,PlanningRecord>(source[collection].map(row=>[row.id,row]));
    const targetRows=preview.workspace[collection] as PlanningRecord[];
    for(const id of selected) {
      const from=sourceRows.get(id); if(!from)fail(`Merge selection refers to a missing ${collection} record.`);
      const index=targetRows.findIndex(row=>row.id===id),before=index<0?undefined:targetRows[index];
      let after=structuredClone(from);
      if(collection==='tasks') {
        const task=after as Workspace['tasks'][number],existing=before as Workspace['tasks'][number]|undefined;
        preview.sourceClaims.push({collection,id,record:structuredClone(from)});
        after={...task,status:existing?.status??'proposed',weekly:existing?.weekly??false,weeklyWeek:existing?.weeklyWeek??null,completedAt:existing?.completedAt??null,archivedFromStatus:existing?.archivedFromStatus??null};
      } else if(collection==='milestones') {
        const milestone=after as Workspace['milestones'][number],existing=before as Workspace['milestones'][number]|undefined;
        preview.sourceClaims.push({collection,id,record:structuredClone(from)});
        after={...milestone,status:existing?.status??(milestone.status==='achieved'?'planned':milestone.status)};
      }
      if(before) {
        // Show collisions against the source even where lifecycle authority is retained.
        if(!same(before,from))preview.conflicts.push({collection,id,before:structuredClone(before),after:structuredClone(after)});
        if(!same(before,after)){targetRows[index]=after;preview.changed++;}
      } else {targetRows.push(after);preview.added++;}
    }
  }
  // Includes cross-collection ID collisions, references, cycles, completion and both byte ceilings.
  preview.workspace=parsePlanningImport(preview.workspace);
  return preview;
}
