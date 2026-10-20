import assert from 'node:assert/strict';
import test from 'node:test';
import { readWorkspaceResponse, SessionExpiredError, submissionFor } from '../lib/workspace-client.ts';

test('an uncertain unchanged submission keeps its mutation ID after revision refresh', () => {
  let sequence = 0;
  const createId = () => `mutation-${++sequence}`;
  const first = submissionFor(null, { type: 'capture.create', capture: { title: 'Keep me' } }, createId);
  const retry = submissionFor(first, { capture: { title: 'Keep me' }, type: 'capture.create' }, createId);
  assert.equal(retry.mutationId, first.mutationId);
  assert.equal(sequence, 1);
});

test('changing a command or acknowledging it creates a fresh submission', () => {
  let sequence = 0;
  const createId = () => `mutation-${++sequence}`;
  const first = submissionFor(null, { title: 'Original' }, createId);
  const changed = submissionFor(first, { title: 'Changed' }, createId);
  assert.notEqual(changed.mutationId, first.mutationId);
  assert.notEqual(submissionFor(null, { title: 'Changed' }, createId).mutationId, changed.mutationId);
});

test('a 401 is explicitly classified before decoding an invalid body', async () => {
  await assert.rejects(readWorkspaceResponse(new Response('Expired', { status: 401 })), SessionExpiredError);
});

test('an incomplete success stays uncertain instead of acknowledging the mutation', async () => {
  await assert.rejects(readWorkspaceResponse(Response.json({ revision: 2 })), /incomplete/);
});

test('a valid workspace response preserves the saved time separately from receipt time', async () => {
  const body = { workspace: { schemaVersion: 2 }, revision: 4, updatedAt: '2026-10-10T08:00:00Z' };
  assert.deepEqual(await readWorkspaceResponse(Response.json(body)), body);
});

import { isConclusiveWorkspaceRejection, WorkspaceRequestError } from '../lib/workspace-client.ts';
const requestId='12345678-1234-4234-9234-123456789abc';
async function parsedRejection(status:number,diagnostic:string,bodyPatch:Record<string,unknown>={},header:string|null=requestId) {
  const response=Response.json({error:'Rejected before commit.',diagnostic,requestId,...bodyPatch},{status,headers:header?{'X-Request-Id':header}:{}});
  try{await readWorkspaceResponse(response);assert.fail('Expected rejected response');}catch(error){return error;}
}
test('only trusted application status and diagnostic pairs conclusively reject a mutation',async()=>{
  for(const [diagnostic,statuses] of Object.entries({request_invalid:[400,403,413,415],command_invalid:[400],receipt_capacity:[429],revision_conflict:[409],module_conflict:[409]})) {
    for(const status of statuses){const error=await parsedRejection(status,diagnostic);assert.ok(error instanceof WorkspaceRequestError);assert.equal(error.trusted,true);assert.equal(isConclusiveWorkspaceRejection(error),true,`${status}/${diagnostic}`);}
  }
});
test('unknown or mismatched status pairs remain uncertain despite valid application correlation',async()=>{
  for(const [status,diagnostic] of [[408,'request_invalid'],[429,'command_invalid'],[403,'revision_conflict'],[400,'module_conflict'],[503,'storage_unavailable'],[409,'mutation_id_reused'],[409,'mutation_retired'],[429,'backup_capacity']] as const)assert.equal(isConclusiveWorkspaceRejection(await parsedRejection(status,diagnostic)),false,`${status}/${diagnostic}`);
});
test('malformed proxy bodies and missing or mismatched UUID correlation remain uncertain',async()=>{
  for(const [patch,header] of [ [{error:42},requestId],[{error:{message:'proxy'}},requestId],[{error:''},requestId],[{diagnostic:42},requestId],[{requestId:'arbitrary-id'},'arbitrary-id'],[{},null],[{},'87654321-1234-4234-9234-123456789abc'],[{extra:'proxy'},requestId] ] as const) {
    const error=await parsedRejection(400,'command_invalid',patch,header);
    assert.ok(error instanceof WorkspaceRequestError);assert.equal(error.trusted,false);assert.equal(isConclusiveWorkspaceRejection(error),false);
  }
  for(const response of [new Response('<html>proxy timeout</html>',{status:408}),new Response('malformed',{status:400}),Response.json('generic rejection',{status:403}),Response.json([],{status:400}),Response.json(null,{status:400})]) {
    try{await readWorkspaceResponse(response);assert.fail('Expected error');}catch(error){assert.equal(isConclusiveWorkspaceRejection(error),false);assert.ok(error instanceof WorkspaceRequestError);assert.equal(typeof error.message,'string');}
  }
});
test('manually constructed errors are untrusted by default and generic exceptions never settle a save',()=>{
  assert.equal(isConclusiveWorkspaceRejection(new WorkspaceRequestError('Proxy',400,'command_invalid')),false);
  assert.equal(isConclusiveWorkspaceRejection(new Error('400 command_invalid')),false);
  assert.equal(isConclusiveWorkspaceRejection({status:400,diagnostic:'command_invalid',trusted:true}),false);
  assert.equal(isConclusiveWorkspaceRejection(new WorkspaceRequestError('Verified',400,'command_invalid',true)),true);
});
