import test from 'node:test';
import assert from 'node:assert/strict';
import { readMutation } from '../lib/api-guards.ts';
function request(body = JSON.stringify({ revision: 1, mutationId:'mutation-00000001', command: { type: 'task.create' } }), origin = 'https://app.example', type = 'application/json') {
  return new Request('https://app.example/api/workspace', { method: 'POST', headers: { origin, 'content-type': type }, body });
}
test('accepts an explicit same-origin JSON mutation with a revision', async () => {
  assert.deepEqual(await readMutation(request()), { revision: 1, mutationId:'mutation-00000001', command: { type: 'task.create' } });
});
test('rejects a cross-origin request before parsing its payload', async () => {
  await assert.rejects(readMutation(request('invalid', 'https://elsewhere.example')), { status: 403 });
});
test('rejects form submissions and invalid or oversized JSON', async () => {
  await assert.rejects(readMutation(request('{}', 'https://app.example', 'text/plain')), { status: 415 });
  await assert.rejects(readMutation(request('not json')), { status: 400 });
  await assert.rejects(readMutation(request('x'.repeat(2_000_001))), { status: 413 });
  await assert.rejects(readMutation(request(JSON.stringify({revision:1,mutationId:'mutation-00000001',command:{type:'capture.create',text:'x'.repeat(65_536)}}))), {status:413});
});

test('mutation IDs are required and restore accepts a full 1MB workspace plus envelope overhead', async () => {
  for (const mutationId of [undefined, '', 'tiny', {}, 'contains spaces 00000']) await assert.rejects(readMutation(request(JSON.stringify({revision:1,mutationId,command:{type:'task.create'}}))), {status:400});
  const command = {type:'workspace.restore',workspace:{content:'x'.repeat(1_000_000)}};
  assert.deepEqual((await readMutation(request(JSON.stringify({revision:1,mutationId:'mutation-00000001',command})))).command,command);
});
test('rejects absent, fractional and untrusted revision values', async () => {
  for (const revision of [undefined, -1, 0, 1.2, '1', Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(readMutation(request(JSON.stringify({ revision, command: {} }))), { status: 400 });
  }
});

test('versioned envelopes adapt to the same mutation and unknown authority fields fail',async()=>{
 assert.equal((await readMutation(request(JSON.stringify({protocolVersion:1,expectedRevision:2,mutationId:'protocol-00000001',command:{type:'task.create'}})))).revision,2);
 for(const extra of [{owner:'another'},{protocolVersion:2},{expectedRevision:3}])await assert.rejects(readMutation(request(JSON.stringify({revision:1,mutationId:'protocol-00000001',command:{type:'task.create'},...extra}))),{status:400});
});

test('only the named reviewed import boundary accepts a larger selection command',async()=>{
 const body=JSON.stringify({revision:1,mutationId:'import-envelope-0001',command:{type:'workspace.import.commit',importId:'stage',selection:{tasks:['x'.repeat(70000)]}}});
 await assert.rejects(readMutation(request(body)),{status:413});
 assert.equal((await readMutation(request(body),{importId:'stage'})).revision,1);
 await assert.rejects(readMutation(request(body),{importId:'another-stage'}),{status:400});
});

test('mutation boundary rejects invalid UTF-8 instead of silently replacing owner text',async()=>{
 const source=new TextEncoder().encode(JSON.stringify({revision:1,mutationId:'mutation-utf8-0001',command:{type:'capture.create',text:'X'}}));
 source[source.indexOf(88)]=255;
 const malformed=new Request('https://app.example/api/workspace',{method:'POST',headers:{origin:'https://app.example','content-type':'application/json'},body:source});
 await assert.rejects(readMutation(malformed),{status:400});
});

test('restore transport accepts legacy content and v5 serialized headroom up to the exact 2 MB request bound',async()=>{
 for(const contentBytes of [1_000_000,1_500_000,1_875_000]){
  const command={type:'workspace.restore',workspace:{content:'x'.repeat(contentBytes)}};
  assert.deepEqual((await readMutation(request(JSON.stringify({revision:1,mutationId:'restore-headroom-0001',command})))).command,command);
 }
 const envelope={revision:1,mutationId:'restore-boundary-0001',command:{type:'workspace.restore',workspace:{content:''}}};
 const overhead=new TextEncoder().encode(JSON.stringify(envelope)).byteLength;envelope.command.workspace.content='x'.repeat(2_000_000-overhead);
 const exact=JSON.stringify(envelope);assert.equal(new TextEncoder().encode(exact).byteLength,2_000_000);assert.equal((await readMutation(request(exact))).revision,1);
 envelope.command.workspace.content+='x';await assert.rejects(readMutation(request(JSON.stringify(envelope))),{status:413});
});
