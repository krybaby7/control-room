import type {BackupArchiveChunk,BackupArchiveStorage} from './backup-archive-storage.ts';
/** A cancelled consumer settles its already-started bounded GET before disposal.
 * It does not abort the native body early or start another physical operation. */
export function backupArchiveObjectStream(storage:Pick<BackupArchiveStorage,'get'>,namespace:string,chunks:readonly BackupArchiveChunk[],signal?:AbortSignal):ReadableStream<Uint8Array>{
 let part=0,cancelled=false,pending:Promise<void>|null=null;
 return new ReadableStream<Uint8Array>({
  pull(controller){
   if(cancelled)return;
   const work=(async()=>{try{
    if(signal?.aborted)throw new Error('Backup archive was cancelled before its next storage operation.');
    if(part===chunks.length){controller.close();return;}
    const bytes=await storage.get(namespace,chunks[part++],signal);
    if(cancelled)return;
    if(!bytes)throw new Error('A reserved archive object is missing.');
    controller.enqueue(bytes);
   }catch(error){if(!cancelled)controller.error(error);}})();
   pending=work;
   return work.finally(()=>{if(pending===work)pending=null;});
  },
  async cancel(){cancelled=true;await pending;}
 });
}
