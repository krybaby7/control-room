import {open,readdir,lstat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {verifyExecutionDirectory} from './journal.mjs';
import {fileKey,choice,integer,fail} from './codec.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex'),LIMIT=10*1024*1024;
/** Only use while holding the attempt journal's exclusive writer lock.
 * Original bytes are immutable and fsynced before their descriptor enters the journal. */
export async function openExecutionArtifacts({directory,verifyPrivateState}){
 await verifyExecutionDirectory(directory,{create:true,verifyPrivateState});let serial=Promise.resolve();
 async function put({id:artifactId,filename,contentType,data}){
  fileKey(artifactId);fileKey(filename);if(typeof filename!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(filename)||filename.includes('..'))fail('unsafe_artifact_name');choice(contentType,['text/plain','text/markdown','text/x-diff','application/json']);if(!(data instanceof Uint8Array))fail('invalid_artifact_data');integer(data.byteLength,0,LIMIT);
  const selected=Buffer.from(data),sha256=hash(selected),path=join(directory,artifactId),names=await readdir(directory);if(names.length>100)fail('artifact_capacity');let total=0;
  for(const name of names){fileKey(name);const stat=await lstat(join(directory,name));if(!stat.isFile()||stat.isSymbolicLink())fail('unsafe_artifact_entry');total+=stat.size;if(total>LIMIT)fail('artifact_capacity');}
  const descriptor={id:artifactId,filename,contentType,bytes:selected.length,sha256,relativePath:'artifacts/'+artifactId};
  if(names.includes(artifactId)){const existing=await read(artifactId,sha256,selected.length);if(!existing.equals(selected))fail('artifact_identity_differs');return descriptor;}
  if(names.length>=100||total+selected.length>LIMIT)fail('artifact_capacity');const fd=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),0o600);try{await fd.writeFile(selected);await fd.sync();}finally{await fd.close();}
  if(process.platform!=='win32'){const dir=await open(directory,'r');try{await dir.sync();}finally{await dir.close();}}return descriptor;
 }
 async function read(artifactId,sha256,bytes){fileKey(artifactId);integer(bytes,0,LIMIT);const fd=await open(join(directory,artifactId),constants.O_RDONLY|(constants.O_NOFOLLOW??0));try{const stat=await fd.stat();if(!stat.isFile()||stat.size!==bytes)fail('artifact_identity_differs');const data=await fd.readFile();if(hash(data)!==sha256)fail('artifact_identity_differs');return data;}finally{await fd.close();}}
 return Object.freeze({put(raw){const result=serial.then(()=>put(raw));serial=result.catch(()=>{});return result;},read});
}
