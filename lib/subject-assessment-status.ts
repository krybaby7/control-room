import {z} from 'zod';
import {evidenceDateSchema,evidenceIdSchema} from './evidence-validation.ts';
const subject=z.object({type:z.enum(['task','milestone']),id:evidenceIdSchema}).strict();
export const subjectAssessmentStatusSchema=z.object({revision:z.number().int().positive().safe(),subject,planningStatus:z.enum(['proposed','todo','doing','review','done','archived','planned','active','achieved']),assessment:z.object({id:evidenceIdSchema,decision:z.enum(['accepted','rejected','needs-review']),recordedAt:evidenceDateSchema,authority:z.enum(['owner','contextual'])}).strict().nullable(),needsReview:z.boolean(),reasons:z.array(z.string().min(1).max(1000)).max(200)}).strict();
export type SubjectAssessmentStatus=z.infer<typeof subjectAssessmentStatusSchema>;
export interface SubjectAssessmentPresentation {label:string;detail:string;reasons:string[]}
/** Server-derived freshness and authority only; this function neither infers file availability nor changes planning status. */
export function subjectAssessmentPresentation(value:SubjectAssessmentStatus):SubjectAssessmentPresentation{
 const record=value.assessment;
 if(!record)return {label:value.planningStatus==='done'||value.planningStatus==='achieved'?'Recorded before structured acceptance':'No structured assessment recorded',detail:'The saved planning status is unchanged. Review evidence to record an explicit assessment.',reasons:value.reasons};
 if(record.authority==='contextual')return {label:value.needsReview?'Acceptance needs review':'Historical assessment · context only',detail:'This historical assessment does not establish a current owner acceptance.',reasons:value.reasons};
 if(value.needsReview||record.decision==='needs-review')return {label:'Acceptance needs review',detail:'The historical assessment is retained. Its findings do not change the saved planning status.',reasons:value.reasons};
 return {label:record.decision==='accepted'?'Owner acceptance recorded':'Owner rejection recorded',detail:'This records the owner’s assessment; attachment availability and physical acceptance require their own review.',reasons:value.reasons};
}
export function parseSubjectAssessmentStatus(raw:unknown,expected:{subject:{type:'task'|'milestone';id:string};planningStatus:string;revision?:number}):SubjectAssessmentStatus{
 const value=subjectAssessmentStatusSchema.parse(raw);if(value.subject.type!==expected.subject.type||value.subject.id!==expected.subject.id||value.planningStatus!==expected.planningStatus||(expected.revision!==undefined&&value.revision!==expected.revision))throw new Error('The saved subject changed. Refresh before reviewing acceptance.');return value;
}

/** The enclosing boundedRequest supplies the end-to-end fetch/body deadline. */
export async function readSubjectAssessmentStatus(response:Response,expected:Parameters<typeof parseSubjectAssessmentStatus>[1]):Promise<SubjectAssessmentStatus>{
 if(!response.ok||!response.body)throw new Error('Assessment status is unavailable.');
 const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let bytes=0,text='';try{for(;;){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>500_000){void reader.cancel().catch(()=>{});throw new Error('Assessment status exceeds its bound.');}text+=decoder.decode(chunk.value,{stream:true});}text+=decoder.decode();return parseSubjectAssessmentStatus(JSON.parse(text),expected);}finally{reader.releaseLock();}
}
