'use client';
import {useState} from 'react';
import {z} from 'zod';
import type {WorkspaceCommand} from '@/lib/workspace-protocol';
import {agentIdSchema} from '@/lib/agents/contracts';
import type {JobBudgetDisplay} from '@/lib/agents/read-model';
import {useDurableDraft} from './durable-draft';
import {Field,FormDialog} from './form-dialog';
export const jobBudgetInputSchema=z.object({id:agentIdSchema,expectedOperationalRevision:z.number().int().positive().safe().nullable(),value:z.object({maximumJobs:z.number().int().min(0).max(12),maximumSeconds:z.number().int().min(0).max(7200),enabled:z.boolean()}).strict()}).strict();
export function buildJobBudgetCommand(raw:unknown,reviewed:boolean):WorkspaceCommand{
 if(!reviewed)throw new Error('Review this finite subscription-only budget before saving.');
 const input=jobBudgetInputSchema.parse(raw);
 if(input.value.enabled&&(!input.value.maximumJobs||!input.value.maximumSeconds))throw new Error('An enabled budget needs a positive job and wall-time limit.');
 return {type:'jobs.budget.configure',...input};
}
export interface JobBudgetEditorProps {budget?:JobBudgetDisplay;onSave:(command:WorkspaceCommand)=>Promise<void>;onClose:()=>void}
export function JobBudgetEditor({budget,onSave,onClose}:JobBudgetEditorProps){
 const [initial]=useState(()=>({id:budget?.id??crypto.randomUUID(),expectedOperationalRevision:budget?.operationalRevision??null,maximumJobs:budget?.maximumJobs??0,maximumSeconds:budget?.maximumSeconds??0,enabled:budget?.enabled??false}));
 const {baseline,draft,setDraft,saved,notice}=useDurableDraft('agent-budget',budget?.id??'new',initial),[reviewed,setReviewed]=useState(false);
 const set=<K extends keyof typeof initial>(key:K,value:typeof initial[K])=>{setReviewed(false);setDraft(current=>({...current,[key]:value}));};
 return <FormDialog title={budget?'Edit execution budget':'Configure execution budget'} subtitle="Finite subscription-only bounds. Saving this configuration does not install or launch an executor." submitLabel="Save execution budget" dirty={JSON.stringify(draft)!==JSON.stringify(baseline)} onClose={onClose} onSave={async()=>{await onSave(buildJobBudgetCommand({id:draft.id,expectedOperationalRevision:draft.expectedOperationalRevision,value:{maximumJobs:draft.maximumJobs,maximumSeconds:draft.maximumSeconds,enabled:draft.enabled}},reviewed));await saved();}}>
 {notice}<p>Budget {draft.id}</p>{budget?<p>Recorded reserved jobs {budget.reservedJobs} · Reserved seconds {budget.reservedSeconds} · Charged seconds {budget.chargedSeconds}. These totals are retained when limits change.</p>:<p>New budget. No usage has been recorded for this budget yet.</p>}
 <Field label="Maximum jobs" hint="An integer from 0 to 12. Zero cannot enable execution."><input required type="number" min={0} max={12} step={1} value={draft.maximumJobs} onChange={event=>set('maximumJobs',event.target.valueAsNumber)}/></Field>
 <Field label="Maximum execution seconds" hint="Total finite wall-time allocation, from 0 to 7,200 seconds. Each job also has its own 30–600 second timeout."><input required type="number" min={0} max={7200} step={1} value={draft.maximumSeconds} onChange={event=>set('maximumSeconds',event.target.valueAsNumber)}/></Field>
 <label className="check-card"><input type="checkbox" checked={draft.enabled} onChange={event=>set('enabled',event.target.checked)}/>Enable this finite subscription budget</label>
 <p className="field-hint">Only an installed, locally permitted subscription runtime with renewable private ingress and fresh device capability can consume an approved reservation. There is no API-key fallback, paid API activation, quota reset, unlimited loop or hard token/dollar cap here. Disabling this budget does not claim that an existing process has stopped.</p>
 <label className="check-card"><input type="checkbox" checked={reviewed} onChange={event=>setReviewed(event.target.checked)}/>I reviewed these limits and retained usage</label>
 </FormDialog>;
}
