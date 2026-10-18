import {z} from 'zod';
import {canonical,contentHash} from '../../canonical-json.ts';
import {evidenceDateSchema} from '../../evidence-validation.ts';
import {SOURCE_LIMITS,SourceReadError,type SourceAdapter,type SourceObservation,type SourcePage,type SourceTarget} from '../contracts.ts';
import {sourceTargetSchema,sourceUrlSchema,sourceObservationSchema,sourcePageSchema} from '../validation.ts';
const external=z.string().min(1).max(512).refine(value=>value===value.trim()&&!/[\u0000-\u001f\u007f]/u.test(value));
const message=z.object({id:external,speaker:z.string().min(1).max(200),timestamp:evidenceDateSchema.nullable(),text:z.string().max(SOURCE_LIMITS.payloadBytes),url:sourceUrlSchema.nullable()}).strict();
export const conversationExportSchema=z.object({version:z.literal(1),kind:z.literal('conversation-export'),sourceId:external,selectedMessageIds:z.array(external).min(1).max(SOURCE_LIMITS.pageObservations).refine(ids=>new Set(ids).size===ids.length),messages:z.array(message).max(1000)}).strict();
/** Manual data only. The caller supplies its actual server observation clock. No source write occurs. */
export async function parseConversationExport(target:SourceTarget,raw:Uint8Array,observedAt:string):Promise<SourcePage>{
 try{
  const selected=sourceTargetSchema.parse(target);evidenceDateSchema.parse(observedAt);if(selected.kind!=='conversation_export'||selected.archivedAt!==null||selected.selectedPaths.length)throw new Error('Select a live conversation export resource.');
  if(!(raw instanceof Uint8Array)||raw.byteLength>SOURCE_LIMITS.pageBytes)throw new Error('Conversation export exceeds 2 MiB.');
  const data=conversationExportSchema.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)));if(data.sourceId!==selected.providerResourceId)throw new Error('Conversation export source differs from the selected resource.');
  const records=new Map<string,z.infer<typeof message>>();for(const record of data.messages){const prior=records.get(record.id);if(prior&&canonical(prior)!==canonical(record))throw new Error('A message identity has conflicting revisions in this export.');records.set(record.id,record);}
  const observations:SourceObservation[]=[];for(const id of data.selectedMessageIds){const record=records.get(id);if(!record)throw new Error('A selected message is missing.');const payload={formatVersion:1,resourceId:data.sourceId,messageId:id,speaker:record.speaker,originalTimestamp:record.timestamp,text:record.text,sourceUrl:record.url,limitations:['Selected manual export only; no automatic conversation refresh or independent verification.']};const contentDigest=await contentHash(canonical(payload)),identity=await contentHash(canonical({sourceId:selected.id,resourceId:data.sourceId,messageId:id,contentDigest}));
   observations.push(sourceObservationSchema.parse({id:`source_${identity}`,sourceId:selected.id,externalId:id,sourceRevision:contentDigest,sourceUpdatedAt:record.timestamp,observedAt,title:`Conversation message · ${record.speaker}`.slice(0,500),canonicalUrl:record.url??selected.canonicalUrl,contentDigest,payload,origin:'manual-import'}));
  }return sourcePageSchema.parse({observations,nextCursor:null,nextEtag:null,unchanged:false});
 }catch(error){throw new SourceReadError('invalid_content',error instanceof Error&&!(error instanceof SyntaxError)&&!('issues'in error)?error.message:'The selected conversation export is invalid.');}
}
export const conversationExportAdapter:SourceAdapter={async capabilities(){return {sourceKinds:['conversation_export'],interactiveRead:false,unattendedRead:false,verifiedAt:null,blockedReason:'Automatic conversation reads are unsupported. Import an explicitly selected manual export.'};},async readPage(){throw new SourceReadError('unsupported','Automatic conversation refresh is unavailable without a verified supported API.');}};
