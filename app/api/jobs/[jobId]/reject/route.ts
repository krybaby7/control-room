import {ownerJobCommand} from '../../owner-command';
export const dynamic='force-dynamic';
export async function POST(request:Request,context:{params:Promise<{jobId:string}>}){return ownerJobCommand(request,"jobs.reject",(await context.params).jobId);}
