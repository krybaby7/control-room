import {settleUploadBody} from '../../../../../lib/upload-body-settlement';
import {env} from 'cloudflare:workers';
import {handleSourceServiceJobRequest} from '../../../../../lib/background/service-access';
export const dynamic='force-dynamic';
export async function POST(request:Request){try{return await handleSourceServiceJobRequest(request,env.DB??null,()=>new Date().toISOString());}finally{if(!request.bodyUsed)await settleUploadBody(request.body);}}
