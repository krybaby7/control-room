import { getChatGPTUser } from '../../../chatgpt-auth';
import { createBackupPolicy } from '../../../../lib/backup-jobs';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff'};
/** No activation route exists until registered runner and private object storage are delivered. */
export async function GET(){
 const user=await getChatGPTUser();if(!user)return Response.json({error:'Sign in again.'},{status:401,headers});
 return Response.json({policy:createBackupPolicy({}, {renewableAuthenticatedScopedRunner:false,verifiedCompletePrivateObjectStorage:false}),status:'unavailable',requirements:['Register a renewable authenticated owner-scoped backup runner.','Configure and verify complete private object storage.'],persisted:false},{headers});
}
