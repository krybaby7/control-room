import {RecoverabilityCapacityError} from '../../../lib/recoverability-admission';
import {settleUploadBody} from '../../../lib/upload-body-settlement';
import {ownerAttachmentServices} from '../../../lib/attachment-services';
import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '../../chatgpt-auth';
import { readMutation, RequestError } from '../../../lib/api-guards';
import { loadWorkspace, loadPreviousWorkspace, mutateWorkspace, MutationIdReuseError, CommandValidationError } from '../../../lib/workspace-store';
import { MutationEpochError } from '../../../lib/idempotency-retention';
import { WorkspaceCapacityError } from '../../../lib/workspace-capacity';
import { ModuleConflictError, RetiredMutationError } from '../../../lib/workspace-errors';
import { WorkspaceValidationError } from '../../../lib/workspace-validation';
import { createSeedWorkspace } from '../../../lib/seed';

export const dynamic = 'force-dynamic';
function json(value: unknown, requestId:string, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff', 'X-Request-Id':requestId } });
}
function failure(error:string,diagnostic:string,requestId:string,status:number) { return json({error,diagnostic,requestId},requestId,status); }
function unavailable(error:unknown,requestId:string,operation:'read'|'write') {
  const diagnostic = error instanceof WorkspaceValidationError || error instanceof SyntaxError ? 'workspace_schema' : 'storage_unavailable';
  // Log classification and correlation only; no private workspace, command, owner or error details.
  console.error(JSON.stringify({event:`workspace_${operation}_failed`,diagnostic,requestId}));
  return failure(operation === 'read' ? 'Your workspace could not be loaded. Please try again.' : 'Your change could not be saved. Keep this draft open and try again.',diagnostic,requestId,503);
}
export async function GET(request:Request) {
  const requestId = crypto.randomUUID();
  try {
    const user = await getChatGPTUser();
    if (!user) return failure('Sign in to open your workspace.','session_expired',requestId,401);
    if (!env.DB) return failure('Workspace storage is temporarily unavailable. Please try again.','storage_unavailable',requestId,503);
    if (new URL(request.url).searchParams.get('backup') === 'previous') {
      const previous = await loadPreviousWorkspace(env.DB,user.userId);
      return previous ? json(previous,requestId) : failure('No pre-restore backup is available yet.','backup_not_found',requestId,404);
    }
    const now = new Date().toISOString();
    return json(await loadWorkspace(env.DB, user.userId, () => createSeedWorkspace(now), now),requestId);
  } catch(error) { return unavailable(error,requestId,'read'); }
}
export async function handleWorkspacePOST(request:Request,importId?:string) {
  const requestId = crypto.randomUUID();
  try {
    const user = await getChatGPTUser();
    if (!user) return failure('Your session has ended. Sign in again before saving.','session_expired',requestId,401);
    if (!env.DB) return failure('Workspace storage is temporarily unavailable. Your draft has not been saved.','storage_unavailable',requestId,503);
    const { revision, mutationId, command } = await readMutation(request,{importId});
    const now = new Date().toISOString();
    await loadWorkspace(env.DB,user.userId,() => createSeedWorkspace(now),now);
    const services=await ownerAttachmentServices(env.DB,user.userId,now,env.BUCKET);
    const saved = await mutateWorkspace(env.DB,user.userId,revision,mutationId,command,now,services);
    if (!saved) return failure('Your plan changed on another tab or device. Review the refreshed plan and save your draft again.','revision_conflict',requestId,409);
    return json(saved,requestId);
  } catch (error) {
    if (error instanceof RequestError) return failure(error.message,'request_invalid',requestId,error.status);
    if (error instanceof MutationEpochError) return failure(error.message,'request_invalid',requestId,400);
    if (error instanceof RecoverabilityCapacityError) return failure(error.message,error.code,requestId,429);
    if (error instanceof WorkspaceCapacityError) return failure(error.message,error.code,requestId,429);
    if (error instanceof RetiredMutationError) return failure(error.message,'mutation_retired',requestId,409);
    if (error instanceof ModuleConflictError) return failure(error.message,'module_conflict',requestId,409);
    if (error instanceof MutationIdReuseError) return failure(error.message,'mutation_id_reused',requestId,409);
    if (error instanceof CommandValidationError) return failure(error.message,'command_invalid',requestId,400);
    return unavailable(error,requestId,'write');
  } finally {
    // Complete bounded rejected transport bodies before handing back the response.
    if(!request.bodyUsed)await settleUploadBody(request.body);
  }
}

export async function POST(request:Request){return handleWorkspacePOST(request);}
