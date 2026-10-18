import {env} from 'cloudflare:workers';
import {handleSourceServiceJobRequest} from '../../../../../lib/background/service-access';
export const dynamic='force-dynamic';
export async function POST(request:Request){return handleSourceServiceJobRequest(request,env.DB??null,()=>new Date().toISOString());}
