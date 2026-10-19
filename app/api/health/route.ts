import {env} from 'cloudflare:workers';
import {getChatGPTUser} from '../../chatgpt-auth';
import {handleOperationalHealth} from '../../../lib/operational-health';
export const dynamic='force-dynamic';
export async function GET(request:Request){return handleOperationalHealth(request,{db:env.DB??null,authenticateOwner:async()=>{const user=await getChatGPTUser();return user?.userId??null;}});}
