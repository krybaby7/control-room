import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
if(process.argv[2]==='tree'){
 spawn(process.execPath,[fileURLToPath(import.meta.url),'descendant'],{stdio:'inherit',shell:false});
 setInterval(()=>process.stdout.write('parent-alive\n'),25);
}else if(process.argv[2]==='descendant'){
 process.stdout.write('descendant-ready\n');setInterval(()=>process.stdout.write('descendant-alive\n'),25);
}else if(process.argv[2]==='marker'){
 writeFileSync(process.argv[3],'executed');process.stdout.write('finished\n');
}else if(process.argv[2]==='flood'){
 const bytes=Buffer.alloc(8192,120);setInterval(()=>process.stdout.write(bytes),1);
}else if(process.argv[2]==='heartbeat'){
 setInterval(()=>process.stdout.write('unrelated-heartbeat\n'),25);
}else if(process.argv[2]==='silent'){
 setInterval(()=>{},1000);
}else{let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{input+=chunk;});process.stdin.on('end',()=>process.stdout.write(input));}
