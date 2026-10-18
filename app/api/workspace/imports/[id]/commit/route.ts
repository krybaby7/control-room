import { handleWorkspacePOST } from '../../../route';
export const dynamic='force-dynamic';
export async function POST(request:Request,context:{params:Promise<{id:string}>}){return handleWorkspacePOST(request,(await context.params).id);}
