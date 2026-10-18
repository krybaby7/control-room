#!/usr/bin/env node
import {isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createLocalExecutor} from './executor.mjs';
export async function executorMain(argv,{write=value=>process.stdout.write(value)}={}){
 if(argv.length===1&&argv[0]==='--help'){write('Usage: node bridge/executor/cli.mjs run --enable-execution --config <absolute-local-config>\nExecution is disabled until an independently verified pinned runtime is installed.\n');return 0;}
 if(argv.length!==4||argv[0]!=='run'||argv[1]!=='--enable-execution'||argv[2]!=='--config'||!isAbsolute(argv[3])||/[\r\n\0]/u.test(argv[3])){write('{"status":"blocked","diagnostic":"policy_blocked"}\n');return 2;}
 const result=await createLocalExecutor().execute();write(JSON.stringify(result)+'\n');return 2;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)process.exitCode=await executorMain(process.argv.slice(2));
