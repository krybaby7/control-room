import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCompanion} from './server.mjs';
import {createPersonalConnector} from './personal-connector.mjs';
import {loadPersonalCredentials} from './personal-credentials.mjs';
import {runRepositoryAnalysis} from './analysis-run.mjs';
import {runProjectBriefing} from './briefing-run.mjs';
import {computeWorkFingerprint} from './briefing-evidence.mjs';
import {readProviderReadiness} from './provider-readiness.mjs';
export function parseCompanionArgs(args){const repositories=[];let stateDirectory=join(process.env.LOCALAPPDATA??process.env.HOME??'.','ControlRoomCompanion','reports'),importedChatsRoot;for(let i=0;i<args.length;i++){if(args[i]==='--repo'&&args[i+1])repositories.push(resolve(args[++i]));else if(args[i]==='--state-dir'&&args[i+1])stateDirectory=resolve(args[++i]);else if(args[i]==='--imported-chats-root'&&args[i+1])importedChatsRoot=resolve(args[++i]);else throw new Error('Usage: node companion/cli.mjs [--repo ABSOLUTE_PATH] [--state-dir PRIVATE_DIRECTORY] [--imported-chats-root PRIVATE_DIRECTORY]');}return {repositories,stateDirectory,...(importedChatsRoot?{importedChatsRoot}:{})};}
export async function startCompanion(args=process.argv.slice(2),dependencies={}){const {importedChatsRoot,...options}=parseCompanionArgs(args),local=await (dependencies.createCompanion??createCompanion)(options);let personal=null;try{const config=await(dependencies.loadPersonalCredentials??loadPersonalCredentials)({stateDirectory:dirname(options.stateDirectory)});if(config){personal=await(dependencies.createPersonalConnector??createPersonalConnector)({config,stateDirectory:options.stateDirectory,importedChatsRoot,analyze:runRepositoryAnalysis,brief:runProjectBriefing,fingerprint:computeWorkFingerprint,readiness:readProviderReadiness});personal.start();}}catch(error){await local.close();throw error;}return {local,personal,async close(){await personal?.close();await local.close();}};}
if(process.argv[1]&&resolve(fileURLToPath(import.meta.url))===resolve(process.argv[1])){const runtime=await startCompanion();console.log('Control Room companion ready. No analysis has started.');for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void runtime.close().then(()=>process.exit(0)));}
