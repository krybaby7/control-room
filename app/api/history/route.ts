import {env} from 'cloudflare:workers';
import {getChatGPTUser} from '../../chatgpt-auth';
import {historyFilterSchema,readHistoryPage} from '../../../lib/history';
import {getOrCreateWorkspaceNamespaces} from '../../../lib/workspace-namespaces';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff'};
export async function GET(request:Request){
 const user=await getChatGPTUser();if(!user)return Response.json({error:'Sign in to view history.'},{status:401,headers});
 if(!env.DB)return Response.json({error:'History is temporarily unavailable.'},{status:503,headers});
 const params=new URL(request.url).searchParams;
 const allowed=['entityType','entityId','projectId','kind','origin','from','through','cursor'];
 if([...params.keys()].some(key=>!allowed.includes(key)||params.getAll(key).length!==1))return Response.json({error:'Invalid history filters.'},{status:400,headers});
 const {cursor,...raw}=Object.fromEntries(params);const filters=historyFilterSchema.safeParse(raw);
 if(!filters.success)return Response.json({error:'Invalid history filters.'},{status:400,headers});
 try{const namespaces=await getOrCreateWorkspaceNamespaces(env.DB,user.userId);return Response.json(await readHistoryPage(env.DB,user.userId,{filters:filters.data,...(cursor?{cursor}:{})},{secret:namespaces.cursorSecret,now:()=>new Date().toISOString()}),{headers});}
 catch{return Response.json({error:'History could not be loaded. Refresh the filters and try again.'},{status:503,headers});}
}
