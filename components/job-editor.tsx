'use client';
import {useState} from 'react';
import type {WorkspaceEnvelope} from '@/lib/types';
import type {WorkspaceCommand} from '@/lib/workspace-protocol';
import {useDurableDraft} from './durable-draft';
import {Field,FormDialog} from './form-dialog';
import {agentJobRequestSchema,type AgentRequest} from '@/lib/agents/contracts';
export type AgentRequestInput=AgentRequest;
export function buildJobCreate(value:unknown,envelope:WorkspaceEnvelope):WorkspaceCommand{
 const request=agentJobRequestSchema.parse(value),task=envelope.workspace.tasks.find(row=>row.id===request.taskId),project=envelope.workspace.projects.find(row=>row.id===request.projectId);
 if(!task||!project||task.projectId!==project.id||task.status==='archived'||project.archivedAt)throw new Error('Select a current task in the selected project.');
 if(new Set(request.inputArtifactIds).size!==request.inputArtifactIds.length||new Set(request.dependsOnJobIds).size!==request.dependsOnJobIds.length)throw new Error('Select each artifact and dependency once.');
 return {type:'jobs.create',value:request};
}
export interface JobEditorProps {envelope:WorkspaceEnvelope;projectId?:string;taskId?:string;onSave:(command:WorkspaceCommand)=>Promise<void>;onClose:()=>void}
export function JobEditor({envelope,projectId='',taskId='',onSave,onClose}:JobEditorProps){
 const initial={operation:'project.inspect' as AgentRequestInput['operation'],projectId,taskId,repositoryKey:'',baseCommit:'',inputArtifacts:'',requestedModel:'',effort:'medium' as AgentRequestInput['effort'],timeoutSeconds:30,outputBytesLimit:2097152,dependencies:''};
 const {baseline,draft,setDraft,saved,notice}=useDurableDraft('agent-job',taskId||projectId||'new',initial),[consent,setConsent]=useState(false);
 const set=<K extends keyof typeof initial>(key:K,value:typeof initial[K])=>{setConsent(false);setDraft(current=>({...current,[key]:value}));};
 const ids=(value:string)=>value.trim()?value.trim().split(/\s+/u):[];
 return <FormDialog title="Propose an agent job" subtitle="Save a bounded proposal. Approval, execution and accepting its result are separate owner decisions." dirty={JSON.stringify(draft)!==JSON.stringify(baseline)} submitLabel="Save job proposal" onClose={onClose} onSave={async()=>{if(!consent)throw new Error('Review the job proposal before saving.');const {inputArtifacts,dependencies,...fields}=draft;await onSave(buildJobCreate({...fields,inputArtifactIds:ids(inputArtifacts),dependsOnJobIds:ids(dependencies)},envelope));await saved();}}>
 {notice}<Field label="Job project"><select required value={draft.projectId} onChange={event=>{setDraft(current=>({...current,projectId:event.target.value,taskId:''}));setConsent(false);}}><option value="">Select project</option>{envelope.workspace.projects.filter(row=>!row.archivedAt).map(row=><option key={row.id} value={row.id}>{row.name}</option>)}</select></Field>
 <Field label="Job task"><select required value={draft.taskId} onChange={event=>{set('taskId',event.target.value);setConsent(false);}}><option value="">Select task</option>{envelope.workspace.tasks.filter(row=>row.projectId===draft.projectId&&row.status!=='archived').map(row=><option key={row.id} value={row.id}>{row.title}</option>)}</select></Field>
 <Field label="Job operation"><select value={draft.operation} onChange={event=>set('operation',event.target.value as AgentRequestInput['operation'])}><option value="project.inspect">Inspect project</option><option value="project.propose-patch">Propose isolated patch</option></select></Field>
 <Field label="Repository key" hint="A locally configured repository alias, never a path or URL."><input required maxLength={128} value={draft.repositoryKey} onChange={event=>set('repositoryKey',event.target.value)}/></Field>
 <Field label="Base commit" hint="Exact full Git object ID, 40 or 64 lowercase hexadecimal characters."><input required maxLength={64} value={draft.baseCommit} onChange={event=>set('baseCommit',event.target.value)}/></Field>
 <Field label="Exact requested model" hint="Saving a model name does not establish that it is installed, authenticated or permitted."><input required maxLength={128} value={draft.requestedModel} onChange={event=>set('requestedModel',event.target.value)}/></Field>
 <div className="form-grid"><Field label="Job effort"><select value={draft.effort} onChange={event=>set('effort',event.target.value as AgentRequestInput['effort'])}>{['low','medium','high','xhigh','max','ultra'].map(value=><option key={value}>{value}</option>)}</select></Field><Field label="Timeout seconds"><input required type="number" min={30} max={600} value={draft.timeoutSeconds} onChange={event=>set('timeoutSeconds',event.target.valueAsNumber)}/></Field><Field label="Output byte limit"><input required type="number" min={1} max={2097152} value={draft.outputBytesLimit} onChange={event=>set('outputBytesLimit',event.target.valueAsNumber)}/></Field></div>
 <Field label="Input artifact IDs" hint="Up to eight existing private artifact IDs, separated by spaces. Their availability is checked by the server."><textarea rows={2} maxLength={1032} value={draft.inputArtifacts} onChange={event=>set('inputArtifacts',event.target.value)}/></Field>
 <Field label="Dependency job IDs" hint="Up to eight same-owner jobs. Dependencies must succeed before dispatch."><textarea rows={2} maxLength={1032} value={draft.dependencies} onChange={event=>set('dependencies',event.target.value)}/></Field>
 <p className="field-hint">The server records the current task snapshot and workspace version. This proposal cannot merge, deploy, trade, change weekly commitments or complete the task. Execution remains unavailable until verified private ingress, a configured device capability and a finite budget are installed.</p>
 <label className="check-card"><input type="checkbox" checked={consent} onChange={event=>setConsent(event.target.checked)}/>I reviewed this bounded job proposal</label>
 </FormDialog>;
}
