import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '../../../../chatgpt-auth';
import { mutationOutcome } from '../../../../../lib/workspace-transaction';
import { CommandValidationError } from '../../../../../lib/workspace-errors';
export const dynamic='force-dynamic';
export async function GET(_request:Request,context:{params:Promise<{mutationId:string}>}) {
  const headers={'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff'};
  const user=await getChatGPTUser();
  if(!user)return Response.json({error:'Sign in again.',diagnostic:'session_expired'},{status:401,headers});
  if(!env.DB)return Response.json({error:'Storage is unavailable.',diagnostic:'storage_unavailable'},{status:503,headers});
  try {return Response.json(await mutationOutcome(env.DB,user.userId,(await context.params).mutationId),{headers});}
  catch(error){return Response.json({error:'The outcome could not be checked.',diagnostic:error instanceof CommandValidationError?'request_invalid':'storage_unavailable'},{status:error instanceof CommandValidationError?400:503,headers});}
}
