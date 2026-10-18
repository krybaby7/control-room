'use client';
import type {Workspace} from '@/lib/types';
import type {EvidenceRequirement,EvidenceSubject} from '@/lib/evidence-contract';
import {evidenceRequirementSchema} from '@/lib/evidence-requirements';
import type {JsonValue,WorkspaceCommand} from '@/lib/workspace-protocol';
import {useDurableDraft} from './durable-draft';
import {Field,FormDialog} from './form-dialog';
type RequirementInput=Omit<EvidenceRequirement,'id'|'archivedAt'>;
const inputSchema=evidenceRequirementSchema.omit({id:true,archivedAt:true}).strict();
export interface RequirementEditorProps {requirement?:{value:EvidenceRequirement;rowRevision:number};workspace:Workspace;initialSubject?:EvidenceSubject;onSave:(command:WorkspaceCommand)=>Promise<void>;onClose:()=>void}
export function RequirementEditor({requirement,workspace,initialSubject,onSave,onClose}:RequirementEditorProps){
 const prior=requirement?.value;
 const initial:RequirementInput=prior?{label:prior.label,scope:prior.scope,required:prior.required,maxAgeDays:prior.maxAgeDays,candidate:prior.candidate,requireAttachment:prior.requireAttachment,subject:{...prior.subject}}:{label:'',scope:'implementation',required:false,maxAgeDays:null,candidate:null,requireAttachment:false,subject:initialSubject?{...initialSubject}:{type:'project',id:''}};
 const key=prior?.id??`new:${initialSubject?.type??'project'}:${initialSubject?.id??''}`;
 const {baseline,draft,setDraft,saved,notice}=useDurableDraft('evidence-requirement',key,initial);
 const set=<K extends keyof RequirementInput>(key:K,value:RequirementInput[K])=>setDraft(current=>({...current,[key]:value}));
 const subjects=draft.subject.type==='project'?workspace.projects.map(row=>({id:row.id,label:row.name,archived:!!row.archivedAt})):draft.subject.type==='milestone'?workspace.milestones.map(row=>({id:row.id,label:row.title,archived:!!row.archivedAt})):draft.subject.type==='task'?workspace.tasks.map(row=>({id:row.id,label:row.title,archived:row.status==='archived'})):workspace.captures.map(row=>({id:row.id,label:row.title,archived:row.status==='archived'}));
 return <FormDialog title={prior?'Revise evidence requirement':'Create evidence requirement'} subtitle="Name one criterion and the scope of evidence it needs. Saving a criterion does not accept evidence or change progress." dirty={JSON.stringify(draft)!==JSON.stringify(baseline)} onClose={onClose} submitLabel={prior?'Save requirement revision':'Create evidence requirement'} onSave={async()=>{
  if(!subjects.some(row=>row.id===draft.subject.id))throw new Error('Choose an available requirement subject from this workspace.');
  const value=inputSchema.parse(draft) as unknown as JsonValue;await onSave(requirement?{type:'evidence.requirement.revise',id:requirement.value.id,expectedRowRevision:requirement.rowRevision,value}:{type:'evidence.requirement.create',value});await saved();
 }}>
  {notice}
  {prior&&<p className="field-hint">Requirement {prior.id} · Saved row revision {requirement!.rowRevision}. Earlier acceptance assessments remain historical and may need review after a criterion change.</p>}
  <Field label="Requirement label"><input aria-label="Requirement label" autoFocus required maxLength={200} value={draft.label} onChange={event=>set('label',event.target.value)}/></Field>
  <div className="form-grid"><Field label="Requirement subject type"><select aria-label="Requirement subject type" value={draft.subject.type} onChange={event=>set('subject',{type:event.target.value as EvidenceSubject['type'],id:''})}><option value="project">Project</option><option value="milestone">Milestone</option><option value="task">Task</option><option value="capture">Capture</option></select></Field><Field label="Requirement subject" hint="Select the exact saved record ID, including when names are repeated."><select aria-label="Requirement subject" required value={draft.subject.id} onChange={event=>set('subject',{...draft.subject,id:event.target.value})}><option value="">Choose a saved subject</option>{subjects.map(row=><option key={row.id} value={row.id}>{row.label} · {row.id}{row.archived?' (archived)':''}</option>)}</select></Field></div>
  <Field label="Requirement claim scope"><select aria-label="Requirement claim scope" value={draft.scope} onChange={event=>set('scope',event.target.value as RequirementInput['scope'])}><option value="implementation">Implementation</option><option value="software-verification">Software verification</option><option value="physical-acceptance">Physical acceptance</option><option value="operation">Operation</option><option value="release-acceptance">Release acceptance</option><option value="economics">Economics</option></select></Field>
  <label className="check-card"><input aria-label="This evidence criterion is required" type="checkbox" checked={draft.required} onChange={event=>set('required',event.target.checked)}/><span>This evidence criterion is required for an acceptance assessment.</span></label>
  <Field label="Maximum evidence age in days" hint="Optional, from 0 to 36,500 days. Leave blank for no freshness limit; an unknown observation date is not converted to a date."><input aria-label="Maximum evidence age in days" type="number" min={0} max={36500} step="any" value={draft.maxAgeDays??''} onChange={event=>set('maxAgeDays',event.target.value===''?null:Number(event.target.value))}/></Field>
  <Field label="Required evidence candidate" hint="Optional exact candidate label. Leave blank to impose no candidate match."><input aria-label="Required evidence candidate" maxLength={500} value={draft.candidate??''} onChange={event=>set('candidate',event.target.value||null)}/></Field>
  <label className="check-card"><input aria-label="Require a verified attachment" type="checkbox" checked={draft.requireAttachment} onChange={event=>set('requireAttachment',event.target.checked)}/><span>Require a verified attachment. Attachment metadata alone does not establish that bytes are available.</span></label>
 </FormDialog>;
}
