import {env} from 'cloudflare:workers';
import {getChatGPTUser} from '../../../../../chatgpt-auth';
import {readReadyFileBackup} from '../../../../../../lib/automations/backup-archive-store';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff'};
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){
 const user=await getChatGPTUser();if(!user)return Response.json({error:'Sign in again.'},{status:401,headers});
 if(!env.DB||!env.BUCKET)return Response.json({error:'Private backup storage is unavailable.'},{status:503,headers});
 const {id}=await params;if(!/^[A-Za-z0-9_-]{1,128}$/.test(id)||new URL(request.url).search)return new Response(null,{status:404,headers});
 const deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(),15000);
 try{const value=await readReadyFileBackup(env.DB,user.userId,id,{bucket:env.BUCKET,attachmentBucket:env.BUCKET},AbortSignal.any([request.signal,deadline.signal]));
  if(!value)return new Response(null,{status:404,headers});
  return new Response(value.stream,{headers:{...headers,'Content-Type':'application/zip','Content-Disposition':'attachment; filename="workspace-backup.zip"','Content-Length':String(value.index.zipBytes),'X-Control-Room-Archive-Index-SHA256':value.indexHash}});
 }catch{return Response.json({error:'This file backup could not be verified.'},{status:503,headers});}finally{clearTimeout(timer);}
}
