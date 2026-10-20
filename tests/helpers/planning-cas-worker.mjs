import {parentPort,workerData} from 'node:worker_threads';
import {openPlanningCasDatabase} from './planning-cas-database.ts';
import {executeWorkspaceCommand} from '../../lib/workspace-transaction.ts';
import {planningHandlers} from '../../lib/planning-module.ts';
if(!parentPort)throw new Error('Synthetic CAS worker requires its fixture parent.');
const fixture=openPlanningCasDatabase(workerData.path);
try{
 const result=await executeWorkspaceCommand('a',{protocolVersion:1,expectedRevision:workerData.revision,mutationId:workerData.mutationId,command:workerData.command},{db:fixture.db,now:()=>workerData.now,handlers:planningHandlers});
 fixture.sqlite.close();parentPort.postMessage({status:result.status});parentPort.close();
}catch(error){fixture.sqlite.close();parentPort.postMessage({error:error instanceof Error?error.message:'Synthetic worker failed.'});parentPort.close();}
