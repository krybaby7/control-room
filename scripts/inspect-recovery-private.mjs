// Private recovery inspection only. No D1/R2 mutation, credential import or binding cutover.
import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {captureRecoveryPrivateContinuity,validateRecoveryPrivateContinuity,assessPrivateRecoveryContinuity,PRIVATE_CONTINUITY_LIMITS} from '../lib/recovery-private-continuity.ts';

/** Inject authenticated operator bindings directly; never construct them from portable package JSON.
 * writePrivatePackage must use controlled private storage, not a committed release artifact. */
export async function capturePrivateRecoveryInspection({db,ownerId,expectedManifestSha256,ownerContextHash,sourceContext,now,writePrivatePackage}){
 if(typeof writePrivatePackage!=='function')throw new Error('A controlled private package writer is required.');
 const value=await captureRecoveryPrivateContinuity(db,ownerId,{manifestSha256:expectedManifestSha256,ownerContextHash,sourceContext},now);
 await writePrivatePackage(new TextEncoder().encode(JSON.stringify(value)));
 return {format:value.format,sha256:value.sha256,manifestSha256:value.manifestSha256,...assessPrivateRecoveryContinuity(value)};
}
async function readBounded(path){
 const handle=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
 try{
  const stat=await handle.stat();if(!stat.isFile()||stat.size>PRIVATE_CONTINUITY_LIMITS.bytes)throw new Error('Private continuity file exceeds supported bounds.');
  const parts=[];let total=0;
  for(;;){const bytes=new Uint8Array(65536),{bytesRead}=await handle.read(bytes);if(!bytesRead)break;total+=bytesRead;if(total>PRIVATE_CONTINUITY_LIMITS.bytes)throw new Error('Private continuity file grew beyond supported bounds.');parts.push(bytes.slice(0,bytesRead));}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts,total)));
 }finally{await handle.close();}
}
async function main(){
 const argv=process.argv.slice(2);if(argv.length!==12)throw new Error('Use --package PATH --sha256 PRIVATE_SHA --manifest MANIFEST_SHA --owner-context OWNER_CONTEXT_SHA --source-context JSON --owner-id AUTHENTICATED_OWNER. This command cannot install.');
 const allowed=['--package','--sha256','--manifest','--owner-context','--source-context','--owner-id'],args={};
 for(let i=0;i<argv.length;i+=2){if(!allowed.includes(argv[i])||Object.hasOwn(args,argv[i]))throw new Error('Unknown or duplicate argument.');args[argv[i]]=argv[i+1];}
 if(allowed.some(key=>!args[key]))throw new Error('All trusted expected identities are mandatory.');
 const raw=await readBounded(resolve(args['--package']));
 const value=await validateRecoveryPrivateContinuity(raw,{sha256:args['--sha256'],manifestSha256:args['--manifest'],ownerContextHash:args['--owner-context'],sourceContext:JSON.parse(args['--source-context']),ownerId:args['--owner-id']});
 const assessment=assessPrivateRecoveryContinuity(value);
 console.log(JSON.stringify({format:value.format,sha256:value.sha256,manifestSha256:value.manifestSha256,...assessment}));
 // Valid inspection is still NOT successful installation or release acceptance.
 process.exitCode=2;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{console.error('Private continuity inspection rejected; no installation or cutover occurred.');process.exitCode=1;});
