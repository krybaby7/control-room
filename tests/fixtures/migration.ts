import type { Workspace } from '../../lib/types.ts';
export const migrationSavedAt='2026-10-12T09:00:00.000Z';
/** Historical v1 wire fixture deliberately omits later metadata. Synthetic records only. */
export function migrationFixture():Workspace {
 return {schemaVersion:1,projects:[{id:'synthetic-project',name:'Synthetic project',description:'Migration rehearsal',goal:'Preserve IDs',color:'teal',priority:'equal',repositories:[]}],milestones:[],captures:[],activity:[],tasks:[{id:'synthetic-completed',projectId:'synthetic-project',milestoneId:null,title:'Archived prerequisite',notes:'عينة',status:'archived',horizon:'later',priority:'normal',dueDate:null,weekly:false,dependsOn:[],blocker:'',sourceUrl:null,evidence:'Synthetic historical verification',createdAt:migrationSavedAt,updatedAt:migrationSavedAt,completedAt:migrationSavedAt},{id:'synthetic-weekly',projectId:'synthetic-project',milestoneId:null,title:'Saved week',notes:'',status:'todo',horizon:'now',priority:'normal',dueDate:null,weekly:true,dependsOn:['synthetic-completed'],blocker:'',sourceUrl:null,evidence:'',createdAt:migrationSavedAt,updatedAt:migrationSavedAt,completedAt:null}]} as unknown as Workspace;
}
