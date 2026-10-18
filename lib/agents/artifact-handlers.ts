import {z} from 'zod';
import type {CommandHandler,PrepareContext} from '../workspace-transaction.ts';
import {attachmentCommandHandlers} from '../attachment-handlers.ts';
import {validateAttachmentMetadata} from '../attachment-policy.ts';
import {agentDigestSchema} from './contracts.ts';
import {agentArtifactTypeSchema,AGENT_ARTIFACT_LIMITS} from './artifacts.ts';
import {AgentArtifactStoreError} from './artifact-store.ts';
export const agentArtifactReserveValueSchema=z.object({filename:z.string().min(1).max(240),mimeType:z.enum(['text/plain','application/json']),expectedBytes:z.number().int().nonnegative().max(AGENT_ARTIFACT_LIMITS.packageBytes)}).strict();
export const agentArtifactCommandSchema=z.discriminatedUnion('type',[
 z.object({type:z.literal('jobs.artifact.reserve'),value:agentArtifactReserveValueSchema,logicalType:agentArtifactTypeSchema,sha256:agentDigestSchema}).strict(),
 z.object({type:z.literal('jobs.artifact.finalize'),id:z.string().uuid()}).strict(),
]);
function material(ctx:PrepareContext){const value=ctx.agentArtifact;if(!value||!value.guard||typeof value.guard.sql!=='string'||!value.guard.sql||!Array.isArray(value.guard.bindings))throw new AgentArtifactStoreError('private_artifact_material_required',403);return value;}
export function validateAgentArtifactMetadata(value:z.infer<typeof agentArtifactReserveValueSchema>,logicalType:z.infer<typeof agentArtifactTypeSchema>){
 const metadata=validateAttachmentMetadata(value),extension=metadata.filename.slice(metadata.filename.lastIndexOf('.')+1).toLowerCase();if(logicalType==='transcript'&&metadata.expectedBytes>AGENT_ARTIFACT_LIMITS.transcriptBytes||logicalType==='patch'&&(metadata.mimeType!=='text/plain'||extension!=='txt')||logicalType==='transcript'&&(metadata.mimeType!=='text/plain'||!['txt','log'].includes(extension)))throw new AgentArtifactStoreError('artifact_type_or_size_invalid',400);return metadata;
}
const handler:CommandHandler={async prepare(ctx){
 const command=agentArtifactCommandSchema.parse(ctx.command),proof=material(ctx);
 if(command.type==='jobs.artifact.reserve'){
  const value=validateAgentArtifactMetadata(command.value,command.logicalType);
  if(proof.logicalType!==command.logicalType||proof.sha256!==command.sha256||proof.bytes!==value.expectedBytes)throw new AgentArtifactStoreError('private_artifact_material_differs',403);
  const delegated=await attachmentCommandHandlers.get('attachment.reserve')!.prepare({...ctx,command:{type:'attachment.reserve',value}});
  return {...delegated,events:delegated.events.map(event=>({...event,kind:command.type,origin:'connector' as const,actorId:ctx.userId,sourceRef:proof.attemptId}))};
 }
 const delegated=await attachmentCommandHandlers.get('attachment.finalize')!.prepare({...ctx,command:{type:'attachment.finalize',id:command.id}});
 const attachment=delegated.writes.find(write=>write.table==='attachments'&&write.id===command.id)?.value as {status?:unknown;sha256?:unknown;actualBytes?:unknown}|undefined;
 if(!attachment||attachment.status!=='ready'||attachment.sha256!==proof.sha256||attachment.actualBytes!==proof.bytes)throw new AgentArtifactStoreError('artifact_final_bytes_differ',409);
 return {...delegated,events:delegated.events.map(event=>({...event,kind:command.type,origin:'connector' as const,actorId:ctx.userId,sourceRef:proof.attemptId}))};
}};
/** Server-only map extension. Never add these device commands to global owner handlers. */
export const agentArtifactCommandHandlers:ReadonlyMap<string,CommandHandler>=new Map(['jobs.artifact.reserve','jobs.artifact.finalize'].map(type=>[type,handler]));
