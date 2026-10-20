import {open,readdir,lstat,unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {verifyExecutionDirectory,openExecutionJournal} from './journal.mjs';
import {sha,fail} from './codec.mjs';
/** Separate from telemetry. No acknowledged or pending attempt is evicted automatically.
 * At 12 retained attempts the owner must explicitly archive/reconcile, not lose data. */
export async function openExecutorStore({directory,verifyPrivateState}){
 await verifyExecutionDirectory(directory,{create:true,verifyPrivateState});const path=join(directory,'executor.lock'),nonce=randomUUID();let lock;
 try{lock=await open(path,'wx',0o600);}catch(error){if(error.code==='EEXIST')fail('executor_locked_reconcile_required');throw error;}
 try{await lock.writeFile(nonce);await lock.sync();}catch(error){await lock.close();throw error;}let closed=false,active=null,opening=false;
 return Object.freeze({
  async openAttempt(identity){
   if(closed||active||opening)fail('executor_slot_unavailable');opening=true;try{const name=sha(identity),names=(await readdir(directory)).filter(value=>/^[a-f0-9]{64}$/u.test(value));if(!names.includes(name)&&names.length>=12)fail('executor_retention_capacity');
   for(const entry of names){const stat=await lstat(join(directory,entry));if(!stat.isDirectory()||stat.isSymbolicLink())fail('unsafe_attempt_directory');}
   const journal=await openExecutionJournal({directory:join(directory,name),identity,verifyPrivateState});active=journal;
   return Object.freeze({snapshot:journal.snapshot,append:journal.append,async close(){if(active!==journal)return;await journal.close();active=null;}});}finally{opening=false;}
  },
  async close(){if(closed)return;if(opening)fail('executor_busy');if(active)await active.close();const check=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));let text;try{text=await check.readFile('utf8');}finally{await check.close();}if(text!==nonce)fail('executor_lock_identity_differs');await lock.close();await unlink(path);closed=true;}
 });
}
