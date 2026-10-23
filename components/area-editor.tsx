'use client';
import {useState} from 'react';
import type {Command,Project,ProjectArea,Workspace} from '@/lib/types';
import {useDurableDraft} from './durable-draft';
import {Field,FormDialog} from './form-dialog';

export function AreaEditor({project,area,initialOrder=0,onSave,onClose}:{project:Project;area?:ProjectArea;initialOrder?:number;onSave:(command:Command)=>Promise<void>;onClose:()=>void}){
 const {baseline,draft,setDraft,saved,notice}=useDurableDraft('area',area?.id??`new:${project.id}`,{name:area?.name??'',aliases:area?.aliases.join('\n')??'',order:area?.order??initialOrder});
 return <FormDialog title={area?'Edit area':'Create area'} subtitle={`A stable work area in ${project.name}. Renaming keeps its task and history links.`} dirty={JSON.stringify(draft)!==JSON.stringify(baseline)} onClose={onClose} submitLabel={area?'Save area':'Create area'} onSave={async()=>{
  const aliases=draft.aliases.split('\n').map(value=>value.trim()).filter(Boolean);
  const value={name:draft.name,aliases,order:draft.order};
  await onSave(area?{type:'area.update',id:area.id,patch:value}:{type:'area.create',projectId:project.id,...value});await saved();
 }}>
  {notice}
  <Field label="Area name"><input autoFocus required maxLength={120} value={draft.name} onChange={event=>setDraft(value=>({...value,name:event.target.value}))} /></Field>
  <Field label="Aliases" hint="One name per line, up to 10. Previous names are retained when an area is renamed."><textarea rows={3} maxLength={1209} value={draft.aliases} onChange={event=>setDraft(value=>({...value,aliases:event.target.value}))} /></Field>
  <Field label="Display order"><input type="number" required min={0} max={Number.MAX_SAFE_INTEGER} step={1} value={draft.order} onChange={event=>setDraft(value=>({...value,order:Number(event.target.value)}))} /></Field>
 </FormDialog>;
}
/** Commands use the controller's existing save/CAS path; archived areas retain links. */
export function AreaManager({project,workspace,busy=false,onSave}:{project:Project;workspace:Workspace;busy?:boolean;onSave:(command:Command)=>Promise<void>}){
 const [editing,setEditing]=useState<ProjectArea|'new'|null>(null),[error,setError]=useState('');
 const areas=(workspace.areas??[]).filter(area=>area.projectId===project.id).toSorted((a,b)=>a.order-b.order||a.id.localeCompare(b.id));
 const lifecycle=async(area:ProjectArea)=>{setError('');try{await onSave({type:area.archivedAt?'area.restore':'area.archive',id:area.id});}catch(error){setError(error instanceof Error?error.message:'Could not save the area.');}};
 return <section aria-label={`Areas in ${project.name}`}><h3>Areas</h3><p className="field-hint">Tasks without an area remain Unclassified. Archiving an area keeps its task and history links.</p>{error&&<p role="alert">{error}</p>}
  {areas.length?<ul>{areas.map(area=><li key={area.id}><span>{area.name}{area.archivedAt?' · Archived':''}</span> <button type="button" className="text-button" disabled={busy} onClick={()=>setEditing(area)}>Edit</button> <button type="button" className="text-button" disabled={busy} onClick={()=>void lifecycle(area)}>{area.archivedAt?'Restore':'Archive'}</button></li>)}</ul>:<p>No areas yet.</p>}
  <button type="button" className="text-button" disabled={busy||Boolean(project.archivedAt)||areas.length>=100||(workspace.areas??[]).length>=1000} onClick={()=>setEditing('new')}>Create area</button>
  {editing&&<AreaEditor project={project} area={editing==='new'?undefined:editing} initialOrder={Math.max(-1,...areas.map(area=>area.order))+1} onSave={onSave} onClose={()=>setEditing(null)} />}
 </section>;
}
