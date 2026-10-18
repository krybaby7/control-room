import {env} from 'cloudflare:workers';
import {handleAgentHttp} from '../../../../../lib/agents/http';
export const dynamic='force-dynamic';
export async function POST(request:Request){return handleAgentHttp("claim",request,{db:env.DB??null});}
