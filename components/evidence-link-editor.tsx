'use client';
import type {Workspace} from '@/lib/types';
import type {EvidenceRequirement,EvidenceSubject,EvidenceVersion} from '@/lib/evidence-contract';
import {evidenceLinkInputSchema} from '@/lib/evidence-validation';
import type {JsonValue,WorkspaceCommand} from '@/lib/workspace-protocol';
import {useDurableDraft} from './durable-draft';
import {Field,FormDialog} from './form-dialog';
type LinkInput={subject:EvidenceSubject;requirementId:string|null;relation:'supports'|'contradicts'|'context'};
export interface EvidenceLinkEditorProps {evidence:EvidenceVersion;workspace:Workspace;requirements:EvidenceRequirement[];onSave:(command:WorkspaceCommand)=>Promise<void>;onClose:()=>void}
export function EvidenceLinkEditor({evidence,workspace,requirements,onSave,onClose}:EvidenceLinkEditorProps){
 const initial:LinkInput={subject:{type:'project',id:''},requirementId:null,relation:'context'};
 const {baseline,draft,setDraft,saved,notice}=useDurableDraft('evidence-link',`${evidence.id}:${evidence.version}`,initial);
 const subjects=draft.subject.type==='project'?workspace.projects.map(row=>({id:row.id,label:row.name,archived:!!row.archivedAt})):draft.subject.type==='milestone'?workspace.milestones.map(row=>({id:row.id,label:row.title,archived:!!row.archivedAt})):draft.subject.type==='task'?workspace.tasks.map(row=>({id:row.id,label:row.title,archived:row.status==='archived'})):workspace.captures.map(row=>({id:row.id,label:row.title,archived:row.status==='archived'}));
 const matching=requirements.filter(row=>!row.archivedAt&&row.subject.type===draft.subject.type&&row.subject.id===draft.subject.id);
 return <FormDialog title="Link an exact evidence version" subtitle="Choose the saved subject and the relationship this statement has to it." dirty={JSON.stringify(draft)!==JSON.stringify(baseline)} onClose={onClose} submitLabel="Save evidence link" onSave={async()=>{
  if(!subjects.some(row=>row.id===draft.subject.id))throw new Error('Choose an available subject from this workspace.');
  if(draft.requirementId&&!matching.some(row=>row.id===draft.requirementId))throw new Error('The selected requirement is unavailable or changed. Review the subject and requirement again.');
  const value=evidenceLinkInputSchema.parse({evidenceId:evidence.id,evidenceVersion:evidence.version,...draft});await onSave({type:'evidence.link',value:value as unknown as JsonValue});await saved();
 }}>
  {notice}
  <div className="capture-preview"><h3>{evidence.title}</h3><p>Evidence {evidence.id} · Exact version {evidence.version} · {evidence.basis} · {evidence.scope}</p><p role="note">This link always cites version {evidence.version}. If a newer version exists, saving does not move this historical citation to it. Linking evidence does not record acceptance or change task status.</p></div>
  <Field label="Evidence link subject type"><select aria-label="Evidence link subject type" value={draft.subject.type} onChange={event=>setDraft(current=>({...current,subject:{type:event.target.value as EvidenceSubject['type'],id:''},requirementId:null}))}><option value="project">Project</option><option value="milestone">Milestone</option><option value="task">Task</option><option value="capture">Capture</option></select></Field>
  <Field label="Evidence link subject" hint="Choose the actual record ID. Equal titles do not identify the same record."><select aria-label="Evidence link subject" required value={draft.subject.id} onChange={event=>setDraft(current=>({...current,subject:{...current.subject,id:event.target.value},requirementId:null}))}><option value="">Choose a saved subject</option>{subjects.map(row=><option key={row.id} value={row.id}>{row.label} · {row.id}{row.archived?' (archived)':''}</option>)}</select></Field>
  <Field label="Evidence link requirement" hint="Optional. Only active requirements for this exact subject are available."><select aria-label="Evidence link requirement" value={draft.requirementId??''} onChange={event=>setDraft(current=>({...current,requirementId:event.target.value||null}))}><option value="">No named requirement</option>{matching.map(row=><option key={row.id} value={row.id}>{row.label} · {row.scope} · {row.id}</option>)}</select></Field>
  <Field label="Evidence relationship"><select aria-label="Evidence relationship" value={draft.relation} onChange={event=>setDraft(current=>({...current,relation:event.target.value as LinkInput['relation']}))}><option value="context">Context only</option><option value="supports">Supports the subject or named requirement</option><option value="contradicts">Contradicts the subject or named requirement</option></select></Field>
 </FormDialog>;
}
