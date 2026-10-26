import type {Workspace} from './types.ts';
/** Clone only explicit generated metadata; never infer progress or historical dates. */
export function migratePlanningV3ToV4(input:Workspace):Workspace {
 if(input.schemaVersion!==3)throw new Error('Expected planning schema version 3.');
 const source=structuredClone(input),positions=new Map<string,number>();
 return {...source,schemaVersion:4,projects:source.projects.map(project=>({...project,archivedAt:project.archivedAt??null})),milestones:source.milestones.map(milestone=>{const sortKey=positions.get(milestone.projectId)??0;positions.set(milestone.projectId,sortKey+1);return {...milestone,archivedAt:milestone.archivedAt??null,sortKey:milestone.sortKey??sortKey};}),tasks:source.tasks.map(task=>({...task,estimateMinutes:task.estimateMinutes??null}))};
}

export function migratePlanningV4ToV5(input:Workspace):Workspace {
 if(input.schemaVersion!==4)throw new Error('Expected planning schema version 4.');
 const source=structuredClone(input);return {...source,schemaVersion:5,areas:[],projects:source.projects.map(project=>({...project,framing:project.framing??'',includeTaskPlanInBriefings:project.includeTaskPlanInBriefings??false,personalRepositoryKey:project.personalRepositoryKey??null})),tasks:source.tasks.map(task=>({...task,areaId:null,workType:'other'}))};
}
