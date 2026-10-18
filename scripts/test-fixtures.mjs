import {readFile,mkdtemp,mkdir,writeFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
export const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const SYNTHETIC_DB_ID='00000000-0000-4000-8000-000000000000';
export const FIXTURE_ORIGIN='http://127.0.0.1:4173';
export const WORKER_ORIGIN='http://127.0.0.1:4174';
export function parseFixtureArgs(args){
 if(!args.includes('--target')||args[args.indexOf('--target')+1]!=='local-fixture')throw new Error('--target local-fixture is mandatory.');
 const expected=args.includes('--serve')?['--target','local-fixture','--serve']:['--target','local-fixture'];
 if(args.length!==expected.length||args.some((value,index)=>value!==expected[index]))throw new Error('Only --target local-fixture [--serve] is supported.');
 return {serve:args.includes('--serve')};
}
/** Construct an independent local-only config, never reuse deployment bindings or credentials. */
export function fixtureConfig(source){
 if(source.d1_databases?.some(db=>db.database_id!==SYNTHETIC_DB_ID||db.remote))throw new Error('Refusing a real or remote database identifier.');
 for(const key of ['r2_buckets','services','kv_namespaces','hyperdrive','workflows','vectorize','pipelines','mtls_certificates'])if(source[key]?.length)throw new Error(`Refusing fixture config with ${key}.`);
 if(source.ai||source.browser||source.unsafe?.bindings?.length||source.durable_objects?.bindings?.length||source.queues?.producers?.length||source.queues?.consumers?.length)throw new Error('Refusing remote or executable fixture bindings.');
 if(source.main!=='index.js'||source.assets?.directory!=='../client')throw new Error('Unexpected built worker entry points.');
 return {name:'control-room-local-fixture',main:path.join(ROOT,'dist/server/index.js'),compatibility_date:source.compatibility_date,compatibility_flags:['nodejs_compat'],no_bundle:true,rules:[{type:'ESModule',globs:['**/*.js','**/*.mjs']}],base_dir:path.join(ROOT,'dist/server'),assets:{directory:path.join(ROOT,'dist/client')},d1_databases:[{binding:'DB',database_name:'control-room-synthetic',database_id:SYNTHETIC_DB_ID}],dev:{ip:'127.0.0.1',port:4174,local_protocol:'http'},observability:{enabled:false}};
}
export function fixtureEnvironment(directory){
 return {PATH:process.env.PATH??'',XDG_CONFIG_HOME:path.join(directory,'config'),XDG_CACHE_HOME:path.join(directory,'cache'),TMPDIR:directory,WRANGLER_SEND_METRICS:'false',CI:'true',NO_COLOR:'1',NODE_ENV:'test'};
}
const fixtureChildren=new Set();
export async function runLocal(executable,args,options={}){
 return new Promise((resolve,reject)=>{const child=spawn(executable,args,{shell:false,cwd:ROOT,...options,stdio:['ignore','pipe','pipe']});fixtureChildren.add(child);const timeout=setTimeout(()=>child.kill('SIGKILL'),60000);let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',data=>{output=(output+data.toString()).slice(-16000);});child.once('error',error=>{clearTimeout(timeout);fixtureChildren.delete(child);reject(error);});child.once('exit',code=>{clearTimeout(timeout);fixtureChildren.delete(child);if(code===0)resolve(output);else reject(new Error(`Fixture subprocess exited ${code}: ${output}`));});});
}
export async function prepareFixtures(){
 const directory=await mkdtemp(path.join(tmpdir(),'control-room-fixture-'));
 const interrupted=()=>{for(const child of fixtureChildren)child.kill('SIGKILL');void rm(directory,{recursive:true,force:true}).finally(()=>process.exit(1));};
 process.once('SIGTERM',interrupted);process.once('SIGINT',interrupted);
 try{
  await mkdir(path.join(directory,'config'));const configPath=path.join(directory,'wrangler.json');const source=JSON.parse(await readFile(path.join(ROOT,'dist/server/wrangler.json'),'utf8'));await writeFile(configPath,JSON.stringify(fixtureConfig(source)));
  const statePath=path.join(directory,'state');const environment=fixtureEnvironment(directory);const wrangler=path.join(ROOT,'node_modules/wrangler/bin/wrangler.js');
  const execute=async file=>runLocal(process.execPath,[wrangler,'d1','execute','DB','--local','--config',configPath,'--persist-to',statePath,'--file',file],{env:environment});
  const migrations=(await readdir(path.join(ROOT,'drizzle'))).filter(name=>/^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();if(!migrations.length)throw new Error('No actual migrations found.');
  for(const migration of migrations)await execute(path.join(ROOT,'drizzle',migration));
  // Node 24 strip-types imports the same synthetic rehearsal fixture and production codec.
  const {migrationFixture,migrationSavedAt}=await import('../tests/fixtures/migration.ts');const {parsePlanningImport,encodePlanning}=await import('../lib/workspace-codec.ts');
  const workspace=parsePlanningImport(migrationFixture(),migrationSavedAt);const content=encodePlanning(workspace);const quote=value=>`'${value.replaceAll("'","''")}'`;
  const seedPath=path.join(directory,'seed.sql');await writeFile(seedPath,['synthetic-a','synthetic-b'].map(owner=>`INSERT INTO workspaces(user_id,content,revision,updated_at) VALUES(${quote(owner)},${quote(content)},1,${quote(migrationSavedAt)});`).join('\n'));await execute(seedPath);
  return {directory,configPath,statePath,environment,wrangler,cleanup:()=>rm(directory,{recursive:true,force:true})};
 }catch(error){await rm(directory,{recursive:true,force:true});throw error;}finally{process.removeListener('SIGTERM',interrupted);process.removeListener('SIGINT',interrupted);}
}
