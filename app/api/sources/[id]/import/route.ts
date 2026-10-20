import {settleUploadBody} from '../../../../../lib/upload-body-settlement';
import {env} from 'cloudflare:workers';
import {getChatGPTUser} from '../../../../chatgpt-auth';
import {readManualSourceImport,importManualSource,sourceHttpResponse,sourceHttpFailure,SourceHttpError} from '../../../../../lib/sources/http';
export const dynamic='force-dynamic';
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){try{const user=await getChatGPTUser();if(!user)throw new SourceHttpError('Sign in to import sources.',401);if(!env.DB)throw new SourceHttpError('Source storage is unavailable.',503);if(new URL(request.url).search)throw new SourceHttpError('Invalid source import query.',400);const {id}=await params,input=await readManualSourceImport(request);return sourceHttpResponse(await importManualSource(env.DB,user.userId,id,input,()=>new Date().toISOString()));}catch(error){return sourceHttpFailure(error);}finally{if(!request.bodyUsed)await settleUploadBody(request.body);}}
