import type {PrepareContext,MutationPlan} from './workspace-transaction.ts';
import {parseAuditEvent,type AuditEventDraft} from './audit-events.ts';
import {canonical} from './canonical-json.ts';
import {evidenceCommandHandlers} from './evidence-handlers.ts';
import {evidenceHeadSchema,evidenceVersionSchema,evidenceInputSchema,evidenceLinkSchema} from './evidence-validation.ts';
import {attachmentRecordSchema} from './evidence-module.ts';
import {versionRowId} from './version-identity.ts';
import {readReferenceSnapshot,referenceRegistry,referenceImpact} from './workspace-references.ts';
const supported=new Set(['evidence.revise','evidence.archive','evidence.restore','evidence.link','evidence.unlink']);
/** Source events must be the complete owner-bound group resolved by the caller. No SQL is executed here. */
export async function prepareEvidenceUndo(context:PrepareContext,values:readonly AuditEventDraft[]):Promise<MutationPlan|null>{
 if(!values.some(event=>event.kind.startsWith('evidence.')))return null;
 if(!values.length||values.length>200||new TextEncoder().encode(canonical(values)).length>8_000_000)throw new Error('Evidence undo group exceeds limits.');
 const events=values.map(parseAuditEvent);
 if(new Set(events.map(e=>e.id)).size!==events.length||events.some(e=>!supported.has(e.kind)||e.origin!=='owner'||e.actorId!==context.userId||e.entityType!=='evidence'||!e.entityId))throw new Error('Unsupported or foreign evidence undo group requires specialized recovery.');
 const selected=typeof context.command.eventId==='string'?context.command.eventId:events[0].id;
 if(!events.some(e=>e.id===selected))throw new Error('Selected event is outside the source group.');
 const snapshot=await readReferenceSnapshot(context.query,referenceRegistry);
 if(referenceImpact(context.before.workspace,snapshot,referenceRegistry,{kind:'evidence',id:events[0].entityId!}).dangling.length)throw new Error('Repair dangling references before evidence undo.');
 const result:MutationPlan={planningAfter:context.before.workspace,writes:[],preconditions:[],events:[],jobs:[],referenceSnapshot:snapshot};
 const affected=new Set<string>();
 for(const event of [...events].reverse()){
  // Multiple inverses touching one logical head need a separate reviewed compound contract.
  if(affected.has(event.entityId!))throw new Error('Overlapping evidence undo operations are unsupported.');affected.add(event.entityId!);
  for(const change of event.changes){
   if(change.path.length!==2||!['evidence_records','evidence_versions','evidence_links'].includes(change.path[0]))throw new Error('Unsupported evidence audit shape.');
   const row=await context.query.get(change.path[0] as 'evidence_records',change.path[1]);
   if(change.after.exists!==!!row||row&&canonical(JSON.parse(row.payload_json))!==canonical(change.after.value))throw new Error('Evidence affected state changed since the source command.');
  }
  let command:PrepareContext['command'];let restoredId:string|undefined;
  if(event.kind==='evidence.revise'){
   if(event.changes.length!==2)throw new Error('Unsupported revision audit shape.');
   const headChange=event.changes.find(c=>c.path[0]==='evidence_records'&&c.path[1]===event.entityId);
   if(!headChange?.before.exists||!headChange.after.exists)throw new Error('Revision has no exact prior head.');
   const prior=evidenceHeadSchema.parse(headChange.before.value),after=evidenceHeadSchema.parse(headChange.after.value);
   if(prior.id!==event.entityId||after.id!==prior.id||after.currentVersion!==prior.currentVersion+1||prior.archivedAt!==null||after.archivedAt!==null)throw new Error('Invalid revision head transition.');
   const versionChange=event.changes.find(c=>c.path[0]==='evidence_versions');
   if(!versionChange||versionChange.before.exists||versionChange.path[1]!==await versionRowId(prior.id,after.currentVersion))throw new Error('Invalid immutable revision transition.');
   const changed=evidenceVersionSchema.parse(versionChange.after.value);if(changed.id!==prior.id||changed.version!==after.currentVersion)throw new Error('Invalid source version identity.');
   const row=await context.query.get('evidence_versions',await versionRowId(prior.id,prior.currentVersion));if(!row)throw new Error('Prior exact version is unavailable.');
   const previous=evidenceVersionSchema.parse(JSON.parse(row.payload_json));if(previous.id!==prior.id||previous.version!==prior.currentVersion)throw new Error('Prior version identity mismatch.');
   const {id: _id,version: _version,recordedAt: _recordedAt,supersedesVersion: _supersedes,...input}=previous;void _id;void _version;void _recordedAt;void _supersedes;
   command={type:'evidence.revise',id:prior.id,expectedVersion:after.currentVersion,value:evidenceInputSchema.parse(input)};
  }else if(event.kind==='evidence.archive'||event.kind==='evidence.restore'){
   const change=event.changes[0];if(event.changes.length!==1||change.path[0]!=='evidence_records'||!change.before.exists||!change.after.exists)throw new Error('Invalid archive audit shape.');
   const before=evidenceHeadSchema.parse(change.before.value),after=evidenceHeadSchema.parse(change.after.value);
   if(before.id!==event.entityId||after.id!==before.id||before.currentVersion!==after.currentVersion||before.archivedAt===after.archivedAt)throw new Error('Invalid archive transition.');
   command={type:before.archivedAt===null?'evidence.restore':'evidence.archive',id:before.id};
  }else{
   const change=event.changes[0];if(event.changes.length!==1||change.path[0]!=='evidence_links')throw new Error('Unsupported link undo audit shape.');
   const restore=event.kind==='evidence.unlink';if(change.before.exists!==restore||change.after.exists===restore)throw new Error('Invalid link transition.');
   const link=evidenceLinkSchema.parse(restore?change.before.value:change.after.value);if(link.id!==change.path[1]||link.evidenceId!==event.entityId)throw new Error('Link identity mismatch.');
   const versionRow=await context.query.get('evidence_versions',await versionRowId(link.evidenceId,link.evidenceVersion));if(!versionRow)throw new Error('Exact linked version unavailable.');
   const version=evidenceVersionSchema.parse(JSON.parse(versionRow.payload_json));if(version.id!==link.evidenceId||version.version!==link.evidenceVersion)throw new Error('Linked version identity mismatch.');
   for(const id of version.attachmentIds){const row=await context.query.get('attachments',id);if(!row)throw new Error('Attachment unavailable.');const file=attachmentRecordSchema.parse(JSON.parse(row.payload_json));if(file.id!==id||file.status!=='ready')throw new Error('Attachment not ready.');}
   const {id,...value}=link;
   // Reuse the complete live link validator while excluding only the exact row being removed.
   const query=restore?context.query:{get:context.query.get.bind(context.query),list:async(table:Parameters<typeof context.query.list>[0],options:Parameters<typeof context.query.list>[1])=>{
    const limit=options?.limit??200;let after=options?.after;const found=[];
    while(found.length<limit){const page=await context.query.list(table,{after,limit:limit-found.length});if(!page.length)break;for(const row of page){after=row.id;if(table!=='evidence_links'||row.id!==id)found.push(row);}if(page.length<limit-found.length)break;}
    return found;
   }};
   await evidenceCommandHandlers.get('evidence.link')!.prepare({...context,query,command:{type:'evidence.link',value}});
   command=restore?{type:'evidence.link',value}:{type:'evidence.unlink',id};if(restore)restoredId=id;
  }
  const plan=await evidenceCommandHandlers.get(command.type)!.prepare({...context,command});
  if(restoredId){const write=plan.writes[0];write.id=restoredId;write.value={...write.value as object,id:restoredId};plan.events[0].changes[0].path[1]=restoredId;plan.events[0].changes[0].after.value=write.value;}
  if(event.kind==='evidence.restore'){const before=evidenceHeadSchema.parse(event.changes[0].before.value);plan.writes[0].value=before;plan.events[0].changes[0].after.value=before;}
  result.writes.push(...plan.writes);result.preconditions!.push(...plan.preconditions??[]);
  for(const audit of plan.events)result.events.push(parseAuditEvent({...audit,kind:'history.undo',sourceRef:selected,undoOf:selected}));
 }
 return result;
}
