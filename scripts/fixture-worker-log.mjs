import {StringDecoder} from 'node:string_decoder';
const LIMIT=8*1024*1024,MARKER=Buffer.from('\n[synthetic Worker log middle omitted: finite 8 MiB capture]\n'),HEAD=Math.floor((LIMIT-MARKER.length)/2),TAIL=LIMIT-MARKER.length-HEAD;
const keys=['MF-Proxy-Shared-Secret','PROXY_CONTROLLER_AUTH_SECRET'].flatMap(key=>['"'+key+'"',"'"+key+"'"]);
/** Redact before storage, line truncation or buffer edges. A value may span any
 * number of chunks; it is discarded in a finite state, never accumulated. */
function redactor(){
 const decoder=new StringDecoder('utf8');let pending='',state='key',quote='',escaped=false;
 return {
  write(bytes){
   const output=[];
   for(const char of decoder.write(bytes)){
    if(state==='value'){
     if(escaped){escaped=false;continue;}
     if(char==='\\'){escaped=true;continue;}
     if(char===quote){output.push(char);state='key';}continue;
    }
    if(state==='colon'){
     if(/\s/.test(char)){output.push(char);continue;}
     if(char===':'){output.push(char);state='quote';continue;}
     state='key';
    }else if(state==='quote'){
     if(/\s/.test(char)){output.push(char);continue;}
     if(char==='"'||char==="'"){quote=char;output.push(char+'[local fixture control secret redacted]');state='value';continue;}
     state='key';
    }
    pending+=char;
    while(pending){
     if(keys.includes(pending)){output.push(pending);pending='';state='colon';break;}
     if(keys.some(key=>key.startsWith(pending)))break;
     output.push(pending[0]);pending=pending.slice(1);
    }
   }
   return output.join('');
  },
  // Only a possible key prefix can be pending; sensitive value bytes are never
  // retained. Snapshotting does not consume it if more output arrives later.
  suffix(){return pending;}
 };
}
/** Synthetic fixture output only, with finite raw evidence independent of
 * arbitrarily large lines in Wrangler's serialized bundle/config error data. */
export function createFixtureWorkerLog(){
 let first=Buffer.alloc(0),last=Buffer.alloc(0),bytes=0,safeBytes=0,pending='',summaries=[];const filter=redactor();
 const line=value=>{
  if(/^\s*(?:Error\b|[A-Za-z]+Error\b|Error in |exception\s*=|(?:\[cause\]|cause|name|message|reason)\s*:|=> Error contextual data|.*\[ERROR\])/.test(value)){
   summaries.push(value.length<=2048?value:value.slice(0,1024)+' [line truncated] '+value.slice(-1024));
   while(summaries.length>32)summaries.shift();
  }
 };
 return {
  append(value){
   const input=Buffer.isBuffer(value)?value:Buffer.from(String(value));bytes+=input.length;
   const text=filter.write(input),chunk=Buffer.from(text);safeBytes+=chunk.length;
   if(first.length<HEAD)first=Buffer.concat([first,chunk.subarray(0,HEAD-first.length)]);
   last=Buffer.concat([last,chunk]);if(last.length>TAIL)last=last.subarray(last.length-TAIL);
   const lines=(pending+text).split('\n');pending=lines.pop()??'';
   for(const value of lines)line(value);
   if(pending.length>4096){line(pending.slice(0,2048));pending=pending.slice(-2048);}
  },
  raw(){
   let value;
   if(safeBytes<=HEAD)value=first;
   else if(safeBytes<=HEAD+TAIL)value=Buffer.concat([first,last.subarray(last.length-(safeBytes-HEAD))]);
   else value=Buffer.concat([first,MARKER,last]);
   value=Buffer.concat([value,Buffer.from(filter.suffix())]);
   return value.length<=LIMIT?value:Buffer.concat([value.subarray(0,HEAD),MARKER,value.subarray(-TAIL)]);
  },
  summary(){
   line(pending);const raw=this.raw();
   return 'Synthetic local Worker log evidence ('+bytes+' total bytes; '+(safeBytes>HEAD+TAIL?'middle omitted':'complete sanitized raw capture retained')+'):\n'+
    'Error/cause lines:\n'+(summaries.join('\n')||'[no matching error lines]')+'\nFirst 6000 bytes:\n'+raw.subarray(0,6000).toString()+'\nLast 6000 bytes:\n'+raw.subarray(-6000).toString();
  }
 };
}
