import {open,readdir,lstat,unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {verifyExecutionDirectory} from './journal.mjs';
import {shape,id,sha,canonical,fail} from './codec.mjs';
/** Client recovery identity, not a grant. Durable before claim; requires the separately
 * enrolled device credential and private ingress to use. Lease tokens are never written. */
async function prepare({directory,jobId}){
 id(jobId);const filename=sha({jobId})+'.json',names=await readdir(directory);
 const retained=names.filter(name=>name!=='writer.lock');for(const name of retained){if(!/^[a-f0-9]{64}\.json$/u.test(name))fail('unsafe_claim_entry');if(name==='writer.lock')continue;const stat=await lstat(join(directory,name));if(!stat.isFile()||stat.isSymbolicLink())fail('unsafe_claim_entry');}
 if(retained.length>12||!retained.includes(filename)&&retained.length>=12)fail('claim_retention_capacity');const path=join(directory,filename);let fd;
 try{fd=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),0o600);}catch(error){if(error.code!=='EEXIST')throw error;}
 if(fd){const record={schemaVersion:1,jobId,journalNonce:randomBytes(32).toString('hex')};try{await fd.writeFile(canonical(record)+'\n');await fd.sync();}catch{fail('claim_write_uncertain');}finally{await fd.close();}if(process.platform!=='win32'){const dir=await open(directory,'r');try{await dir.sync();}finally{await dir.close();}}return {jobId,journalNonce:record.journalNonce};}
 const read=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));try{const stat=await read.stat();if(!stat.isFile()||stat.size>2048)fail('claim_corrupt_reconcile_required');let record;try{record=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await read.readFile()));}catch{fail('claim_corrupt_reconcile_required');}shape(record,['schemaVersion','jobId','journalNonce']);if(record.schemaVersion!==1||record.jobId!==jobId||typeof record.journalNonce!=='string'||!/^[a-f0-9]{64}$/u.test(record.journalNonce))fail('claim_corrupt_reconcile_required');return {jobId,journalNonce:record.journalNonce};}finally{await read.close();}
}

export async function prepareDurableClaim({directory,jobId,verifyPrivateState}){
 id(jobId);await verifyExecutionDirectory(directory,{create:true,verifyPrivateState});const path=join(directory,'writer.lock'),nonce=randomUUID();let lock;
 try{lock=await open(path,'wx',0o600);}catch(error){if(error.code==='EEXIST')fail('claim_locked_reconcile_required');throw error;}
 let ready=false;try{await lock.writeFile(nonce);await lock.sync();ready=true;return await prepare({directory,jobId});}finally{await lock.close();if(ready){const fd=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));let data;try{data=await fd.readFile('utf8');}finally{await fd.close();}if(data!==nonce)fail('claim_lock_identity_differs');await unlink(path);if(process.platform!=='win32'){const dir=await open(directory,'r');try{await dir.sync();}finally{await dir.close();}}}}
}
