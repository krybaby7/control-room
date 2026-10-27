'use client';
import {useId} from 'react';
import {ChevronRight} from 'lucide-react';

export type AdvancedTool='lanes'|'today'|'weekly'|'search'|'attention'|'inbox'|'bulk'|'history'|'evidence'|'sources'|'local-analysis'|'reviews'|'runtime'|'agents';
const GROUPS:readonly {title:string;tools:readonly {id:AdvancedTool;description:string}[]}[]=[
 {title:'Plan and review',tools:[
  {id:'lanes',description:'Progress by area, with what your chats say about each.'},
  {id:'today',description:'Every status light, meter and live run on one page (the old Today page).'},
  {id:'weekly',description:'Choose this week’s focus and review the last one.'},
  {id:'search',description:'Find any project, milestone, task or note.'},
  {id:'attention',description:'Every planning check: blocked, stale or unclear work.'},
  {id:'inbox',description:'Ideas and notes you captured, waiting to be sorted.'},
  {id:'bulk',description:'Change the status, dates or project of many tasks together.'},
 ]},
 {title:'Records',tools:[
  {id:'history',description:'Every saved change, with undo.'},
  {id:'evidence',description:'The proof and decisions behind milestones and tasks.'},
  {id:'sources',description:'Download a copy of your workspace, restore one, and see dated sources.'},
 ]},
 {title:'Your PC and assistants',tools:[
  {id:'local-analysis',description:'Folders on this PC, technical analysis and the Codex Cloud import.'},
  {id:'reviews',description:'Saved project briefs and scheduled automations.'},
  {id:'runtime',description:'Your PC’s connection and load.'},
  {id:'agents',description:'Assistant tasks, approvals and spending limits.'},
 ]},
];
/** Every detailed tool in one place. Each keeps its own page, address and behaviour. */
export function AdvancedView({labels,onOpen,liveUpdates,savedLine}:{labels:Record<AdvancedTool,string>;onOpen:(tool:AdvancedTool)=>void;liveUpdates:string;savedLine:string}){
 const id=useId();
 return <section className="advanced" aria-labelledby={`${id}-heading`}>
  <header className="page-heading simple-heading"><div><h1 id={`${id}-heading`}>Advanced</h1><p>Every detailed tool, in one place. You don’t need these for the everyday view.</p></div></header>
  {GROUPS.map((group,index)=><section key={group.title} className="advanced-group" aria-labelledby={`${id}-group-${index}`}>
   <h2 id={`${id}-group-${index}`}>{group.title}</h2>
   <ul className="advanced-list">{group.tools.map(tool=><li key={tool.id} className="advanced-item"><button type="button" className="advanced-link" aria-describedby={`${id}-${tool.id}`} onClick={()=>onOpen(tool.id)}>{labels[tool.id]}<ChevronRight size={16} aria-hidden="true"/></button><p id={`${id}-${tool.id}`}>{tool.description}</p></li>)}</ul>
  </section>)}
  <section className="advanced-group" aria-labelledby={`${id}-connection`}>
   <h2 id={`${id}-connection`}>Connection details</h2>
   <div className="advanced-connection"><p>{liveUpdates}</p><p>{savedLine}</p></div>
  </section>
 </section>;
}
