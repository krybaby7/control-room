import {settleUploadBody} from '../../../../../lib/upload-body-settlement';
import {env} from 'cloudflare:workers';
import {getChatGPTUser} from '../../../../chatgpt-auth';
import {handleRetiredBackupHttp} from '../../../../../lib/backup-cleanup-http';
export const dynamic='force-dynamic';
async function handle(request:Request){
 try{
 const user=await getChatGPTUser();
 if(!user)return Response.json({error:'Sign in again.',diagnostic:'session_expired'},{status:401,headers:{'Cache-Control':'no-store, private'}});
 if(!env.DB)return Response.json({error:'Storage is unavailable.'},{status:503,headers:{'Cache-Control':'no-store, private'}});
 return handleRetiredBackupHttp(request,{db:env.DB,ownerId:user.userId,bucket:env.BUCKET,now:()=>new Date().toISOString()});
 }catch{return Response.json({error:'Retired archive cleanup is unavailable.',diagnostic:'cleanup_unconfirmed'},{status:503,headers:{'Cache-Control':'no-store, private'}});}finally{if(!request.bodyUsed)await settleUploadBody(request.body);}
}
export const GET=handle;
export const POST=handle;
