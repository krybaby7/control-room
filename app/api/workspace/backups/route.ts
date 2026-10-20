import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '../../../chatgpt-auth';
import { listWorkspaceBackups } from '../../../../lib/workspace-backups';
export const dynamic='force-dynamic';
export async function GET(){
 const headers={'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff'};
 const user=await getChatGPTUser();if(!user)return Response.json({error:'Sign in again.'},{status:401,headers});
 if(!env.DB)return Response.json({error:'Storage is unavailable.'},{status:503,headers});
 try{const backups=(await listWorkspaceBackups(env.DB,user.userId)).map(({ownerScope,...manifest})=>{void ownerScope;return manifest;});return Response.json({backups},{headers});}
 catch{return Response.json({error:'Backup history could not be verified.'},{status:503,headers});}
}
