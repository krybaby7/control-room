'use client';
import {useState} from 'react';
import type {ClaimScope,DecisionVersion} from '@/lib/evidence-contract';
import type {EvidenceSnapshot} from '@/lib/evidence-store';
import type {JsonValue,WorkspaceCommand} from '@/lib/workspace-protocol';
import {decisionExceptionSchema,decisionVersionSchema} from '@/lib/decisions';
import {useDurableDraft} from './durable-draft';
import {Field,FormDialog} from './form-dialog';
const scopes:ClaimScope[]=['implementation','software-verification','physical-acceptance','operation','release-acceptance','economics'];
interface ActionDraft {decisionId:string;expectedVersion:number;replacementId:string;expectedReplacementVersion:number|null;selectedOptionId:string;rationale:string;reason:string;exceptionEnabled:boolean;scope:ClaimScope;expiresAt:string;requirementIds:string[];}
export interface DecisionActionDialogProps {decision:DecisionVersion;snapshot:EvidenceSnapshot;action:'decide'|'supersede';onSave:(command:WorkspaceCommand)=>Promise<void>;onClose:()=>void;}
export function DecisionActionDialog(props:DecisionActionDialogProps){
 const {onSave,onClose}=props;
 const [opening]=useState(()=>({decision:structuredClone(props.decision),snapshot:structuredClone(props.snapshot),action:props.action}));
 const {decision,snapshot,action}=opening;
 const initial:ActionDraft={decisionId:decision.id,expectedVersion:decision.version,replacementId:'',expectedReplacementVersion:null,selectedOptionId:action==='decide'?decision.selectedOptionId??'':'',rationale:action==='decide'?decision.rationale:'',reason:'',exceptionEnabled:false,scope:'implementation',expiresAt:'',requirementIds:[]};
 const {baseline,draft,setDraft,saved,notice}=useDurableDraft(`decision-${action}`,decision.id,initial);
 const [confirmed,setConfirmed]=useState(false);
 const set=<K extends keyof ActionDraft>(key:K,value:ActionDraft[K])=>setDraft(current=>({...current,[key]:value}));
 const current=(row:DecisionVersion)=>snapshot.decisionHeads.some(head=>head.id===row.id&&head.archivedAt===null&&head.currentVersion===row.version);
 const replacements=snapshot.decisionVersions.filter(row=>row.id!==decision.id&&row.status==='draft'&&current(row));
 const target=action==='decide'?decision:replacements.find(row=>row.id===draft.replacementId&&row.version===draft.expectedReplacementVersion);
 const criteria=snapshot.requirements.filter(row=>row.archivedAt===null&&row.required&&row.scope===draft.scope&&target?.subjects.some(subject=>subject.type===row.subject.type&&subject.id===row.subject.id));
 const submit=async()=>{
  if(!confirmed)throw new Error('Confirm that you reviewed this decision and that it does not execute an action.');
  if(draft.decisionId!==decision.id||draft.expectedVersion!==decision.version||!current(decision))throw new Error('The captured decision version differs. Reopen the reviewed record before deciding.');
  if(!target)throw new Error('Choose an available replacement draft and its captured version.');
  decisionVersionSchema.parse(target);
  if(action==='supersede'&&decision.status!=='decided'||action==='decide'&&decision.status==='superseded')throw new Error('This captured decision status does not permit the selected action.');
  if(!target.question.trim()||!target.options.some(option=>option.id===draft.selectedOptionId))throw new Error('Choose one recorded option for a nonempty decision question.');
  if(!draft.rationale.trim()||draft.rationale.length>10000)throw new Error('Record a rationale of up to 10,000 characters.');
  if(action==='supersede'&&(!draft.reason.trim()||draft.reason.length>5000))throw new Error('Record an explicit supersession reason of up to 5,000 characters.');
  let exception:JsonValue|null=null;
  if(draft.exceptionEnabled){const grant=decisionExceptionSchema.parse({scope:draft.scope,expiresAt:draft.expiresAt,requirementIds:draft.requirementIds});if(Date.parse(grant.expiresAt)<=Date.parse(snapshot.asOf))throw new Error('Exception expiry must be after the captured server time. The server also checks expiry when saving.');if(grant.requirementIds.some(id=>!criteria.some(row=>row.id===id)))throw new Error('Exception criteria must be active required criteria for this exact scope and linked subjects.');exception=grant as unknown as JsonValue;}
  const choice={selectedOptionId:draft.selectedOptionId,rationale:draft.rationale,exception};
  const command:WorkspaceCommand=action==='decide'?{type:'decisions.decide',id:draft.decisionId,expectedVersion:draft.expectedVersion,choice}:{type:'decisions.supersede',id:draft.decisionId,expectedVersion:draft.expectedVersion,replacementId:target.id,expectedReplacementVersion:target.version,choice:{...choice,reason:draft.reason}};
  await onSave(command);await saved();
 };
 return <FormDialog title={action==='decide'?'Record owner decision':'Supersede owner decision'} subtitle={`Captured decision version ${decision.version}, workspace revision ${snapshot.revision}. The server records the actual decision time.`} dirty={JSON.stringify(draft)!==JSON.stringify(baseline)} submitLabel={action==='decide'?'Record reviewed decision':'Record reviewed supersession'} onClose={onClose} onSave={submit}>
  {notice}<div className="capture-preview"><h3>{decision.title}</h3><p style={{whiteSpace:'pre-wrap'}}>{decision.question}</p><p className="field-hint">Recording a decision does not execute work, grant trading permission, spend money, or record milestone acceptance.</p></div>
  {action==='supersede'&&<Field label="Replacement decision draft" hint="Only current, unarchived saved drafts are available. Earlier versions remain immutable."><select aria-label="Replacement decision draft" required value={draft.replacementId} onChange={event=>{const selected=replacements.find(row=>row.id===event.target.value);setDraft(value=>({...value,replacementId:selected?.id??'',expectedReplacementVersion:selected?.version??null,selectedOptionId:'',requirementIds:[]}));setConfirmed(false);}}><option value="">Choose a replacement draft</option>{replacements.map(row=><option key={row.id} value={row.id}>{row.title} · Version {row.version}</option>)}</select></Field>}
  {target&&<section className="capture-preview" aria-label="Reviewed decision alternatives"><h3>{target.title} · Version {target.version}</h3><p style={{whiteSpace:'pre-wrap'}}>{target.question}</p>{target.options.length?<ul>{target.options.map(option=><li key={option.id}><strong>{option.label}</strong><p style={{whiteSpace:'pre-wrap'}}>{option.description}</p></li>)}</ul>:<p>No alternatives are recorded. Revise the draft before deciding.</p>}</section>}
  <Field label="Reviewed decision choice"><select aria-label="Reviewed decision choice" required value={draft.selectedOptionId} onChange={event=>{set('selectedOptionId',event.target.value);setConfirmed(false);}}><option value="">Choose one recorded option</option>{target?.options.map(option=><option key={option.id} value={option.id}>{option.label}</option>)}</select></Field>
  <Field label="Owner decision rationale"><textarea aria-label="Owner decision rationale" required rows={6} maxLength={10000} value={draft.rationale} onChange={event=>{set('rationale',event.target.value);setConfirmed(false);}}/></Field>
  {action==='supersede'&&<Field label="Supersession reason"><textarea aria-label="Supersession reason" required rows={4} maxLength={5000} value={draft.reason} onChange={event=>{set('reason',event.target.value);setConfirmed(false);}}/></Field>}
  <label className="check-card"><input type="checkbox" checked={draft.exceptionEnabled} onChange={event=>{set('exceptionEnabled',event.target.checked);setConfirmed(false);}}/><span><strong>Record a scoped acceptance exception</strong><small>Optional, explicit and expiring. This does not waive unrelated criteria or authorize execution.</small></span></label>
  {draft.exceptionEnabled&&<section aria-label="Scoped exception details"><Field label="Exception scope"><select aria-label="Exception scope" value={draft.scope} onChange={event=>{setDraft(value=>({...value,scope:event.target.value as ClaimScope,requirementIds:[]}));setConfirmed(false);}}>{scopes.map(scope=><option key={scope} value={scope}>{scope}</option>)}</select></Field><Field label="Exception expires at" hint="Required future ISO timestamp with Z or an explicit offset. No expiry date is invented."><input aria-label="Exception expires at" type="text" required maxLength={80} placeholder="YYYY-MM-DDTHH:mm:ssZ" value={draft.expiresAt} onChange={event=>{set('expiresAt',event.target.value);setConfirmed(false);}}/></Field><fieldset className="dependency-field"><legend>Required criteria for this scope and the decision’s linked subjects</legend>{criteria.length?criteria.map(row=><label className="dependency-option" key={row.id}><input type="checkbox" checked={draft.requirementIds.includes(row.id)} onChange={event=>{set('requirementIds',event.target.checked?[...draft.requirementIds,row.id]:draft.requirementIds.filter(id=>id!==row.id));setConfirmed(false);}}/><span>{row.label}<small>{row.subject.type} · {row.subject.id} · {row.scope}</small></span></label>):<p className="field-hint">No active required criteria match this scope and linked subjects.</p>}</fieldset>{draft.requirementIds.filter(id=>!criteria.some(row=>row.id===id)).map(id=><p className="form-error" key={id}>Recovered criterion {id} is unavailable in this captured scope. <button type="button" className="text-button" onClick={()=>{set('requirementIds',draft.requirementIds.filter(value=>value!==id));setConfirmed(false);}}>Remove unavailable criterion</button></p>)}</section>}
  <label className="check-card"><input type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/><span><strong>I reviewed this exact choice and rationale. Recording this decision does not execute an action.</strong><small>Source and replacement versions stay fixed to the opening snapshot. A conflict requires review before retrying.</small></span></label>
 </FormDialog>;
}
