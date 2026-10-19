import {ownerJobCommand} from '../../owner-command';
export const dynamic='force-dynamic';
export async function POST(request:Request,context:{params:Promise<{jobId:string}>}){return ownerJobCommand(request,"jobs.accept-result",(await context.params).jobId);}
