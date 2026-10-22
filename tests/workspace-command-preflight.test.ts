import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './helpers/sqlite.ts';
import {workspaceFixture} from './helpers/workspace.ts';
import {loadWorkspace,type SqlDatabase} from '../lib/workspace-store.ts';
import {executeWorkspaceCommand,canonicalJson,hashJson,type CommandHandlerRegistry} from '../lib/workspace-transaction.ts';
const owner='synthetic-command-preflight',now='2026-10-22T12:00:00.000Z',command={type:'fixture.change'},input={protocolVersion:1,expectedRevision:1,mutationId:'synthetic-preflight-mutation',command};
const handlers:CommandHandlerRegistry=new Map([['fixture.change',{async prepare(context){return {planningAfter:context.before.workspace,writes:[],events:[],jobs:[]};}}]]);
type DigestArgs=Parameters<typeof crypto.subtle.digest>;
function digestText(args:DigestArgs){const input=args[1];return new TextDecoder().decode(input instanceof ArrayBuffer?new Uint8Array(input):new Uint8Array(input.buffer,input.byteOffset,input.byteLength));}
test('actual admission and both exact native hashes overlap while receipt replay remains authoritative',async t=>{
 const f=database();try{
  await loadWorkspace(f.db,owner,workspaceFixture,now);const expectedHash=await hashJson({protocolVersion:1,command}),nativeDigest=crypto.subtle.digest.bind(crypto.subtle);let admissionStarted=false,legacyStarted=false,protocolCalls=0;const wrapped=new WeakMap();
  const db:SqlDatabase={...f.db,prepare(sql){const native=f.db.prepare(sql);if(!sql.startsWith('SELECT e.status epoch_status'))return native;const statement={...native,bind(...values:(string|number|null)[]){native.bind(...values);return this;},async first<T>(){admissionStarted=true;return native.first<T>();}};wrapped.set(statement,native);return statement;},batch(statements){return f.db.batch(statements.map(s=>wrapped.get(s)??s));}};
  t.mock.method(crypto.subtle,'digest',(...args:DigestArgs)=>{const text=digestText(args);if(text===canonicalJson(command))legacyStarted=true;return nativeDigest(...args).then(result=>{if(text===canonicalJson({protocolVersion:1,command})){protocolCalls++;assert.equal(admissionStarted,true);assert.equal(legacyStarted,true);}return result;});});
  const result=await executeWorkspaceCommand(owner,input,{db,now:()=>now,handlers});assert.equal(result.status,'committed');assert.equal(result.status==='committed'&&result.receipt.commandHash,expectedHash);const replay=await executeWorkspaceCommand(owner,input,{db,now:()=>now,handlers});assert.equal(replay.status,'replayed');assert.equal(protocolCalls,2);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_mutations WHERE user_id=?').get(owner)!.n,1);
 }finally{f.sqlite.close();}
});
for(const failure of ['protocol','legacy','admission'] as const)test('independent preflight '+failure+' refusal preserves original failure priority and writes nothing',async t=>{
 const f=database();try{
  await loadWorkspace(f.db,owner,workspaceFixture,now);const nativeDigest=crypto.subtle.digest.bind(crypto.subtle),protocolError=Error('synthetic protocol hash refusal'),legacyError=Error('synthetic legacy hash refusal'),admissionError=Error('synthetic admission refusal');let writes=0,legacySettled=false,admissionSettled=false;
  const db:SqlDatabase={...f.db,prepare(sql){const native=f.db.prepare(sql);if(!sql.startsWith('SELECT e.status epoch_status'))return native;return {...native,bind(...values){native.bind(...values);return this;},async first(){admissionSettled=true;throw admissionError;}};},async batch(statements){writes++;return f.db.batch(statements);}};
  t.mock.method(crypto.subtle,'digest',(...args:DigestArgs)=>{const text=digestText(args);if(text===canonicalJson({protocolVersion:1,command})&&failure==='protocol')return Promise.reject(protocolError);if(text===canonicalJson(command)){legacySettled=true;if(failure!=='admission')return Promise.reject(legacyError);}return nativeDigest(...args);});
  await assert.rejects(executeWorkspaceCommand(owner,input,{db,now:()=>now,handlers}),error=>error===(failure==='protocol'?protocolError:failure==='legacy'?legacyError:admissionError));assert.equal(legacySettled,true);assert.equal(admissionSettled,true);assert.equal(writes,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM workspace_mutations WHERE user_id=?').get(owner)!.n,0);
 }finally{f.sqlite.close();}
});
