'use client';
import {useId,type ReactNode} from 'react';
import {Plus} from 'lucide-react';
import type {Project,Workspace} from '@/lib/types';

/* Home's first paint: the heading, Capture and one plain card per active project from the saved
 * workspace. Briefings arrive through a deferred module that replaces the plain cards. Keep this
 * file free of feeds and helpers so the startup code stays small. */
export function HomeView({onCapture,children}:{onCapture:()=>void;children:ReactNode}){
 return <section className="home" aria-labelledby="home-heading">
  <header className="page-heading simple-heading"><div><h1 id="home-heading">Home</h1><p>Where each project stands, what it needs from you and the next step.</p></div><button type="button" className="button secondary" onClick={onCapture}><Plus size={16}/>Capture an idea</button></header>
  {children}
 </section>;
}
function PlainCard({project,onOpenProject}:{project:Project;onOpenProject:(project:Project)=>void}){
 const id=useId();
 return <article className="home-card" aria-labelledby={`${id}-name`}>
  <header className="home-card-head"><h2 id={`${id}-name`}>{project.name}</h2></header>
  <div className="home-aim"><span className="home-label">Your goal</span><p>{project.goal||'No goal written yet.'}</p></div>
  <p className="home-quiet">Loading the latest briefing…</p>
  <footer className="home-card-actions"><button type="button" className="text-button" onClick={()=>onOpenProject(project)}>Open project</button></footer>
 </article>;
}
export function HomeEmpty(){return <div className="panel home-empty"><h2>No active project</h2><p>Create a project under Projects, or restore an archived one there.</p></div>;}
/** The plain cards shown while the briefing module loads. */
export function HomeProjectList({workspace,onOpenProject}:{workspace:Workspace;onOpenProject:(project:Project)=>void}){
 const projects=workspace.projects.filter(project=>!project.archivedAt);
 return projects.length?<div className="home-cards">{projects.map(project=><PlainCard key={project.id} project={project} onOpenProject={onOpenProject}/>)}</div>:<HomeEmpty/>;
}
