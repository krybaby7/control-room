'use client';
import type {Command} from '@/lib/types';
import {currentWeek} from '@/lib/calendar';
import {useDurableDraft} from './durable-draft';
import {Field,FormDialog} from './form-dialog';
export interface WeeklyReviewDraft {weekStart:string;supersedesId:string|null;reflection:string;nextWeekNotes:string}
export interface WeeklyReviewEditorProps {draft?:WeeklyReviewDraft;onSave:(command:Command)=>Promise<void>;onClose:()=>void}
export function WeeklyReviewEditor({draft:opening,onSave,onClose}:WeeklyReviewEditorProps){
 const initial:WeeklyReviewDraft=opening??{weekStart:currentWeek(),supersedesId:null,reflection:'',nextWeekNotes:''};
 const {baseline,draft,setDraft,saved,notice}=useDurableDraft('weekly-review',`${initial.weekStart}:${initial.supersedesId??'new'}`,initial);
 return <FormDialog title={initial.supersedesId?'Correct weekly review':'Close weekly review'} subtitle={`Cairo week beginning ${initial.weekStart}. Your prose is saved as a separate recoverable draft before submission.`} dirty={JSON.stringify(baseline)!==JSON.stringify(draft)} onClose={onClose} submitLabel={initial.supersedesId?'Save frozen correction':'Save frozen review'} onSave={async()=>{await onSave({type:'weekly.review',weekStart:draft.weekStart,supersedesId:draft.supersedesId,reflection:draft.reflection,nextWeekNotes:draft.nextWeekNotes});await saved();}}>
  {notice}<p className="field-hint">This explicitly freezes the selected week’s recorded commitments and timestamped completions at the reviewed workspace revision. Later task edits do not rewrite this snapshot. Corrections retain their predecessor.</p><Field label="Reflection"><textarea autoFocus rows={5} maxLength={10000} value={draft.reflection} onChange={event=>setDraft(current=>({...current,reflection:event.target.value}))}/></Field><Field label="Notes for next week"><textarea rows={4} maxLength={10000} value={draft.nextWeekNotes} onChange={event=>setDraft(current=>({...current,nextWeekNotes:event.target.value}))}/></Field>
 </FormDialog>;
}
