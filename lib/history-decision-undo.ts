import {z} from 'zod';
import type {PrepareContext,MutationPlan} from './workspace-transaction.ts';
import {parseAuditEvent,type AuditEventDraft} from './audit-events.ts';
import {canonical} from './canonical-json.ts';
import {evidenceHeadSchema} from './evidence-validation.ts';
import {decisionVersionSchema,decisionInputSchema} from './decisions.ts';
import {decisionCommandHandlers} from './decision-handlers.ts';
import {versionRowId} from './version-identity.ts';
import {readReferenceSnapshot,referenceRegistry,referenceImpact} from './workspace-references.ts';
const pair=z.object({head:evidenceHeadSchema,version:decisionVersionSchema}).strict().refine(v=>v.head.id===v.version.id&&v.head.currentVersion===v.version.version,'Decision audit identity mismatch.');
const supported=new Set(['decision.revise','decision.archive','decision.restore']);
/** The caller supplies the complete immutable owner command group, never an event subset. */
export async function prepareDecisionUndo(context:PrepareContext,values:readonly AuditEventDraft[]):Promise<MutationPlan|null>{
 if(!values.some(e=>e.kind.startsWith('decision.')))return null;
 if(!values.length||values.length>200||new TextEncoder().encode(canonical(values)).length>8_000_000)throw new Error('Decision undo command exceeds bounds.');
 const events=values.map(parseAuditEvent);
 if(new Set(events.map(e=>e.id)).size!==events.length||events.some(e=>!supported.has(e.kind)||e.entityType!=='decision'||!e.entityId||e.origin!=='owner'||e.actorId!==context.userId))throw new Error('Unsupported or foreign decision undo group. Make a fresh owner decision or use explicit recovery.');
 const selected=typeof context.command.eventId==='string'?context.command.eventId:events[0].id;if(!events.some(e=>e.id===selected))throw new Error('Selected event is outside the source group.');
 const snapshot=await readReferenceSnapshot(context.query,referenceRegistry);
 if(referenceImpact(context.before.workspace,snapshot,referenceRegistry,{kind:'decision',id:events[0].entityId!}).dangling.length)throw new Error('Repair dangling references before decision undo.');
 const result:MutationPlan={planningAfter:context.before.workspace,writes:[],jobs:[],events:[],referenceSnapshot:snapshot};const seen=new Set<string>();
 for(const event of [...events].reverse()){
  if(seen.has(event.entityId!))throw new Error('Overlapping decision undo operations require explicit recovery.');seen.add(event.entityId!);
  const change=event.changes[0];if(event.changes.length!==1||change.path.length!==1||change.path[0]!=='record'||!change.before.exists||!change.after.exists)throw new Error('Unsupported decision audit shape.');
  const before=pair.parse(change.before.value),after=pair.parse(change.after.value);
  if(before.head.id!==event.entityId||after.head.id!==event.entityId)throw new Error('Decision source identity mismatch.');
  const head=await context.query.get('decision_records',event.entityId!),version=await context.query.get('decision_versions',await versionRowId(event.entityId!,after.head.currentVersion));
  if(!head||!version||canonical(JSON.parse(head.payload_json))!==canonical(after.head)||canonical(JSON.parse(version.payload_json))!==canonical(after.version))throw new Error('Decision affected head or exact version changed.');
  let command:PrepareContext['command'];
  if(event.kind==='decision.revise'){
   if(after.head.currentVersion!==before.head.currentVersion+1||before.head.archivedAt!==null||after.head.archivedAt!==null)throw new Error('Invalid decision revision transition.');
   const prior=await context.query.get('decision_versions',await versionRowId(event.entityId!,before.head.currentVersion));if(!prior||canonical(JSON.parse(prior.payload_json))!==canonical(before.version))throw new Error('Prior exact decision version is unavailable.');
   const input=Object.fromEntries((['title','question','options','selectedOptionId','rationale','reviewOn','subjects','evidenceRefs','sourceCaptureId','sourceUrl','supersedesDecisionId'] as const).map(key=>[key,before.version[key as keyof typeof before.version]]));
   command={type:'decisions.revise',id:event.entityId!,expectedVersion:after.head.currentVersion,value:decisionInputSchema.parse(input)};
  }else{
   if(canonical(before.version)!==canonical(after.version)||before.head.currentVersion!==after.head.currentVersion||before.head.archivedAt===after.head.archivedAt||event.kind==='decision.archive'&&(before.head.archivedAt!==null||after.head.archivedAt===null)||event.kind==='decision.restore'&&(before.head.archivedAt===null||after.head.archivedAt!==null))throw new Error('Invalid decision archive transition.');
   command={type:before.head.archivedAt===null?'decisions.restore':'decisions.archive',id:event.entityId!,expectedVersion:after.head.currentVersion};
  }
  const plan=await decisionCommandHandlers.get(command.type)!.prepare({...context,command});
  if(event.kind==='decision.restore'){const write=plan.writes.find(w=>w.table==='decision_records');if(!write)throw new Error('Archive inverse did not prepare a head.');write.value=before.head;const afterValue=plan.events[0].changes[0].after.value as {head:unknown};afterValue.head=before.head;}
  if(event.kind==='decision.revise')for(const write of plan.writes)if(write.table==='decision_versions'){const next=decisionVersionSchema.parse(write.value);if(next.status!=='draft'||next.exception!==null||next.decidedAt!==null)throw new Error('Decision undo must append a draft without authority.');}
  result.writes.push(...plan.writes);for(const audit of plan.events)result.events.push(parseAuditEvent({...audit,kind:'history.undo',sourceRef:selected,undoOf:selected}));
 }
 return result;
}
