import {env} from 'cloudflare:workers';
import {handleAutomationServiceRequest} from '../../../../lib/automations/service';
import {settleUploadBody} from '../../../../lib/upload-body-settlement';
export const dynamic='force-dynamic';
export async function POST(request:Request){try{return await handleAutomationServiceRequest(request,env.DB??null,()=>new Date().toISOString(),{fileBackupServices:env.BUCKET?{bucket:env.BUCKET,attachmentBucket:env.BUCKET}:undefined});}finally{if(!request.bodyUsed)await settleUploadBody(request.body);}}
