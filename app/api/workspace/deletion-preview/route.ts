import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '../../../chatgpt-auth';
import { readCurrent } from '../../../../lib/workspace-store';
import { previewEntityDeletion } from '../../../../lib/workspace-deletion';
import { OWNER_TABLES,ownerReader } from '../../../../lib/workspace-modules';
export const dynamic='force-dynamic';
export async function GET(request:Request){
 const headers={'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff'};
 const user=await getChatGPTUser();if(!user)return Response.json({error:'Sign in again.'},{status:401,headers});
 if(!env.DB)return Response.json({error:'Storage is unavailable.'},{status:503,headers});
 try{const query=new URL(request.url).searchParams;const kind=query.get('entityType'),id=query.get('id');if(!['task','capture'].includes(kind??'') || !id || id.length>128)throw new Error('Invalid selection.');
  const current=await readCurrent(env.DB,user.userId);const preview=await previewEntityDeletion(current.workspace,kind as 'task'|'capture',id,current.revision);
  for(const table of OWNER_TABLES)if((await ownerReader(env.DB,user.userId).list(table,{limit:1})).length){preview.blockers.push('Linked module records require a typed reference review before permanent removal.');preview.canDelete=false;break;}
  return Response.json(preview,{headers});
 }catch{return Response.json({error:'This removal preview is unavailable. Your records have not changed.'},{status:400,headers});}
}
