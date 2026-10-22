import {createReadStream} from 'node:fs';
import {Readable} from 'node:stream';
import {createGunzip,createZstdDecompress} from 'node:zlib';
import {readJsonl} from './jsonl.mjs';
/** Native Node 24 codecs. Decompressed bytes are bounded by readJsonl, including bombs. */
export async function* readCompressedJsonl(path,options={}){
 const compression=options.compression??(typeof path==='string'&&/\.(?:gz|gzip)$/iu.test(path)?'gzip':typeof path==='string'&&/\.(?:zst|zstd)$/iu.test(path)?'zstd':'none');
 if(!['none','gzip','zstd'].includes(compression))throw Error('Unsupported compressed JSONL codec.');
 if(compression==='none'){yield* readJsonl(typeof path==='string'?path:Readable.from([path]),options);return;}
 options.signal?.throwIfAborted();
 const source=typeof path==='string'?createReadStream(path,{signal:options.signal,highWaterMark:16*1024}):Readable.from([path]),decoder=compression==='gzip'?createGunzip():createZstdDecompress();
 source.on('error',error=>decoder.destroy(error));source.pipe(decoder);
 try{yield* readJsonl(decoder,options);}catch(error){if(options.signal?.aborted||error?.name==='AbortError')throw error;yield {kind:'gap',code:'corrupt_compressed',line:0,offset:0,terminal:true};}finally{source.destroy();decoder.destroy();}
}
