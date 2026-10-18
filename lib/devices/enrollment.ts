import {z} from 'zod';
import type {SqlDatabase} from '../workspace-store.ts';
import {readCurrent} from '../workspace-store.ts';
import {executeWorkspaceCommand} from '../workspace-transaction.ts';
import {workspaceHandlers} from '../workspace-handlers.ts';
import {contentHash} from '../canonical-json.ts';
import {deviceDisplaySchema,deviceIdSchema} from './validation.ts';
import {DEVICE_LIMITS} from './contracts.ts';
const requestSchema=z.object({type:z.literal('devices.enrollment.create'),value:z.object({label:deviceDisplaySchema.shape.label,deviceId:deviceIdSchema.optional(),scopes:z.tuple([z.literal('telemetry:write')])}).strict()}).strict();
/** Plaintext exists only in this invocation and its first successful response. Never persist it. */
export async function createOwnerEnrollment(db:SqlDatabase,userId:string,input:{revision:number;mutationId:string;command:unknown},now:string){
 const command=requestSchema.parse(input.command),secret=Array.from(crypto.getRandomValues(new Uint8Array(32)),n=>n.toString(16).padStart(2,'0')).join(''),enrollmentId=crypto.randomUUID(),deviceId=command.value.deviceId??crypto.randomUUID(),expiresAt=new Date(Date.parse(now)+DEVICE_LIMITS.enrollmentMs).toISOString();
 const result=await executeWorkspaceCommand(userId,{protocolVersion:1,expectedRevision:input.revision,mutationId:input.mutationId,command},{db,now:()=>now,handlers:workspaceHandlers,deviceEnrollment:{id:enrollmentId,deviceId,secretHash:await contentHash(secret),expiresAt,scopes:['telemetry:write']}});
 if(result.status==='conflict')return {status:409 as const,body:{error:'Your workspace changed. Refresh and review again.',diagnostic:'revision_conflict'}};
 if(result.status==='replayed')return {status:409 as const,body:{code:'enrollment-secret-unavailable',receipt:result.receipt,envelope:await readCurrent(db,userId,now)}};
 return {status:200 as const,body:{result:{deviceId,enrollmentId,secret,expiresAt},receipt:result.receipt,envelope:result.envelope}};
}
