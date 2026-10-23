import {env} from 'cloudflare:workers';
import {historyPrivateBucket} from '../../../../lib/history/bucket';
import {handleHistoryAnalysisRequest} from '../../../../lib/history/analysis-http';
export const dynamic='force-dynamic';
/** Deployment must explicitly register independently verified native service and
 * exact approved runtime ports. Installing this route activates no inference. */
export async function POST(request:Request){return handleHistoryAnalysisRequest(request,{db:env.DB??null,bucket:historyPrivateBucket(env.BUCKET)??undefined,now:()=>new Date().toISOString()});}
