'use client';
import {useId} from 'react';
import {ChevronRight} from 'lucide-react';
import type {Project,Task,Workspace} from '@/lib/types';
import type {WorkspaceCommand} from '@/lib/workspace-protocol';
import type {AttentionItem,DashboardModel,FeedState} from '@/lib/dashboard/model';
import type {readFeedSnapshot} from '@/lib/dashboard/feed';
import type {sendPersonalAction} from '@/lib/project-briefing-client';
import {useBriefingFeed} from './briefing-feed';
import {dateLabel} from './ui';

export interface NeedsYouViewProps {
 workspace:Workspace;revision:number;busy:boolean;
 onCommand?:(command:WorkspaceCommand)=>Promise<boolean>;
 onProject:(project:Project)=>void;onTask:(task:Task)=>void;onAgents:()=>void;onInbox:()=>void;onAttention:()=>void;
 readSnapshot?:typeof readFeedSnapshot;sendAction?:typeof sendPersonalAction;
}
export interface NeedsItem {key:string;title:string;detail:string;open:()=>void}
export interface NeedsGroup {key:string;title:string;items:NeedsItem[]}
export interface NeedsYouHandlers {onProject:(project:Project)=>void;onTask:(task:Task)=>void;onAgents:()=>void;onInbox:()=>void;onAttention:()=>void}
/** Groups everything that waits on the owner by project: briefing requests first, then decisions,
 * overdue and carried work; items without an active project follow. Pure: it only reads the model. */
export function needsYouGroups(model:DashboardModel,workspace:Workspace,handlers:NeedsYouHandlers):NeedsGroup[]{
 const {onProject,onTask,onAgents,onInbox,onAttention}=handlers;
 const taskOf=(item:AttentionItem)=>item.taskId?workspace.tasks.find(task=>task.id===item.taskId)??null:null;
 const toItem=(item:AttentionItem):NeedsItem=>{
  const task=taskOf(item),openTask=()=>{if(task)onTask(task);};
  switch(item.kind){
   case 'review':return {key:item.key,title:item.title,detail:'Waiting for your review.',open:openTask};
   case 'overdue':return {key:item.key,title:item.title,detail:task?.dueDate?`Was due ${dateLabel(task.dueDate)}.`:'Past its due date.',open:openTask};
   case 'carry':return {key:item.key,title:item.title,detail:'Pinned for an earlier week and still open.',open:openTask};
   case 'approval':return {key:item.key,title:item.title,detail:'An assistant task is waiting for your go-ahead.',open:onAgents};
   case 'reconcile':return {key:item.key,title:item.title,detail:'An assistant run ended without a clear result. Check what happened.',open:onAgents};
   case 'inbox':{const count=workspace.captures.filter(capture=>capture.status==='inbox').length;return {key:item.key,title:`${count} captured idea${count===1?'':'s'} to sort`,detail:'File them, turn them into tasks or archive them.',open:onInbox};}
   default:return {key:item.key,title:item.title,detail:item.detail,open:onAttention};
  }
 };
 const active=new Set(model.projects.map(tile=>tile.project.id));
 const groups:NeedsGroup[]=model.projects.map(tile=>({key:tile.project.id,title:tile.project.name,items:[
  ...(tile.briefing.report?.needsYou??[]).map((text,index)=>({key:`briefing:${tile.project.id}:${index}`,title:text,detail:'Raised by the latest briefing.',open:()=>onProject(tile.project)})),
  ...model.attention.filter(item=>item.kind!=='decision'&&item.projectId===tile.project.id).map(toItem),
 ]}));
 for(const item of model.attention.filter(item=>item.kind!=='decision'&&(!item.projectId||!active.has(item.projectId)))){const key=item.projectId?`other:${item.projectId}`:'other',title=item.projectName??'Not tied to a project';let group=groups.find(row=>row.key===key);if(!group){group={key,title,items:[]};groups.push(group);}group.items.push(toItem(item));}
 return groups.filter(group=>group.items.length>0);
}
const ignore=()=>{};
/** How many things wait on the owner: exactly the items the Needs you screen lists. */
export function needsYouTotal(model:DashboardModel,workspace:Workspace):number{
 return needsYouGroups(model,workspace,{onProject:ignore,onTask:ignore,onAgents:ignore,onInbox:ignore,onAttention:ignore}).reduce((sum,group)=>sum+group.items.length,0);
}
export function NeedsYouContent({groups,briefings,onAttention}:{groups:NeedsGroup[];briefings:FeedState['status'];onAttention:()=>void}){
 const id=useId(),total=groups.reduce((sum,group)=>sum+group.items.length,0);
 return <section className="needs-you" aria-labelledby={`${id}-heading`}>
  <header className="page-heading simple-heading"><div><h1 id={`${id}-heading`}>Needs you</h1><p>{total?`${total} thing${total===1?'':'s'} wait${total===1?'s':''} on you.`:'Nothing waits on you right now.'}</p></div></header>
  {briefings==='loading'&&<p className="home-quiet" role="status">Checking your latest briefings…</p>}
  {briefings==='failed'&&<p className="home-quiet" role="status">Saved briefings could not be read just now, so items raised by briefings may be missing. Control Room tries again on its own.</p>}
  {groups.map((group,index)=><section key={group.key} className="needs-group" aria-labelledby={`${id}-group-${index}`}>
   <h2 id={`${id}-group-${index}`}>{group.title}</h2>
   <ul className="needs-list">{group.items.map(item=><li key={item.key}><button type="button" className="needs-item" onClick={item.open}><span><strong>{item.title}</strong><small>{item.detail}</small></span><ChevronRight size={16} aria-hidden="true"/></button></li>)}</ul>
  </section>)}
  {!total&&briefings!=='loading'&&<div className="panel home-empty"><h2>All clear</h2><p>No decisions, reviews, overdue work or captured ideas are waiting.</p></div>}
  <p className="home-quiet">Planning checks such as blocked or stale work are under Advanced → Attention. <button type="button" className="text-button" onClick={onAttention}>Open Attention</button></p>
 </section>;
}
/** Everything that waits on the owner. It reads saved records only; opening an item navigates and
 * never changes anything. */
export function NeedsYouView({workspace,revision,busy,onCommand,onProject,onTask,onAgents,onInbox,onAttention,readSnapshot,sendAction}:NeedsYouViewProps){
 const feed=useBriefingFeed({workspace,revision,busy,onCommand,readSnapshot,sendAction,reports:false});
 if(feed.expired)return null;
 return <NeedsYouContent groups={needsYouGroups(feed.model,workspace,{onProject,onTask,onAgents,onInbox,onAttention})} briefings={feed.snapshot.feeds.briefings.status} onAttention={onAttention}/>;
}
