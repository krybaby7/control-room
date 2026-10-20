import {env} from 'cloudflare:workers';
import {getChatGPTUser} from '../../chatgpt-auth';
import {readSources,sourceHttpResponse,sourceHttpFailure,SourceHttpError} from '../../../lib/sources/http';
export const dynamic='force-dynamic';
export async function GET(request:Request){const user=await getChatGPTUser();try{if(!user)throw new SourceHttpError('Sign in to view sources.',401);if(!env.DB)throw new SourceHttpError('Source storage is unavailable.',503);if(new URL(request.url).search)throw new SourceHttpError('Invalid source query.',400);return sourceHttpResponse(await readSources(env.DB,user.userId,new Date().toISOString()));}catch(error){return sourceHttpFailure(error);}}
