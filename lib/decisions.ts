import {z} from 'zod';
import type {Capture} from './types.ts';
import {EVIDENCE_LIMITS,type DecisionInput,type DecisionVersion,type EvidenceSubject,type EvidenceVersion,type EvidenceRequirement,type VersionedRecordHead} from './evidence-contract.ts';
const id=z.string().min(1).max(128).refine(value=>value.trim()===value);
const stamp=z.string().datetime({offset:true});
const day=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value=>{try{return new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)===value;}catch{return false;}});
const scope=z.enum(['implementation','software-verification','physical-acceptance','operation','release-acceptance','economics']);
const sourceUrl=z.string().max(EVIDENCE_LIMITS.urlCharacters).refine(value=>{try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&!/[\u0000-\u0020\u007f]/.test(value);}catch{return false;}}).nullable();
export const decisionSubjectSchema=z.object({type:z.enum(['project','milestone','task','capture']),id}).strict();
export const decisionEvidenceRefSchema=z.object({id,version:z.number().int().positive().safe()}).strict();
export const decisionOptionSchema=z.object({id,label:z.string().min(1).max(200).refine(value=>!!value.trim()),description:z.string().max(10000)}).strict();
export const decisionExceptionSchema=z.object({scope,expiresAt:stamp,requirementIds:z.array(id).min(1).max(200).refine(values=>new Set(values).size===values.length)}).strict();
export const decisionInputSchema=z.object({title:z.string().min(1).max(EVIDENCE_LIMITS.titleCharacters).refine(value=>!!value.trim()),question:z.string().max(10000),options:z.array(decisionOptionSchema).max(EVIDENCE_LIMITS.optionsPerDecision),selectedOptionId:id.nullable(),rationale:z.string().max(10000),reviewOn:day.nullable(),subjects:z.array(decisionSubjectSchema).max(EVIDENCE_LIMITS.subjectLinksPerDecision),evidenceRefs:z.array(decisionEvidenceRefSchema).max(EVIDENCE_LIMITS.subjectLinksPerDecision),sourceCaptureId:id.nullable(),sourceUrl,supersedesDecisionId:id.nullable()}).strict().superRefine((value,ctx)=>{
 if(new Set(value.options.map(option=>option.id)).size!==value.options.length)ctx.addIssue({code:'custom',message:'Duplicate decision option.'});
 if(value.selectedOptionId&&!value.options.some(option=>option.id===value.selectedOptionId))ctx.addIssue({code:'custom',message:'Selected option is unavailable.'});
 if(new Set(value.subjects.map(decisionSubjectKey)).size!==value.subjects.length||new Set(value.evidenceRefs.map(decisionEvidenceKey)).size!==value.evidenceRefs.length)ctx.addIssue({code:'custom',message:'Duplicate decision reference.'});
});
export const decisionVersionSchema=z.object({id,version:z.number().int().positive().safe(),title:z.string(),question:z.string(),options:z.array(decisionOptionSchema),selectedOptionId:id.nullable(),rationale:z.string(),status:z.enum(['draft','decided','superseded']),decidedAt:stamp.nullable(),reviewOn:day.nullable(),subjects:z.array(decisionSubjectSchema),evidenceRefs:z.array(decisionEvidenceRefSchema),sourceCaptureId:id.nullable(),sourceUrl,supersedesDecisionId:id.nullable(),supersedesVersion:z.number().int().positive().safe().nullable(),recordedAt:stamp,exception:decisionExceptionSchema.nullable()}).strict().superRefine((value,ctx)=>{
 const {id:recordId,version,status,decidedAt,recordedAt,supersedesVersion,exception,...input}=value;void recordId;
 if(!decisionInputSchema.safeParse(input).success)ctx.addIssue({code:'custom',message:'Invalid decision input fields.'});
 if((version===1&&supersedesVersion!==null)||(version>1&&supersedesVersion!==version-1))ctx.addIssue({code:'custom',message:'Invalid decision version predecessor.'});
 if(status==='draft'&&(decidedAt!==null||exception!==null)||status!=='draft'&&(!decidedAt||!value.selectedOptionId||!value.rationale.trim()||!value.question.trim()))ctx.addIssue({code:'custom',message:'Decision authority requires explicit choice and rationale.'});
 if(decidedAt&&Date.parse(decidedAt)>Date.parse(recordedAt))ctx.addIssue({code:'custom',message:'Decision date cannot be in the future of its server record.'});
});
const headSchema=z.object({id,currentVersion:z.number().int().positive().safe(),archivedAt:stamp.nullable()}).strict();
export const decisionRecordSchema=z.object({head:headSchema,versions:z.array(decisionVersionSchema).min(1).max(10000)}).strict().superRefine((value,ctx)=>{
 if(value.versions.length!==value.head.currentVersion||value.versions.some((version,index)=>version.id!==value.head.id||version.version!==index+1||index>0&&Date.parse(version.recordedAt)<Date.parse(value.versions[index-1].recordedAt)))ctx.addIssue({code:'custom',message:'Decision version chain differs from its head.'});
});
export interface DecisionRecord {head:VersionedRecordHead;versions:DecisionVersion[]}
export interface DecisionContext {now:string;subjects:ReadonlyMap<string,EvidenceSubject>;evidenceVersions:ReadonlyMap<string,EvidenceVersion>;requirements:ReadonlyMap<string,EvidenceRequirement>;records:ReadonlyMap<string,DecisionRecord>;captures:ReadonlyMap<string,Capture>}
export function decisionSubjectKey(value:EvidenceSubject):string{return `${value.type}:${value.id}`;}
export function decisionEvidenceKey(value:{id:string;version:number}):string{return `${value.id}:${value.version}`;}
function validateClock(context:DecisionContext,previous?:DecisionVersion){stamp.parse(context.now);if(previous&&Date.parse(previous.recordedAt)>Date.parse(context.now))throw new Error('Server time precedes the previous decision record.');}
function ownedInput(value:unknown,context:DecisionContext):DecisionInput {
 const input=decisionInputSchema.parse(value);
 for(const subject of input.subjects){const found=context.subjects.get(decisionSubjectKey(subject));if(!found||found.type!==subject.type||found.id!==subject.id)throw new Error('Decision subject is missing or unavailable.');}
 for(const ref of input.evidenceRefs){const evidence=context.evidenceVersions.get(decisionEvidenceKey(ref));if(!evidence||evidence.id!==ref.id||evidence.version!==ref.version)throw new Error('Decision evidence version is missing or unavailable.');}
 if(input.sourceCaptureId&&!context.captures.has(input.sourceCaptureId))throw new Error('Source capture is missing or unavailable.');
 if(input.supersedesDecisionId&&!context.records.has(input.supersedesDecisionId))throw new Error('Superseded decision is missing or unavailable.');return input;
}
function ownedRecord(record:DecisionRecord,context:DecisionContext){const found=context.records.get(record.head.id);if(!found||JSON.stringify(decisionRecordSchema.parse(found))!==JSON.stringify(decisionRecordSchema.parse(record)))throw new Error('Decision record is missing, changed or unavailable.');}
function current(record:DecisionRecord,expectedVersion:number):DecisionVersion {
 const parsed=decisionRecordSchema.parse(record);if(parsed.head.currentVersion!==expectedVersion)throw new Error('Decision version conflict.');if(parsed.head.archivedAt)throw new Error('Restore the decision before changing it.');return parsed.versions[parsed.versions.length-1];
}
function cycle(records:ReadonlyMap<string,DecisionRecord>,newId:string,target:string|null){const seen=new Set([newId]);let cursor=target;while(cursor){if(seen.has(cursor))throw new Error('Decision supersession cycle.');seen.add(cursor);const found=records.get(cursor);if(!found)throw new Error('Superseded decision is missing or unavailable.');const parsed=decisionRecordSchema.parse(found);cursor=parsed.versions[parsed.versions.length-1].supersedesDecisionId;}}
function append(record:DecisionRecord,value:DecisionVersion):DecisionRecord{return decisionRecordSchema.parse({head:{...record.head,currentVersion:value.version},versions:[...structuredClone(record.versions),value]});}
export function createDecision(recordId:string,value:unknown,context:DecisionContext):DecisionRecord {
 id.parse(recordId);validateClock(context);if(context.records.has(recordId))throw new Error('Decision ID already exists.');const input=ownedInput(value,context);cycle(context.records,recordId,input.supersedesDecisionId);
 return decisionRecordSchema.parse({head:{id:recordId,currentVersion:1,archivedAt:null},versions:[{...input,id:recordId,version:1,status:'draft',decidedAt:null,recordedAt:context.now,supersedesVersion:null,exception:null}]});
}
export function reviseDecision(record:DecisionRecord,expectedVersion:number,value:unknown,context:DecisionContext):DecisionRecord {
 ownedRecord(record,context);const previous=current(record,expectedVersion);validateClock(context,previous);if(previous.status==='superseded')throw new Error('A superseded decision remains historical. Create a separate draft.');const input=ownedInput(value,context);if(input.sourceCaptureId!==previous.sourceCaptureId)throw new Error('Retain the original source capture link.');cycle(context.records,record.head.id,input.supersedesDecisionId);
 return append(record,{...input,id:record.head.id,version:expectedVersion+1,status:'draft',decidedAt:null,recordedAt:context.now,supersedesVersion:expectedVersion,exception:null});
}
const choiceSchema=z.object({selectedOptionId:id,rationale:z.string().min(1).max(10000).refine(value=>!!value.trim()),exception:decisionExceptionSchema.nullable().optional()}).strict();
export type DecisionChoice=z.infer<typeof choiceSchema>;
function decidedVersion(previous:DecisionVersion,value:unknown,context:DecisionContext):DecisionVersion {
 validateClock(context,previous);const choice=choiceSchema.parse(value);if(previous.status==='superseded')throw new Error('A superseded decision cannot decide new work.');ownedInput(inputOf(previous),context);if(!previous.question.trim()||!previous.options.some(option=>option.id===choice.selectedOptionId))throw new Error('Choose one recorded option for a nonempty decision question.');const exception=choice.exception??null;
 if(exception){if(Date.parse(exception.expiresAt)<=Date.parse(context.now))throw new Error('Decision exception expiry must be in the future.');for(const requirementId of exception.requirementIds){const requirement=context.requirements.get(requirementId);if(!requirement||requirement.id!==requirementId||requirement.archivedAt||!requirement.required||requirement.scope!==exception.scope||!previous.subjects.some(subject=>decisionSubjectKey(subject)===decisionSubjectKey(requirement.subject)))throw new Error('Exception must name current required criteria in this exact scope and linked subject.');}}
 return {...structuredClone(previous),version:previous.version+1,status:'decided',selectedOptionId:choice.selectedOptionId,rationale:choice.rationale,decidedAt:context.now,recordedAt:context.now,supersedesVersion:previous.version,exception};
}
function inputOf(value:DecisionVersion):DecisionInput {const {id:recordId,version,status,decidedAt,recordedAt,supersedesVersion,exception,...input}=value;void recordId;void version;void status;void decidedAt;void recordedAt;void supersedesVersion;void exception;return input;}
export function decideDecision(record:DecisionRecord,expectedVersion:number,value:unknown,context:DecisionContext):DecisionRecord {ownedRecord(record,context);return append(record,decidedVersion(current(record,expectedVersion),value,context));}
export function archiveDecision(record:DecisionRecord,archive:boolean,context:DecisionContext):DecisionRecord {ownedRecord(record,context);const parsed=decisionRecordSchema.parse(record);validateClock(context,parsed.versions[parsed.versions.length-1]);return {...parsed,head:{...parsed.head,archivedAt:archive?parsed.head.archivedAt??context.now:null}};}
export function supersedeDecision(previous:DecisionRecord,expectedPrevious:number,replacement:DecisionRecord,expectedReplacement:number,value:unknown,context:DecisionContext):{previous:DecisionRecord;replacement:DecisionRecord}{
 ownedRecord(previous,context);ownedRecord(replacement,context);const input=z.object({selectedOptionId:id,rationale:z.string().min(1).max(10000),reason:z.string().min(1).max(5000).refine(value=>!!value.trim()),exception:decisionExceptionSchema.nullable().optional()}).strict().parse(value);const old=current(previous,expectedPrevious),draft=current(replacement,expectedReplacement);if(old.status!=='decided'||draft.status!=='draft'||old.id===draft.id)throw new Error('Supersession requires a decided source and a separate replacement draft.');validateClock(context,old);if(!context.records.has(old.id)||!context.records.has(draft.id))throw new Error('Supersession records must belong to this owner.');cycle(context.records,draft.id,old.id);
 const replacementVersion=decidedVersion({...draft,supersedesDecisionId:old.id},{selectedOptionId:input.selectedOptionId,rationale:`${input.rationale}\n\nSupersedes ${old.id}: ${input.reason}`,exception:input.exception??null},context);
 const historical={...structuredClone(old),version:old.version+1,status:'superseded' as const,rationale:`${old.rationale}\n\nSuperseded by ${draft.id}: ${input.reason}`,recordedAt:context.now,supersedesVersion:old.version};
 return {previous:append(previous,historical),replacement:append(replacement,replacementVersion)};
}
export async function captureDecisionId(captureId:string):Promise<string>{id.parse(captureId);const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(captureId)));return `decision_capture_${Array.from(hash,value=>value.toString(16).padStart(2,'0')).join('')}`;}
export async function migrateCaptureDecision(capture:Capture,context:DecisionContext):Promise<DecisionRecord>{
 const source=context.captures.get(capture.id);if(!source||JSON.stringify(source)!==JSON.stringify(capture)||capture.kind!=='decision')throw new Error('Decision capture is missing or unavailable.');const recordId=await captureDecisionId(capture.id);const existing=context.records.get(recordId);if(existing){const parsed=decisionRecordSchema.parse(existing);if(parsed.versions[0].sourceCaptureId!==capture.id)throw new Error('Capture migration identity conflict.');return parsed;}
 return createDecision(recordId,{title:capture.title,question:capture.body,options:[],selectedOptionId:null,rationale:'',reviewOn:null,subjects:[{type:'capture',id:capture.id}],evidenceRefs:[],sourceCaptureId:capture.id,sourceUrl:capture.sourceUrl,supersedesDecisionId:null},context);
}
