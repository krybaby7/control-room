'use client';
import {useEffect,useState} from 'react';
import {readConnectorFeed} from '@/lib/dashboard/feed';
import type {Project} from '@/lib/types';

export function ProjectFolderList({keys,repositories,busy,onAdd}:{keys:readonly string[];repositories:readonly {key:string;name:string}[];busy:boolean;onAdd?:()=>void}){
 return <section className="panel data-panel" aria-label="Project folders"><div className="section-heading"><h2>Folders on this PC</h2>{onAdd&&<button type="button" className="button secondary" disabled={busy||keys.length>=4} onClick={onAdd}>Add folder</button>}</div>{keys.length?<><ul>{keys.map((key,index)=><li key={key}>{repositories.find(row=>row.key===key)?.name??`Folder ${index+1} · name unavailable`}</li>)}</ul><p className="field-hint">One briefing covers all these folders.</p></>:<p className="field-hint">Add up to four folders to brief this project.</p>}</section>;
}
export function ProjectFolders({project,busy,onAdd}:{project:Project;busy:boolean;onAdd?:()=>void}){
 const [repositories,setRepositories]=useState<{key:string;name:string}[]>([]);
 useEffect(()=>{const controller=new AbortController();void readConnectorFeed({signal:controller.signal}).then(value=>{if(!controller.signal.aborted)setRepositories(value.repositories);}).catch(()=>{});return()=>controller.abort();},[]);
 return <ProjectFolderList keys={project.personalRepositoryKeys??[]} repositories={repositories} busy={busy||!!project.archivedAt} onAdd={onAdd}/>;
}
