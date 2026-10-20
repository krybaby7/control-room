import { getChatGPTUser } from '../../../chatgpt-auth';
import { hashJson } from '../../../../lib/workspace-transaction';
export const dynamic='force-dynamic';
/** An opaque device namespace, never an authorization token or portable owner ID. */
export async function GET(){
 const headers={'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff'};
 const user=await getChatGPTUser();if(!user)return Response.json({error:'Sign in again.'},{status:401,headers});
 return Response.json({deviceScope:await hashJson({purpose:'trusted-device-drafts',owner:user.userId})},{headers});
}
