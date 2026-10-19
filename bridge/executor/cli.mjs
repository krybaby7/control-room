#!/usr/bin/env node
import {isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createLocalExecutor,createConfiguredLocalExecutor,installConfiguredLocalRuntime,prepareConfiguredLocalHelper,inspectConfiguredToolPolicy} from './executor.mjs';
const path=value=>typeof value==='string'&&isAbsolute(value)&&!/[\r\n\0]/u.test(value);
function classified(error){const code=error?.code;
 if(['private_ingress_unavailable','device_connection_unavailable','credential_read_failed','windows_current_user_protection_unavailable','agent_authentication_stopped'].includes(code))return {status:'needs_connection',diagnostic:'connection_required',processStarted:false,processExitConfirmed:false,modelVerified:false};
 if(['agent_transport_uncertain','agent_conflict','agent_rate_limited','claim_locked_reconcile_required','executor_locked_reconcile_required','local_budget_corrupt','unaccounted_local_attempt'].includes(code))return {status:'reconcile_required',diagnostic:'retained_state_requires_review',processStarted:false,processExitConfirmed:false,modelVerified:false};
 return {status:'blocked',diagnostic:'configuration_unverified',processStarted:false,processExitConfirmed:false,modelVerified:false};
}
export async function executorMain(argv,{write=value=>process.stdout.write(value)}={}){
 if(argv.length===1&&argv[0]==='--help'){write('Usage:\n  node bridge/executor/cli.mjs run --enable-execution --once --config <absolute-local-launch.json> --job-id <approved-job-id>\n  node bridge/executor/cli.mjs install-runtime --config <absolute-local-launch.json> --archive <absolute-reviewed.tgz>\n  node bridge/executor/cli.mjs prepare-helper --config <absolute-local-launch.json>\n  node bridge/executor/cli.mjs runtime-policy --config <absolute-local-launch.json>\nThe independent launch manifest stays private. Default execution and private ingress remain unavailable.\n');return 0;}
 // Preserve the legacy invocation as disabled; it cannot accidentally activate a
 // new manifest or read protected credentials without the finite --once opt-in.
 if(argv.length===4&&argv[0]==='run'&&argv[1]==='--enable-execution'&&argv[2]==='--config'&&path(argv[3])){write(JSON.stringify(await createLocalExecutor().execute())+'\n');return 2;}
 const run=argv.length===7&&argv[0]==='run'&&argv[1]==='--enable-execution'&&argv[2]==='--once'&&argv[3]==='--config'&&path(argv[4])&&argv[5]==='--job-id'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(argv[6]);
 const install=argv.length===5&&argv[0]==='install-runtime'&&argv[1]==='--config'&&path(argv[2])&&argv[3]==='--archive'&&path(argv[4]);
 const local=argv.length===3&&['prepare-helper','runtime-policy'].includes(argv[0])&&argv[1]==='--config'&&path(argv[2]);
 if(!run&&!install&&!local){write('{"status":"blocked","diagnostic":"policy_blocked"}\n');return 2;}
 const controller=new AbortController(),stop=()=>controller.abort();let result;
 if(run){process.on('SIGINT',stop);process.on('SIGTERM',stop);}
 try{
  if(run){const executor=await createConfiguredLocalExecutor({manifestPath:argv[4]});result=await executor.execute({jobId:argv[6],signal:controller.signal});}
  else if(install)result=await installConfiguredLocalRuntime({manifestPath:argv[2],archivePath:argv[4]});
  else result=argv[0]==='prepare-helper'?await prepareConfiguredLocalHelper({manifestPath:argv[2]}):await inspectConfiguredToolPolicy({manifestPath:argv[2]});
 }catch(error){result=classified(error);}finally{if(run){process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}}
 write(JSON.stringify(result)+'\n');return ['installed','prepared','acknowledged','complete','no_job'].includes(result.status)||local&&argv[0]==='runtime-policy'&&typeof result.sha256==='string'?0:2;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)process.exitCode=await executorMain(process.argv.slice(2));
