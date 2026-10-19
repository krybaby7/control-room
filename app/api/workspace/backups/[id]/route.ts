import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '../../../../chatgpt-auth';
import { readWorkspaceBackup } from '../../../../../lib/workspace-backups';
export const dynamic='force-dynamic';
export async function GET(_request:Request,context:{params:Promise<{id:string}>}){
 const headers={'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff'};
 const user=await getChatGPTUser();if(!user)return Response.json({error:'Sign in again.'},{status:401,headers});
 if(!env.DB)return Response.json({error:'Storage is unavailable.'},{status:503,headers});
 try{const value=await readWorkspaceBackup(env.DB,user.userId,(await context.params).id);return value?Response.json(value.bundle,{headers}):Response.json({error:'Backup not found.'},{status:404,headers});}
 catch{return Response.json({error:'This backup could not be verified.'},{status:503,headers});}
}
