/** Keep refreshes in their existing project while new folders start separately. */
export function repositoryDestination(repositoryKey:string,overrides:Readonly<Record<string,string>>,reports:ReadonlyArray<{projectId:string;report:{repository:{key:string}}}>,projects:ReadonlyArray<{id:string;archivedAt:string|null}>,savedLoaded=true,contextProjectId?:string):string|null{
 if(!savedLoaded)return null;
 const valid=(id:string)=>projects.some(project=>project.id===id&&!project.archivedAt);
 const override=overrides[repositoryKey];
 if(override==='new'||override&&valid(override))return override;
 const saved=reports.find(row=>row.report.repository.key===repositoryKey&&valid(row.projectId));
 return saved?.projectId??(contextProjectId&&valid(contextProjectId)?contextProjectId:'new');
}
