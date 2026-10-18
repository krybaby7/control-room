import {env} from 'cloudflare:workers';
import {getChatGPTUser} from '../../../chatgpt-auth';
import {readEvidenceSnapshot} from '../../../../lib/evidence-store';
import {buildReviewAttention} from '../../../../lib/review-attention';
import {readCurrent} from '../../../../lib/workspace-store';
import {canonical,contentHash} from '../../../../lib/canonical-json';
export const dynamic='force-dynamic';
export async function GET(request:Request){
 const headers={'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff'};
 const user=await getChatGPTUser();if(!user)return Response.json({error:'Sign in to view review attention.'},{status:401,headers});
 if(!env.DB)return Response.json({error:'Review attention is unavailable.'},{status:503,headers});
 if(new URL(request.url).search)return Response.json({error:'Invalid review attention selection.'},{status:400,headers});
 try{
  const now=new Date().toISOString(),before=await readCurrent(env.DB,user.userId,now),snapshot=await readEvidenceSnapshot(env.DB,user.userId,now);
  if(snapshot.revision!==before.revision)throw new Error('Review snapshot changed.');
  const grants=(await env.DB.prepare('SELECT record_id,content_hash FROM acceptance_owner_grants WHERE user_id=? LIMIT 10001').bind(user.userId).all<{record_id:string;content_hash:string}>()).results;if(grants.length>10000)throw new Error('Review authority bound exceeded.');
  const grantKeys=new Set(grants.map(grant=>canonical([grant.record_id,grant.content_hash])));const trustedAcceptanceIds=new Set<string>();for(const record of snapshot.acceptances){const hash=await contentHash(canonical(record));if(grantKeys.has(canonical([record.id,hash])))trustedAcceptanceIds.add(record.id);}
  const decisionGrants=(await env.DB.prepare('SELECT decision_id,version,content_hash FROM decision_owner_grants WHERE user_id=? LIMIT 10001').bind(user.userId).all<{decision_id:string;version:number;content_hash:string}>()).results;if(decisionGrants.length>10000)throw new Error('Decision authority bound exceeded.');
  const decisionKeys=new Set(decisionGrants.map(grant=>canonical([grant.decision_id,grant.version,grant.content_hash]))),trustedDecisionVersions=[];
  for(const record of snapshot.decisionVersions){const hash=await contentHash(canonical(record));if(decisionKeys.has(canonical([record.id,record.version,hash])))trustedDecisionVersions.push(record);}
  const items=await buildReviewAttention(before.workspace,snapshot,now,{trustedAcceptanceIds,trustedDecisionVersions});
  if((await readCurrent(env.DB,user.userId,now)).revision!==before.revision)throw new Error('Review snapshot changed.');
  return Response.json({revision:snapshot.revision,asOf:now,items},{headers});
 }catch{return Response.json({error:'Review attention could not be loaded. Refresh before reviewing.'},{status:503,headers});}
}
