import {env} from 'cloudflare:workers';
import {getChatGPTUser} from '../../chatgpt-auth';
import {readEvidenceSnapshot} from '../../../lib/evidence-store';
export const dynamic='force-dynamic';
export async function GET(){
 const headers={'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff'};
 const user=await getChatGPTUser();if(!user)return Response.json({error:'Sign in to view evidence.'},{status:401,headers});
 if(!env.DB)return Response.json({error:'Evidence is temporarily unavailable.'},{status:503,headers});
 try{const snapshot=await readEvidenceSnapshot(env.DB,user.userId,new Date().toISOString());return Response.json({...snapshot,attachmentStorage:{configured:!!env.BUCKET,availability:env.BUCKET?'configured-unverified':'not-configured'}},{headers});}
 catch{return Response.json({error:'Evidence could not be loaded. Refresh and try again.'},{status:503,headers});}
}
