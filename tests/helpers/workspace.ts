import type { Project, Milestone, MilestoneInput, Task, TaskInput, Workspace } from '../../lib/types.ts';
import { createSeedWorkspace } from '../../lib/seed.ts';
export const FIXTURE_AT='2026-10-17T12:00:00.000Z';
export function projectFixture(patch:Partial<Project>={}):Project {
 return {id:'p1',name:'Project',description:'',goal:'',framing:'',includeTaskPlanInBriefings:false,personalRepositoryKeys:[],color:'orange',priority:'equal',repositories:[],archivedAt:null,...patch};
}
export function taskInputFixture(patch:Partial<TaskInput>={}):TaskInput {
 return {projectId:'p1',milestoneId:null,title:'Review acceptance criteria',notes:'',status:'todo',horizon:'now',priority:'normal',dueDate:null,weekly:false,dependsOn:[],blocker:'',sourceUrl:null,evidence:'',estimateMinutes:null,...patch};
}
export function taskFixture(id='task-1',patch:Partial<Task>={}):Task {
 const input=taskInputFixture(patch);
 return {...input,id,createdAt:FIXTURE_AT,updatedAt:FIXTURE_AT,completedAt:input.status==='done'?FIXTURE_AT:null,weeklyWeek:null,archivedFromStatus:input.status==='archived'?'todo':null,...patch};
}
export function milestoneInputFixture(patch:Partial<MilestoneInput>={}):MilestoneInput {
 return {projectId:'p1',title:'Accepted operation',description:'',acceptance:'A reproducible full cycle.',status:'planned',targetDate:null,evidence:'',...patch};
}
export function milestoneFixture(patch:Partial<Milestone>={}):Milestone {
 return {...milestoneInputFixture(patch),id:'milestone-1',updatedAt:FIXTURE_AT,archivedAt:null,sortKey:0,...patch};
}
export function workspaceFixture(patch:Partial<Workspace>={}):Workspace {
 return {schemaVersion:4,projects:[projectFixture()],milestones:[],tasks:[],captures:[],activity:[],...patch};
}
/** Historical wire fixtures deliberately omit fields introduced after their version.
 * Cast exists only so existing mutation-oriented regression builders can edit the raw data.
 */
export function legacyWorkspaceFixture(version:1|2|3,at=FIXTURE_AT):Workspace {
 return legacyPlanningFixture(createSeedWorkspace(at),version);
}
export function legacyPlanningFixture(workspace:Workspace,version:1|2|3):Workspace {
 const raw=JSON.parse(JSON.stringify(workspace)) as Record<string,unknown>;
 raw.schemaVersion=version;delete raw.areas;
 for(const project of raw.projects as Record<string,unknown>[]){delete project.archivedAt;delete project.framing;delete project.includeTaskPlanInBriefings;delete project.personalRepositoryKey;delete project.personalRepositoryKeys;}
 for(const milestone of raw.milestones as Record<string,unknown>[]){delete milestone.archivedAt;delete milestone.sortKey;}
 for(const task of raw.tasks as Record<string,unknown>[]){delete task.areaId;delete task.workType;delete task.estimateMinutes;if(version===1){delete task.weeklyWeek;delete task.archivedFromStatus;}}
 return raw as unknown as Workspace;
}
