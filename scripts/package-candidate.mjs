// Builds reviewable source/build artifacts only; does not deploy or activate capabilities.
import {validateCandidateBuildPath,validateBridgePackageInventory,isGeneratedFrameworkChunkPath,LOCAL_COMPANION_DOWNLOAD} from '../lib/release-package-policy.ts';
import {buildLocalCompanionArchive} from './package-local-companion.mjs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,readdir,lstat,rm} from 'node:fs/promises';
import {join,relative,resolve} from 'node:path';
if(process.argv.length!==2||process.platform!=='linux'||Number(process.versions.node.split('.')[0])!==24)throw new Error('Use the configured Node 24 Linux cloud packaging job.');
const sourceCommit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',timeout:10000}).trim();
if(!/^[a-f0-9]{40}$/.test(sourceCommit)||process.env.CONTROL_ROOM_SOURCE_COMMIT!==sourceCommit)throw new Error('Exact configured source identity differs.');
if(execFileSync('git',['diff','--name-only','HEAD'],{encoding:'utf8',timeout:10000}).trim())throw new Error('Tracked source changed during verification.');
const root=process.cwd(),output=resolve(root,'release/candidate'),stage=join(output,'build');
const {archive:expectedCompanionArchive}=await buildLocalCompanionArchive();
for(const dir of [join(root,'release'),output]){try{const st=await lstat(dir);if(!st.isDirectory()||st.isSymbolicLink())throw new Error('Unsafe output.');}catch(e){if(e.code!=='ENOENT')throw e;}await mkdir(dir,{recursive:true});}
try{await lstat(stage);throw new Error('Candidate staging already exists; use a fresh verified checkout.');}catch(e){if(e.code!=='ENOENT')throw e;}
await mkdir(stage);let total=0,count=0;const files=[];
async function copyTree(from,to,prefix){const st=await lstat(from);if(st.isSymbolicLink())throw new Error('Build symlinks are not accepted.');if(st.isDirectory()){await mkdir(to,{recursive:true});for(const name of (await readdir(from)).sort()){if(prefix==='dist'&&name==='.openai')continue;if(prefix==='dist'&&!['client','server'].includes(name))throw new Error('Unexpected build root.');if((!/^[A-Za-z0-9_.@+(), -]+$/.test(name)&&!isGeneratedFrameworkChunkPath(prefix+'/'+name))||name==='.'||name==='..')throw new Error('Unsupported build filename.');await copyTree(join(from,name),join(to,name),prefix+'/'+name);}return;}if(!st.isFile()||st.size>64*1024*1024||++count>20000||(total+=st.size)>256*1024*1024)throw new Error('Build package exceeds finite limits.');if(prefix.startsWith('dist/'))validateCandidateBuildPath(prefix);const bytes=await readFile(from);if(prefix===LOCAL_COMPANION_DOWNLOAD&&!bytes.equals(expectedCompanionArchive))throw new Error('Companion download differs from reviewed source inventory.');if(bytes.length!==st.size)throw new Error('Build changed while packaging.');await writeFile(to,bytes,{flag:'wx',mode:0o600});files.push({path:prefix,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}
const dist=join(root,'dist');if(!(await lstat(dist)).isDirectory())throw new Error('Run the production build first.');
await copyTree(dist,join(stage,'dist'),'dist');
if(!files.some(file=>file.path===LOCAL_COMPANION_DOWNLOAD))throw new Error('The local companion download is missing.');
const bridge=join(root,'release/bridge');if(!(await lstat(bridge)).isDirectory())throw new Error('Package the validated bridge first.');
await copyTree(bridge,join(stage,'bridge'),'bridge');
validateBridgePackageInventory(JSON.parse(await readFile(join(stage,'bridge/manifest.json'),'utf8')),files.filter(file=>file.path.startsWith('bridge/')).map(file=>({...file,path:file.path.slice(7)})),sourceCommit);
const sourceName='control-room-source-'+sourceCommit+'.tar';
execFileSync('git',['archive','--format=tar','--prefix=source/','--output='+join(output,sourceName),sourceCommit],{timeout:60000});
const source=await readFile(join(output,sourceName));if(source.length>64*1024*1024)throw new Error('Source archive exceeds finite limit.');
const buildName='control-room-build-'+sourceCommit+'.tar.gz';
execFileSync('tar',['--sort=name','--mtime=@0','--owner=0','--group=0','--numeric-owner','-czf',join(output,buildName),'-C',stage,'.'],{timeout:60000});
const build=await readFile(join(output,buildName));if(build.length>128*1024*1024)throw new Error('Compressed build exceeds finite limit.');
const manifest={format:'control-room-reviewable-candidate',version:1,sourceCommit,node:process.versions.node,artifacts:[{path:sourceName,bytes:source.length,sha256:createHash('sha256').update(source).digest('hex')},{path:buildName,bytes:build.length,sha256:createHash('sha256').update(build).digest('hex')}],files,limitations:['Source and build packaging is not private Site deployment.','Provider execution, Windows owner-device installation and supported private ingress require their own acceptance.','Paid inference and operational/trading effects remain disabled.']};
await writeFile(join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600});await rm(stage,{recursive:true});
console.log(JSON.stringify({sourceCommit,artifacts:manifest.artifacts,manifest:relative(root,join(output,'manifest.json')),deployed:false}));
