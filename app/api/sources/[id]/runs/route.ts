import {env} from 'cloudflare:workers';
import {getChatGPTUser} from '../../../../chatgpt-auth';
import {readSourceRuns,parseSourcePageQuery,sourceHttpResponse,sourceHttpFailure,SourceHttpError} from '../../../../../lib/sources/http';
export const dynamic='force-dynamic';
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){const user=await getChatGPTUser();try{if(!user)throw new SourceHttpError('Sign in to view sources.',401);if(!env.DB)throw new SourceHttpError('Source storage is unavailable.',503);const {id}=await params;return sourceHttpResponse(await readSourceRuns(env.DB,user.userId,id,parseSourcePageQuery(request.url)));}catch(error){return sourceHttpFailure(error);}}
