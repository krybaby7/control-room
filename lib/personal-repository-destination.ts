/** Keep refreshes in their existing project while new folders start separately. */
export function repositoryDestination(repositoryKey:string,overrides:Readonly<Record<string,string>>,reports:ReadonlyArray<{projectId:string;report:{repository:{key:string}}}>,projects:ReadonlyArray<{id:string;archivedAt:string|null;personalRepositoryKey?:string|null;personalRepositoryKeys?:readonly string[]}>,savedLoaded=true,contextProjectId?:string):string|null{
 if(!savedLoaded)return null;
 const valid=(id:string)=>projects.some(project=>project.id===id&&!project.archivedAt);
 const mapped=projects.find(project=>(project.personalRepositoryKeys??(project.personalRepositoryKey?[project.personalRepositoryKey]:[])).includes(repositoryKey)&&!project.archivedAt);
 if(mapped)return mapped.id;
 if(projects.some(project=>(project.personalRepositoryKeys??(project.personalRepositoryKey?[project.personalRepositoryKey]:[])).includes(repositoryKey)&&project.archivedAt))return null;
 const override=overrides[repositoryKey];
 if(override==='new'||override&&valid(override))return override;
 const saved=reports.find(row=>row.report.repository.key===repositoryKey&&valid(row.projectId));
 return saved?.projectId??(contextProjectId&&valid(contextProjectId)?contextProjectId:'new');
}

/** Saved analysis destinations are suggestions; only project folder keys confer ownership. */
export function repositoryBinding<T extends {id:string;personalRepositoryKeys?:readonly string[];personalRepositoryKey?:string|null}>(key:string,projects:readonly T[]):T|null{
 return projects.find(project=>(project.personalRepositoryKeys??(project.personalRepositoryKey?[project.personalRepositoryKey]:[])).includes(key))??null;
}
