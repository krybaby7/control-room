import test from 'node:test';
import assert from 'node:assert/strict';
import {startCompanion,parseCompanionArgs} from '../companion/cli.mjs';
import {resolve} from 'node:path';

test('CLI keeps the private imported chats override only in local connector configuration',async()=>{
 const importedChatsRoot=resolve('synthetic-private-imports'),calls=[];
 assert.equal(parseCompanionArgs(['--imported-chats-root',importedChatsRoot]).importedChatsRoot,importedChatsRoot);
 const runtime=await startCompanion(['--imported-chats-root',importedChatsRoot],{
  createCompanion:async options=>{calls.push(['local',options]);return {close:async()=>{}};},
  loadPersonalCredentials:async()=>({private:true}),
  createPersonalConnector:async options=>{calls.push(['connector',options]);return {start(){},close:async()=>{}};},
 });
 assert.equal(calls[1][1].importedChatsRoot,importedChatsRoot);
 assert.equal(Object.hasOwn(calls[0][1],'importedChatsRoot'),false,'the local HTTP server cannot configure private import paths');
 await runtime.close();
 assert.throws(()=>parseCompanionArgs(['--imported-chats-root']));
});
test('CLI starts outbound connector only when parent private configuration exists and closes both',async()=>{const calls=[];const dependencies={createCompanion:async options=>{calls.push(['local',options]);return {close:async()=>calls.push(['local-close'])};},loadPersonalCredentials:async options=>{calls.push(['credentials',options]);return {private:true};},createPersonalConnector:async options=>{calls.push(['connector',options]);return {start(){calls.push(['start']);},close:async()=>calls.push(['connector-close'])};}};const runtime=await startCompanion(['--state-dir','C:\\private\\reports'],dependencies);assert.equal(calls[2][1].stateDirectory,calls[0][1].stateDirectory);assert.equal(calls[2][1].config.private,true);await runtime.close();assert.deepEqual(calls.slice(-2).map(row=>row[0]),['connector-close','local-close']);});
test('CLI leaves unconfigured old bridge operational and rejects arbitrary options',async()=>{let connector=0;const runtime=await startCompanion([],{createCompanion:async()=>({close:async()=>{}}),loadPersonalCredentials:async()=>null,createPersonalConnector:async()=>{connector++;}});assert.equal(connector,0);await runtime.close();assert.throws(()=>parseCompanionArgs(['--command','arbitrary']));});
test('personal startup keeps browser closed; fixed protocol handler requests only dashboard open',async()=>{const {readFile}=await import('node:fs/promises');const launcher=await readFile(new URL('../scripts/start-local-companion.ps1',import.meta.url),'utf8');assert.match(launcher,/param\(\[switch\]\$OpenDashboard\)/);assert.doesNotMatch(launcher,/Start-Process 'http:\/\/127/);assert.match(launcher,/if \(\$OpenDashboard\).*https:\/\/adami-project-control-center/s);const installer=await readFile(new URL('../scripts/install-personal-companion.ps1',import.meta.url),'utf8');assert.match(installer,/Open-ControlRoom\.ps1/);assert.match(installer,/'-OpenDashboard'/);});
