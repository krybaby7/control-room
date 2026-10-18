'use client';

import {SubjectReviewLink} from './subject-review-link';

import type {Project} from '@/lib/types';
import type {PlanningWorkflowCommand,ProjectInput} from '@/lib/planning-contract';
import {changedFields} from '@/lib/draft';
import {useDurableDraft} from './durable-draft';
import {Field,FormDialog} from './form-dialog';

export function PortfolioProjectEditor({project,onSave,onClose}:{project?:Project;onSave:(command:PlanningWorkflowCommand)=>Promise<void>;onClose:()=>void}){
 const initial:ProjectInput={name:project?.name??'',description:project?.description??'',goal:project?.goal??'',color:project?.color??'orange',repositories:project?.repositories.map(repository=>({...repository}))??[]};
 const {baseline,draft,setDraft,saved,notice}=useDurableDraft('portfolio-project',project?.id??'new',initial);
 const set=<K extends keyof ProjectInput>(key:K,value:ProjectInput[K])=>setDraft(current=>({...current,[key]:value}));
 const repository=(index:number,key:'name'|'url',value:string)=>setDraft(current=>({...current,repositories:current.repositories.map((row,i)=>i===index?{...row,[key]:value}:row)}));
 return <FormDialog title={project?'Edit project':'Create project'} subtitle="Set the outcome and the references you want to keep close." dirty={JSON.stringify(baseline)!==JSON.stringify(draft)} onClose={onClose} submitLabel={project?'Save project':'Create project'} onSave={async()=>{await onSave(project?{type:'project.edit',id:project.id,patch:changedFields(baseline,draft)}:{type:'project.create',project:draft});await saved();}}>
  {notice}
  {project&&<p><SubjectReviewLink subject={{type:'project',id:project.id}}/></p>}
  <Field label="Project name"><input autoFocus required maxLength={200} value={draft.name} onChange={event=>set('name',event.target.value)}/></Field>
  <Field label="Goal" hint="Describe the outcome and constraints that matter."><textarea rows={4} maxLength={5000} value={draft.goal} onChange={event=>set('goal',event.target.value)}/></Field>
  <Field label="Description"><textarea rows={3} maxLength={5000} value={draft.description} onChange={event=>set('description',event.target.value)}/></Field>
  <Field label="Project color"><select value={draft.color} onChange={event=>set('color',event.target.value as Project['color'])}><option value="orange">Orange</option><option value="teal">Teal</option></select></Field>
  <fieldset className="dependency-field"><legend>Repository references</legend><p className="field-hint">Changing these references keeps older source records intact. Use public or accessible HTTP or HTTPS links without embedded credentials.</p>
   {draft.repositories.map((row,index)=><fieldset className="capture-preview" key={index}><legend>Repository {index+1}</legend><Field label={`Repository ${index+1} name`}><input required maxLength={200} value={row.name} onChange={event=>repository(index,'name',event.target.value)}/></Field><Field label={`Repository ${index+1} URL`}><input required type="url" maxLength={2048} value={row.url} onChange={event=>repository(index,'url',event.target.value)}/></Field><button type="button" className="text-button" aria-label={`Remove repository ${index+1}: ${row.name||'unnamed'}`} onClick={()=>setDraft(current=>({...current,repositories:current.repositories.filter((_,i)=>i!==index)}))}>Remove repository</button></fieldset>)}
   {!draft.repositories.length&&<p className="field-hint">No repository references added.</p>}
   <button type="button" className="button secondary" disabled={draft.repositories.length>=100} onClick={()=>setDraft(current=>({...current,repositories:[...current.repositories,{name:'',url:''}]}))}>Add repository</button><p className="field-hint">{draft.repositories.length} of 100 references</p>
  </fieldset>
 </FormDialog>;
}
