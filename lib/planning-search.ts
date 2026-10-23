import type { Workspace } from './types.ts';
import { entityHref, archivedEntity, type EntityTarget } from './entity-links.ts';
export interface PlanningSearchOptions {query?:string;entityTypes?:EntityTarget['kind'][];projectIds?:string[];statuses?:string[];includeArchived?:boolean;page?:number;}
export interface PlanningSearchItem {id:string;type:EntityTarget['kind'];title:string;projectId:string|null;project:string|null;snippet:string;archived:boolean;status:string|null;timestamp:string|null;timestampUnknown:boolean;href:string;}
const normalized=(value:string)=>value.normalize('NFKC').toLowerCase();
export function searchPlanning(workspace:Workspace,options:PlanningSearchOptions={}) {
 if(Object.keys(options).some(key=>!['query','entityTypes','projectIds','statuses','includeArchived','page'].includes(key)))throw new Error('Unknown search option.');
 const query=options.query??'';if(typeof query!=='string'||query.length>200)throw new Error('Search query exceeds 200 characters.');
 const tokens=normalized(query).trim().split(/\s+/).filter(Boolean);if(tokens.length>20)throw new Error('Search query exceeds 20 tokens.');
 const page=options.page??1;if(!Number.isSafeInteger(page)||page<1)throw new Error('Invalid search page.');
 for(const values of [options.entityTypes,options.projectIds,options.statuses])if(values&&(!Array.isArray(values)||values.some(value=>typeof value!=='string')||new Set(values).size!==values.length))throw new Error('Search filters must contain unique strings.');
 if(options.entityTypes?.some(kind=>!['project','milestone','task','capture'].includes(kind)))throw new Error('Invalid search entity type.');
 if(options.includeArchived!==undefined&&typeof options.includeArchived!=='boolean')throw new Error('Invalid archive filter.');
 const results:(PlanningSearchItem&{rank:number})[]=[];
 for(const type of ['project','milestone','task','capture'] as const){
  const rows=type==='project'?workspace.projects:type==='milestone'?workspace.milestones:type==='task'?workspace.tasks:workspace.captures;
  for(const row of rows){
   const record=row as unknown as Record<string,unknown>;const title=String(record.title??record.name??'');
   const projectId=type==='project'?row.id:typeof record.projectId==='string'?record.projectId:null;
   const status=typeof record.status==='string'?record.status:null,archived=archivedEntity(workspace,{kind:type,id:row.id});
   if(archived&&!options.includeArchived||options.entityTypes&&!options.entityTypes.includes(type)||options.projectIds&&!options.projectIds.includes(projectId??'')||options.statuses&&!options.statuses.includes(status??''))continue;
   const fields=type==='project'?['name','goal','description']:type==='milestone'?['title','acceptance','description','evidence']:type==='task'?['title','notes','evidence','sourceUrl']:['title','body','sourceUrl'];
   const body=fields.map(key=>typeof record[key]==='string'?record[key]:'').join('\n');const classification=type==='task'?[workspace.projects.find(project=>project.id===projectId)?.name??'',workspace.areas?.find(area=>area.id===record.areaId&&area.projectId===projectId)?.name??'Unclassified',String(record.workType??'other')].join(' '):'';const haystack=normalized(body+'\n'+classification);if(!tokens.every(token=>haystack.includes(token)))continue;
   const rawTime=record.updatedAt??record.createdAt;const timestamp=typeof rawTime==='string'&&Number.isFinite(Date.parse(rawTime))?rawTime:null;
   const rank=tokens.filter(token=>normalized(title).includes(token)).length;
   results.push({id:row.id,type,title,projectId,project:workspace.projects.find(project=>project.id===projectId)?.name??null,snippet:body.slice(0,240),archived,status,timestamp,timestampUnknown:timestamp===null,href:entityHref({kind:type,id:row.id}),rank});
  }
 }
 results.sort((a,b)=>b.rank-a.rank||(b.timestamp?Date.parse(b.timestamp):-Infinity)-(a.timestamp?Date.parse(a.timestamp):-Infinity)||(a.id<b.id?-1:a.id>b.id?1:0)||a.type.localeCompare(b.type));
 const total=results.length;return {items:results.slice((page-1)*50,page*50).map(({rank,...item})=>{void rank;return item;}),total,page,pageSize:50 as const,pages:Math.ceil(total/50)};
}
