import type { Workspace } from './types.ts';
export type EntityTarget={kind:'project'|'milestone'|'task'|'capture';id:string};
export function entityHref(target:EntityTarget):string {
 if(!['project','milestone','task','capture'].includes(target.kind)||typeof target.id!=='string'||!target.id||target.id.length>128)throw new Error('Invalid entity target.');
 const query=new URLSearchParams({view:target.kind==='capture'?'inbox':'projects',entity:target.kind,id:target.id});return `/?${query}`;
}
export function archivedEntity(workspace:Workspace,target:EntityTarget):boolean {
 const collection=target.kind==='project'?workspace.projects:target.kind==='milestone'?workspace.milestones:target.kind==='task'?workspace.tasks:workspace.captures;
 const row=collection.find(row=>row.id===target.id);if(!row)return false;
 const own=(row as unknown as {archivedAt?:string|null;status?:string});
 if(own.archivedAt||own.status==='archived')return true;
 if('projectId' in row&&row.projectId&&workspace.projects.some(project=>project.id===row.projectId&&Boolean((project as unknown as {archivedAt?:string|null}).archivedAt)))return true;
 return target.kind==='task'&&'milestoneId' in row&&Boolean(row.milestoneId&&workspace.milestones.some(m=>m.id===row.milestoneId&&Boolean((m as unknown as {archivedAt?:string|null}).archivedAt)));
}
export function parseEntityLink(input:string|URLSearchParams,workspace:Workspace):{status:'available';target:EntityTarget;archived:boolean}|{status:'unavailable'} {
 let params:URLSearchParams;
 try{params=input instanceof URLSearchParams?input:input.startsWith('?')?new URLSearchParams(input):new URL(input,'https://local.invalid').searchParams;}catch{return {status:'unavailable'};}
 if(['view','entity','id'].some(key=>params.getAll(key).length!==1))return {status:'unavailable'};
 const kind=params.get('entity'),id=params.get('id'),view=params.get('view');
 if(!kind||!['project','milestone','task','capture'].includes(kind)||!id||id.length>128||view!==(kind==='capture'?'inbox':'projects'))return {status:'unavailable'};
 const target={kind:kind as EntityTarget['kind'],id};
 const rows=kind==='project'?workspace.projects:kind==='milestone'?workspace.milestones:kind==='task'?workspace.tasks:workspace.captures;
 return rows.some(row=>row.id===id)?{status:'available',target,archived:archivedEntity(workspace,target)}:{status:'unavailable'};
}
