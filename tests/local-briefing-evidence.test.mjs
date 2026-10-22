import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,mkdir,writeFile,realpath,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {collectBriefingEvidence,computeWorkFingerprint,sanitizeSessions,remoteIdentity,EVIDENCE_LIMITS} from '../companion/briefing-evidence.mjs';
import {validateBriefingEvidence} from '../shared/project-briefing.mjs';
const stamp='2026-10-21T10:00:00.000Z';
const git=(root,...args)=>execFileSync('git',['-C',root,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid',...args],{stdio:['ignore','pipe','ignore']}).toString().trim();
async function fixture(){
 const base=await realpath(await mkdtemp(join(tmpdir(),'briefing-evidence-'))),root=join(base,'repo'),origin=join(base,'origin.git'),codexHome=join(base,'codex'),claudeHome=join(base,'claude');
 await mkdir(root);await mkdir(join(codexHome,'sessions'),{recursive:true});await mkdir(join(claudeHome,'projects'),{recursive:true});
 execFileSync('git',['init','-q','--bare',origin]);execFileSync('git',['init','-q','-b','main',root]);
 await writeFile(join(root,'main.js'),'export const x=1;');git(root,'add','.');git(root,'commit','-q','-m','Start the trading graph');
 git(root,'remote','add','origin',origin);git(root,'push','-q','-u','origin','main');
 // Cloud-only work: a branch pushed from "the cloud" that this PC has not fetched yet.
 const clone=join(base,'cloud');execFileSync('git',['clone','-q',origin,clone]);git(clone,'checkout','-q','-b','claude/reconcile');await writeFile(join(clone,'reconcile.js'),'export const r=1;');git(clone,'add','.');git(clone,'commit','-q','-m','Draft reconciliation of results');git(clone,'push','-q','origin','claude/reconcile');
 // Local-only work plus an uncommitted change and a subject that must be filtered.
 git(root,'checkout','-q','-b','feature/signals');await writeFile(join(root,'signals.js'),'export const s=1;');git(root,'add','.');git(root,'commit','-q','-m','Add signal generation api_key=sk-secretvalue123');git(root,'checkout','-q','main');
 await writeFile(join(root,'notes.md'),'draft');
 const state=new DatabaseSync(join(codexHome,'state_5.sqlite'));state.exec('CREATE TABLE threads(id TEXT,rollout_path TEXT,cwd TEXT,updated_at_ms INTEGER,archived INTEGER,thread_source TEXT,agent_path TEXT,git_sha TEXT,git_origin_url TEXT)');state.close();
 const history=new DatabaseSync(join(codexHome,'thread_history_1.sqlite'));history.exec('CREATE TABLE thread_items(thread_id TEXT,item_type TEXT,rollout_ordinal INTEGER,created_at_ms INTEGER,item_json TEXT); CREATE INDEX items ON thread_items(thread_id,rollout_ordinal)');history.close();
 return {base,root,origin,clone,codexHome,claudeHome,async close(){await rm(base,{recursive:true,force:true});}};
}
async function addCodexChat(f,id,updated,messages){const rollout=join(f.codexHome,'sessions',id+'.jsonl');await writeFile(rollout,JSON.stringify({type:'session_meta',payload:{id,cwd:f.root,thread_source:'user'}})+'\n');const db=new DatabaseSync(join(f.codexHome,'state_5.sqlite'));db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?)').run(id,rollout,f.root,updated,0,'user',null,null,null);db.close();const history=new DatabaseSync(join(f.codexHome,'thread_history_1.sqlite'));for(const [i,m] of messages.entries()){const item=m.role==='user'?{type:'userMessage',content:[{type:'text',text:m.text}]}:{type:'agentMessage',phase:'final_answer',text:m.text};history.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?)').run(id,item.type,i,updated+i,JSON.stringify(item));}history.close();}
async function addClaudeChat(f,sessionId,time,messages){const folder=join(f.claudeHome,'projects',f.root.replace(/[^a-zA-Z0-9]/gu,'-').toLowerCase());await mkdir(folder,{recursive:true});let parent=null;const rows=messages.map((m,i)=>{const row={type:m.role,cwd:f.root,sessionId,uuid:`${sessionId}-${i}`,parentUuid:parent,isSidechain:false,timestamp:new Date(Date.parse(time)+i*1000).toISOString(),message:{role:m.role,content:m.role==='assistant'?[{type:'text',text:m.text}]:m.text}};parent=row.uuid;return row;});await writeFile(join(folder,sessionId+'.jsonl'),rows.map(r=>JSON.stringify(r)).join('\n')+'\n');}
test('evidence pack sees local, cloud and uncommitted work, several chats per provider, and filters secrets',async()=>{
 const f=await fixture();try{
  await addCodexChat(f,'older',Date.parse(stamp)-3600000,[{role:'user',text:'Finish the signal generation.'},{role:'assistant',text:'Signal generation is done on branch feature/signals.'}]);
  await addCodexChat(f,'newer',Date.parse(stamp),[{role:'user',text:'What is left?'},{role:'assistant',text:'Reconciliation remains. Token ghp_abcdefghijklmnop1234 must never appear.'}]);
  await addClaudeChat(f,'session-a',stamp,[{role:'user',text:'Please reconcile results in the cloud at C:\\Users\\owner\\repo.'},{role:'assistant',text:'Started a draft on claude/reconcile.'}]);
  const evidence=await collectBriefingEvidence(f.root,{now:()=>'2026-10-21T12:00:00.000Z',codexHome:f.codexHome,claudeHome:f.claudeHome,pullRequests:async()=>{throw new Error('pull requests are only read for GitHub remotes');}});
  const {bundle,summary}=evidence;
  assert.equal(summary.cloud.status,'fetched');assert.equal(summary.cloud.remote,'local-remote');assert.equal(summary.cloud.pullRequests,null);assert.equal(summary.cloud.branches,2);assert.equal(summary.local.branches,2);assert.equal(summary.local.branch,'main');assert.equal(summary.local.uncommittedFiles,1);
  assert.deepEqual(summary.chats.map(row=>[row.provider,row.status,row.sessions,row.messages]),[['codex','included',2,3],['claude','included',1,2]]);
  assert.deepEqual(validateBriefingEvidence({...summary,plan:null}),{...summary,plan:null});
  const cloud=bundle.cloudBranches.find(row=>row.name==='origin/claude/reconcile');assert.ok(cloud);assert.equal(cloud.scope,'cloud');assert.equal(cloud.merged,false);assert.equal(cloud.ahead,1);assert.equal(cloud.commits[0].subject,'Draft reconciliation of results');
  const local=bundle.localBranches.find(row=>row.name==='feature/signals');assert.ok(local);assert.equal(local.commits[0].subject,'[filtered]');
  assert.ok(bundle.localBranches.find(row=>row.name==='main').isDefault===false||bundle.repository.defaultBranch==='origin/main');
  assert.deepEqual(bundle.uncommitted.paths,['notes.md']);
  const text=JSON.stringify(bundle);assert.ok(!text.includes('ghp_abcdefghijklmnop1234'));assert.ok(!text.includes('C:\\\\Users'));assert.ok(text.includes('[local path]'));assert.ok(text.includes('Finish the signal generation.'));
  assert.equal(bundle.chats[0].sessions[0].messages.length,1);assert.equal(bundle.chats[0].sessions[1].messages.length,2);assert.ok(Date.parse(bundle.chats[0].sessions[0].latestAt)>Date.parse(bundle.chats[0].sessions[1].latestAt));
  assert.ok(Buffer.byteLength(text)<=EVIDENCE_LIMITS.bundleBytes);assert.match(evidence.fingerprint,/^[a-f0-9]{64}$/);
  // The same state yields the same fingerprint; new cloud work changes it even without local changes.
  assert.equal(await computeWorkFingerprint(f.root,{codexHome:f.codexHome,claudeHome:f.claudeHome}),evidence.fingerprint);
  await writeFile(join(f.clone,'more.js'),'export const m=1;');git(f.clone,'add','.');git(f.clone,'commit','-q','-m','More reconciliation');git(f.clone,'push','-q','origin','claude/reconcile');
  assert.notEqual(await computeWorkFingerprint(f.root,{codexHome:f.codexHome,claudeHome:f.claudeHome}),evidence.fingerprint);
  // Working tree and history untouched by the read-only collection.
  assert.equal(git(f.root,'status','--porcelain'),'?? notes.md');assert.equal(git(f.root,'rev-parse','--abbrev-ref','HEAD'),'main');
 }finally{await f.close();}
});
test('no remote, unreachable remote and absent chats degrade honestly',async()=>{
 const f=await fixture();try{
  git(f.root,'remote','remove','origin');
  const none=await collectBriefingEvidence(f.root,{now:()=>'2026-10-21T12:00:00.000Z',codexHome:f.codexHome,claudeHome:f.claudeHome});
  assert.equal(none.summary.cloud.status,'no-remote');assert.equal(none.summary.cloud.remote,null);assert.equal(none.summary.cloud.pullRequests,null);assert.deepEqual(none.summary.chats.map(row=>row.status),['not-found','not-found']);
  git(f.root,'remote','add','origin','https://github.com/example/trade-graph.git');
  const unreachable=await collectBriefingEvidence(f.root,{now:()=>'2026-10-21T12:00:00.000Z',codexHome:f.codexHome,claudeHome:f.claudeHome,pullRequests:async()=>[{number:3,title:'Reconcile',state:'open',draft:false,head:'claude/reconcile',base:'main',updatedAt:stamp,mergedAt:null,review:null,author:'bot'},{number:2,title:'Signals',state:'merged',draft:false,head:'feature/signals',base:'main',updatedAt:stamp,mergedAt:stamp,review:'APPROVED',author:'owner'}]});
  assert.equal(unreachable.summary.cloud.remote,'github.com/example/trade-graph');assert.equal(unreachable.summary.cloud.status,'unavailable');assert.equal(unreachable.summary.cloud.pullRequests,2);assert.equal(unreachable.summary.cloud.openPullRequests,1);assert.equal(unreachable.bundle.repository.fetchError!==null,true);
  const skipped=await collectBriefingEvidence(f.root,{now:()=>'2026-10-21T12:00:00.000Z',fetchRemote:false,codexHome:f.codexHome,claudeHome:f.claudeHome,pullRequests:async()=>null});
  assert.equal(skipped.summary.cloud.status,'unavailable');assert.equal(skipped.summary.cloud.fetchedAt,null);
 }finally{await f.close();}
});
test('session sanitizer bounds sessions, drops credential messages and reports coverage',()=>{
 const sessions=Array.from({length:7},(_,i)=>({latestAt:new Date(Date.parse(stamp)-i*1000).toISOString(),messages:[{role:'user',text:'ok '+'x'.repeat(2000)},{role:'assistant',text:'Bearer abcdefghijklmnopqrstuvwxyz'},{role:'assistant',text:'done'}],truncated:false}));
 const result=sanitizeSessions({status:'included',sessions},'codex');
 assert.equal(result.sessions.length,EVIDENCE_LIMITS.sessionsPerProvider);assert.equal(result.summary.sessions,5);assert.equal(result.summary.messages,10);assert.equal(result.summary.status,'included');
 assert.ok(result.sessions.every(session=>session.truncated&&session.messages.every(row=>!row.text.includes('Bearer'))));
 assert.ok(result.sessions.every(session=>session.messages[0].text.length<=EVIDENCE_LIMITS.charactersPerMessage));
 assert.deepEqual(sanitizeSessions({status:'not-found',messages:[]},'claude').summary,{provider:'claude',status:'not-found',sessions:0,messages:0,latestAt:null});
 assert.equal(remoteIdentity('git@github.com:Example/Trade-Graph.git'),'github.com/Example/Trade-Graph');assert.equal(remoteIdentity('https://user:pw@github.com/a/b?x=1'),'local-remote');assert.equal(remoteIdentity('C:\\repos\\origin'),'local-remote');assert.equal(remoteIdentity(''),null);
});
