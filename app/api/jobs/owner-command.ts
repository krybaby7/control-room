import {getChatGPTUser} from '../../chatgpt-auth';
import {readMutation,RequestError} from '../../../lib/api-guards';
import {settleUploadBody} from '../../../lib/upload-body-settlement';
import {handleWorkspacePOST} from '../workspace/route';
export async function ownerJobCommand(request:Request,type:string,jobId?:string):Promise<Response>{
 const requestId=crypto.randomUUID(),headers={'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff','X-Request-Id':requestId};
 const fail=(error:string,status:number,diagnostic='request_invalid')=>Response.json({error,diagnostic,requestId},{status,headers});
 try{
  const user=await getChatGPTUser();if(!user)return Response.json({error:'Sign in again.',diagnostic:'session_expired',requestId},{status:401,headers});
  const input=await readMutation(request);
  const command=input.command as {type?:unknown;id?:unknown}|null;
  if(!command||typeof command!=='object'||command.type!==type||jobId!==undefined&&command.id!==jobId)return fail('The exact owner job command is required.',400);
  return await handleWorkspacePOST(new Request(request.url,{method:'POST',headers:request.headers,body:JSON.stringify(input)}));
 }catch(error){return error instanceof RequestError?fail(error.message,error.status):fail('The owner job outcome is uncertain. Retry the original request.',503,'storage_unavailable');}
 finally{if(!request.bodyUsed)await settleUploadBody(request.body);}
}
