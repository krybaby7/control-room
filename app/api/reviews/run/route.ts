import {RecoverabilityCapacityError} from '../../../../lib/recoverability-admission';
import {env} from 'cloudflare:workers';
import {getChatGPTUser} from '../../../chatgpt-auth';
import {runInteractiveReview,reviewResponse} from '../../../../lib/reviews/http';
import {readReviewRun} from '../../../../lib/reviews/request';
import {RequestError} from '../../../../lib/api-guards';
import {settleUploadBody} from '../../../../lib/upload-body-settlement';
export const dynamic='force-dynamic';
export async function POST(request:Request){try{const user=await getChatGPTUser();if(!user)return reviewResponse({error:'Sign in to run reviews.'},401);if(!env.DB)return reviewResponse({error:'Review storage is unavailable.'},503);if(new URL(request.url).search)return reviewResponse({error:'Invalid review query.'},400);const input=await readReviewRun(request),result=await runInteractiveReview(env.DB,user.userId,input.intentId,()=>new Date().toISOString());return reviewResponse(result,result.status==='conflict'?409:200);}catch(error){if(error instanceof RecoverabilityCapacityError&&error.paused)return reviewResponse({status:'paused',reason:'storage_capacity'});return reviewResponse({error:error instanceof RequestError?error.message:'Review could not be confirmed. Retry the same pending request.'},error instanceof RequestError?error.status:503);}finally{if(!request.bodyUsed)await settleUploadBody(request.body);}}
