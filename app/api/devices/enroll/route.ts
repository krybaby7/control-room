import {settleUploadBody} from '../../../../lib/upload-body-settlement';
import {env} from 'cloudflare:workers';
import {z} from 'zod';
import {getChatGPTUser} from '../../../chatgpt-auth';
import {readMutation,RequestError} from '../../../../lib/api-guards';
import {createOwnerEnrollment} from '../../../../lib/devices/enrollment';
import {CommandValidationError,MutationIdReuseError,ModuleConflictError,RetiredMutationError} from '../../../../lib/workspace-errors';
import {RecoverabilityCapacityError} from '../../../../lib/recoverability-admission';
import {WorkspaceCapacityError} from '../../../../lib/workspace-capacity';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff'};
export async function POST(request:Request){
 const requestId=crypto.randomUUID();
 const failure=(error:string,diagnostic:string,status:number)=>Response.json({error,diagnostic,requestId},{status,headers:{...headers,'X-Request-Id':requestId}});
 try{
 const user=await getChatGPTUser();if(!user)return failure('Sign in again.','session_expired',401);if(!env.DB)return failure('Device storage is unavailable.','storage_unavailable',503);
 const input=await readMutation(request),result=await createOwnerEnrollment(env.DB,user.userId,input,new Date().toISOString());
 if('diagnostic'in result.body)return failure(result.body.error,result.body.diagnostic,result.status);
 return Response.json(result.body,{status:result.status,headers:{...headers,'X-Request-Id':requestId}});
 }catch(error){
 if(error instanceof RequestError)return failure(error.message,'request_invalid',error.status);
 if(error instanceof ModuleConflictError)return failure('A related record changed. Refresh and review again.','module_conflict',409);
 if(error instanceof MutationIdReuseError)return failure('This mutation identity was already used.','mutation_id_reused',409);
 if(error instanceof RetiredMutationError)return failure('This mutation identity is retired.','mutation_retired',409);
 if(error instanceof RecoverabilityCapacityError||error instanceof WorkspaceCapacityError)return failure(error.message,error.code,429);
 if(error instanceof CommandValidationError||error instanceof z.ZodError)return failure('The enrollment request is invalid.','command_invalid',400);
 return failure('Enrollment outcome is uncertain. Keep the original request open and retry it.','storage_unavailable',503);
 }finally{if(!request.bodyUsed)await settleUploadBody(request.body);}
}
