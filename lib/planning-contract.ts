import type {Project,TaskInput,Workspace} from './types.ts';
export interface ProjectInput {name:string;description:string;goal:string;framing?:string;includeTaskPlanInBriefings?:boolean;personalRepositoryKey?:string|null;color:Project['color'];repositories:Project['repositories'];}
export type BulkTaskPatch=Partial<Pick<TaskInput,'status'|'priority'|'horizon'|'dueDate'|'milestoneId'|'areaId'|'workType'>>;
export type PlanningWorkflowCommand=
 |{type:'project.create';project:ProjectInput}|{type:'project.edit';id:string;patch:Partial<ProjectInput>}
 |{type:'project.archive'|'project.restore';id:string}|{type:'project.delete';id:string;impactToken:string}
 |{type:'milestone.archive'|'milestone.restore';id:string}|{type:'milestone.delete';id:string;impactToken:string}
 |{type:'milestone.reorder';projectId:string;orderedIds:string[]}
 |{type:'task.move';ids:string[];projectId:string;milestoneId:string|null;areaId?:string|null;workType?:import('./types.ts').WorkType}
 |{type:'task.bulk';ids:string[];patch:BulkTaskPatch}
 |{type:'capture.bulk';ids:string[];patch:{projectId?:string|null;status?:'inbox'|'filed'|'archived'}}
 |{type:'capture.bulkConvert';items:Array<{id:string;projectId:string;milestoneId:string|null;horizon:'now'|'next'|'later';areaId?:string|null;workType?:import('./types.ts').WorkType}>};
export interface MoveImpact {taskIds:string[];previousProjectIds:string[];targetProjectId:string;crossProjectEdges:Array<{from:string;to:string}>;captureIds:string[];}
export interface WorkflowContext {now:string;newId:()=>string;}
export interface WorkflowResult {workspace:Workspace;impact:MoveImpact|null;}
