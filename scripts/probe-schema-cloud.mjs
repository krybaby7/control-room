// Closed source-generation probe for a cloud-only workspace outage workaround.
// Emits generated public source metadata, never credentials or workspace data.
import {spawnSync} from 'node:child_process';
import {readdir,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const before=new Set(await readdir('drizzle'));
const result=spawnSync('npm',['run','db:generate','--','--name=devices_runtime'],{stdio:'inherit',shell:false});
if(result.status!==0)process.exit(result.status??1);
const names=(await readdir('drizzle')).filter(name=>!before.has(name)&&/^\d+.*\.sql$/.test(name));
if(names.length!==1)throw new Error('Expected exactly one additive migration.');
const prefix=names[0].split('_')[0];
for(const path of ['drizzle/'+names[0],'drizzle/meta/'+prefix+'_snapshot.json','drizzle/meta/_journal.json']){
 const bytes=await readFile(path);const sha=createHash('sha256').update(bytes).digest('hex');
 const payload=bytes.toString('base64'),chunks=Math.ceil(payload.length/40000);console.log('CONTROL_ROOM_SCHEMA_FILE '+path+' '+sha+' '+bytes.length+' '+chunks);for(let i=0;i<chunks;i++)console.log('CONTROL_ROOM_SCHEMA_CHUNK '+path+' '+i+' '+payload.slice(i*40000,(i+1)*40000));
}
console.log('CONTROL_ROOM_SCHEMA_SOURCE '+process.env.GITHUB_SHA);
