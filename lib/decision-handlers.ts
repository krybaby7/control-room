import {z} from 'zod';
import {OWNER_TABLES,type ModuleRow,type RegisteredOwnerTable} from './workspace-modules.ts';
import type {CommandHandler,PrepareContext,MutationPlan} from './workspace-transaction.ts';
import type {JsonValue} from './workspace-protocol.ts';
import {canonical,contentHash} from './canonical-json.ts';
import {versionRowId} from './version-identity.ts';
import {evidenceIdSchema,evidenceHeadSchema,evidenceVersionSchema} from './evidence-validation.ts';
import {evidenceRequirementSchema} from './evidence-requirements.ts';
import {createDecision,reviseDecision,decideDecision,archiveDecision,supersedeDecision,migrateCaptureDecision,decisionRecordSchema,decisionInputSchema,decisionExceptionSchema,decisionSubjectKey,decisionEvidenceKey,type DecisionContext,type DecisionRecord} from './decisions.ts';
import type {ReferenceSnapshot} from './workspace-references.ts';
const id=evidenceIdSchema,version=z.number().int().positive().safe();
const choice=z.object({selectedOptionId:id,rationale:z.string().min(1).max(10000).refine(v=>!!v.trim()),exception:decisionExceptionSchema.nullable().optional()}).strict();
/** Commands never accept owner, actor, timestamps, status, head or generated record IDs. */
export const decisionCommandSchema=z.discriminatedUnion('type',[
 z.object({type:z.literal('decisions.create'),value:decisionInputSchema}).strict(),
 z.object({type:z.literal('decisions.revise'),id,expectedVersion:version,value:decisionInputSchema}).strict(),
 z.object({type:z.literal('decisions.decide'),id,expectedVersion:version,choice}).strict(),
 z.object({type:z.literal('decisions.archive'),id,expectedVersion:version}).strict(),
 z.object({type:z.literal('decisions.restore'),id,expectedVersion:version}).strict(),
 z.object({type:z.literal('decisions.supersede'),id,expectedVersion:version,replacementId:id,expectedReplacementVersion:version,choice:choice.extend({reason:z.string().min(1).max(5000).refine(v=>!!v.trim())}).strict()}).strict(),
 z.object({type:z.literal('decisions.migrate-capture'),captureId:id}).strict(),
]);
async function read(ctx:PrepareContext){
 const tables=new Map<RegisteredOwnerTable,ModuleRow[]>(),snapshot:ReferenceSnapshot={coveredModules:[...OWNER_TABLES],rows:[],digest:''};let bytes=0,count=0;
 for(const table of OWNER_TABLES){const rows:ModuleRow[]=[];let after='';for(;;){const page=await ctx.query.list(table,{after,limit:200});if(page.length>200)throw new Error('Decision context page exceeds bound.');for(const row of page){if(row.id<=after||!Number.isSafeInteger(row.row_revision)||row.row_revision<1)throw new Error('Invalid owner module order or revision.');after=row.id;bytes+=new TextEncoder().encode(row.payload_json).length;if(++count>10000||bytes>8_000_000)throw new Error('Decision context exceeds read bound.');if(await contentHash(canonical(JSON.parse(row.payload_json)))!==row.content_hash)throw new Error('Decision context digest differs.');rows.push(row);snapshot.rows.push({module:table,id:row.id,rowRevision:row.row_revision,contentHash:row.content_hash,references:[]});}if(page.length<200)break;}tables.set(table,rows);}
 snapshot.digest=await contentHash(canonical({coveredModules:snapshot.coveredModules,rows:snapshot.rows}));
 const heads=tables.get('decision_records')!.map(row=>{const h=evidenceHeadSchema.parse(JSON.parse(row.payload_json));if(h.id!==row.id)throw new Error('Decision head key differs.');return h;});
 const versions=await Promise.all(tables.get('decision_versions')!.map(async row=>{const value=JSON.parse(row.payload_json);if(await versionRowId(value.id,value.version)!==row.id)throw new Error('Decision version key differs.');return value;}));
 const records=new Map<string,DecisionRecord>();for(const head of heads){const chain=decisionRecordSchema.parse({head,versions:versions.filter(v=>v.id===head.id).sort((a,b)=>a.version-b.version)});records.set(head.id,chain);}if(versions.some(v=>!records.has(v.id)))throw new Error('Decision version has no owner head.');
 const evidenceVersions=new Map();for(const row of tables.get('evidence_versions')!){const value=evidenceVersionSchema.parse(JSON.parse(row.payload_json));if(await versionRowId(value.id,value.version)!==row.id)throw new Error('Evidence version key differs.');evidenceVersions.set(decisionEvidenceKey(value),value);}
 const requirements=new Map();for(const row of tables.get('evidence_requirements')!){const value=evidenceRequirementSchema.parse(JSON.parse(row.payload_json));if(value.id!==row.id)throw new Error('Requirement key differs.');requirements.set(value.id,value);}
 const subjects=new Map();for(const [type,rows] of [['project',ctx.before.workspace.projects],['milestone',ctx.before.workspace.milestones],['task',ctx.before.workspace.tasks],['capture',ctx.before.workspace.captures]] as const)for(const row of rows){const subject={type,id:row.id};subjects.set(decisionSubjectKey(subject),subject);}
 const context:DecisionContext={now:ctx.now,subjects,evidenceVersions,requirements,records,captures:new Map(ctx.before.workspace.captures.map(c=>[c.id,c]))};return {tables,snapshot,context};
}
const handler:CommandHandler={async prepare(ctx){
 const command=decisionCommandSchema.parse(ctx.command),loaded=await read(ctx),context=loaded.context;
 const get=(recordId:string,expected:number)=>{const record=context.records.get(recordId);if(!record)throw new Error('Decision is missing for this owner.');if(record.head.currentVersion!==expected)throw new Error('Decision version conflict.');return record;};
 let results:DecisionRecord[];
 switch(command.type){
 case 'decisions.create':results=[createDecision(crypto.randomUUID(),command.value,context)];break;
 case 'decisions.revise':results=[reviseDecision(get(command.id,command.expectedVersion),command.expectedVersion,command.value,context)];break;
 case 'decisions.decide':results=[decideDecision(get(command.id,command.expectedVersion),command.expectedVersion,command.choice,context)];break;
 case 'decisions.archive':case 'decisions.restore':results=[archiveDecision(get(command.id,command.expectedVersion),command.type==='decisions.archive',context)];break;
 case 'decisions.supersede':{const result=supersedeDecision(get(command.id,command.expectedVersion),command.expectedVersion,get(command.replacementId,command.expectedReplacementVersion),command.expectedReplacementVersion,command.choice,context);results=[result.previous,result.replacement];break;}
 case 'decisions.migrate-capture':{const capture=context.captures.get(command.captureId);if(!capture)throw new Error('Capture is missing for this owner.');results=[await migrateCaptureDecision(capture,context)];break;}
 }
 const plan:MutationPlan={planningAfter:ctx.before.workspace,writes:[],jobs:[],events:[],referenceSnapshot:loaded.snapshot};
 for(const record of results){const prior=context.records.get(record.head.id),headRow=loaded.tables.get('decision_records')!.find(row=>row.id===record.head.id);
 if(!prior||canonical(prior.head)!==canonical(record.head))plan.writes.push({table:'decision_records',id:record.head.id,operation:headRow?'update':'insert',expectedRowRevision:headRow?.row_revision??null,value:record.head as unknown as JsonValue});
 for(const value of record.versions.filter(v=>v.version>(prior?.head.currentVersion??0)))plan.writes.push({table:'decision_versions',id:await versionRowId(value.id,value.version),operation:'insert',expectedRowRevision:null,value:value as unknown as JsonValue});
 const eventKind=command.type==='decisions.decide'?'decision.decide':command.type.replace('decisions.','decision.');
 plan.events.push({id:crypto.randomUUID(),kind:eventKind,entityType:'decision',entityId:record.head.id,changes:prior&&canonical(prior)===canonical(record)?[]:[{path:['record'],before:{exists:!!prior,value:(prior?{head:prior.head,version:prior.versions.at(-1)}:null) as unknown as JsonValue},after:{exists:true,value:{head:record.head,version:record.versions.at(-1)} as unknown as JsonValue}}],origin:'owner',actorId:ctx.userId,occurredAt:ctx.now,sourceRef:command.type==='decisions.migrate-capture'?command.captureId:null,undoOf:null});
 }
 return plan;
}};
export const decisionCommandHandlers:Map<string,CommandHandler>=new Map(['create','revise','decide','archive','restore','supersede','migrate-capture'].map(name=>[`decisions.${name}`,handler]));
