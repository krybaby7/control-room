import {env} from 'cloudflare:workers';
import {getChatGPTUser} from '../../../chatgpt-auth';
import {readCurrent} from '../../../../lib/workspace-store';
import {ownerReader} from '../../../../lib/workspace-modules';
import {readStagedImport} from '../../../../lib/import-staging';
import {previewOccurrenceRemoval} from '../../../../lib/recurrence-removal';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff'};
export async function GET(request:Request){
 const user=await getChatGPTUser();if(!user)return Response.json({error:'Sign in again.'},{status:401,headers});
 const db=env.DB;
 if(!db)return Response.json({error:'Storage is unavailable.'},{status:503,headers});
 try{
  const query=new URL(request.url).searchParams;
  const keys=['ruleId','occurrenceDate','taskId','expectedOccurrenceRevision'];
  if([...query.keys()].some(key=>!keys.includes(key))||keys.some(key=>query.getAll(key).length!==1))throw new Error('Invalid selection.');
  const raw=query.get('expectedOccurrenceRevision')!;
  if(!/^[1-9][0-9]{0,15}$/.test(raw))throw new Error('Invalid revision.');
  const now=new Date().toISOString();const before=await readCurrent(db,user.userId);
  const preview=await previewOccurrenceRemoval({userId:user.userId,before,command:{type:'recurrence.occurrence.remove'},now,query:ownerReader(db,user.userId),readImport:id=>readStagedImport(db,user.userId,id,now)},{ruleId:query.get('ruleId')!,occurrenceDate:query.get('occurrenceDate')!,taskId:query.get('taskId')!,expectedOccurrenceRevision:Number(raw)});
  return Response.json({preview},{headers});
 }catch{return Response.json({error:'This removal preview changed or is unavailable. Your records have not changed.'},{status:409,headers});}
}
