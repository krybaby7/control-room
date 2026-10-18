/** Pure packaging inventory validation. This does not attest to deployment or provider installation. */
export interface CandidatePackageFile {path:string;bytes:number;sha256:string}
const SHA=/^[a-f0-9]{64}$/,COMMIT=/^[a-f0-9]{40}$/;
function fail():never{throw new Error('Candidate package inventory is invalid.');}
function object(raw:unknown,keys:readonly string[]):Record<string,unknown>{if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.getPrototypeOf(raw)!==Object.prototype)fail();const value=raw as Record<string,unknown>;if(Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))fail();return value;}
function text(raw:unknown,max=256):string{if(typeof raw!=='string'||!raw||raw.length>max||/[\u0000-\u001f\u007f]/u.test(raw))fail();return raw;}
function digest(raw:unknown):string{const value=text(raw,64);if(!SHA.test(value))fail();return value;}
function bytes(raw:unknown,max=128*1024*1024):number{if(typeof raw!=='number'||!Number.isSafeInteger(raw)||raw<0||raw>max)fail();return raw;}
function file(raw:unknown):CandidatePackageFile{const value=object(raw,['path','bytes','sha256']);return {path:text(value.path,1024),bytes:bytes(value.bytes),sha256:digest(value.sha256)};}
/** Paths are POSIX relative inventory names. Private build metadata is deliberately excluded. */
export function validateCandidateBuildPath(raw:unknown):string{
 const path=text(raw,1024),parts=path.split('/');
 if(parts.length<3||parts[0]!=='dist'||!['client','server'].includes(parts[1])||parts.some(part=>!part||part==='.'||part==='..'||!/^[A-Za-z0-9_@+(), .-]+$/u.test(part)||part.endsWith(' ')||part.endsWith('.')))fail();
 for(const part of parts.slice(2)){if(part.startsWith('.')||/^(?:\.?(?:env|dev\.vars)(?:\.|$)|\.wrangler$|\.openai$|node_modules$|(?:credentials?|secrets?|tokens?|passwords?|private[-_]?keys?|owner[-_]?data|runtime[-_]?state|outbox|journal)(?:\.|$))/iu.test(part)||/\.(?:sqlite3?|db|pem|key|p12|pfx|log|ndjson|tgz|tar|gz|zip)$/iu.test(part))fail();}
 const name=parts.at(-1)!;
 if(!/\.(?:m?js|cjs|css|map|json|html|txt|xml|webmanifest|wasm|woff2?|ttf|otf|eot|svg|png|jpe?g|gif|webp|avif|ico)$/iu.test(name)&&!['_headers','_redirects'].includes(name))fail();
 return path;
}
const bridgePath=/^(?:package\.json|README\.md|config\.example\.json|src\/[a-z0-9-]+\.mjs|windows\/[a-z0-9-]+\.ps1|executor\/[a-z0-9-]+\.mjs|executor\/README\.md|executor\/config\.example\.json)$/;
/** The build may carry only the exact freshly identified bridge tarball and its manifest. */
export function validateBridgePackageInventory(raw:unknown,actualRaw:readonly CandidatePackageFile[],sourceCommit:string):void{
 if(!COMMIT.test(sourceCommit))fail();
 const manifest=object(raw,['format','version','sourceCommit','filename','bytes','sha256','files','acceptance']);
 if(manifest.format!=='control-room-bridge-package'||manifest.version!==1||manifest.sourceCommit!==sourceCommit)fail();
 const filename=text(manifest.filename);if(!/^control-room-windows-bridge-[0-9]+\.[0-9]+\.[0-9]+\.tgz$/u.test(filename))fail();
 const size=bytes(manifest.bytes),hash=digest(manifest.sha256),acceptance=object(manifest.acceptance,['automated','windows','privateIngress','execution']);
 if(acceptance.automated!=='See source-specific CI checks.'||acceptance.windows!=='not-run'||acceptance.privateIngress!=='unavailable'||acceptance.execution!=='disabled')fail();
 if(!Array.isArray(manifest.files)||manifest.files.length<10||manifest.files.length>100)fail();
 const inventory=manifest.files.map(file);if(new Set(inventory.map(row=>row.path)).size!==inventory.length||inventory.some(row=>!bridgePath.test(row.path)))fail();
 const required=['package.json','src/cli.mjs','src/credentials.mjs','src/transport.mjs','windows/protect-credential.ps1','windows/run-bridge.ps1','windows/install-task.ps1','windows/uninstall-task.ps1','config.example.json','executor/cli.mjs','executor/runtime.mjs','executor/journal.mjs','executor/config.example.json'];
 if(required.some(path=>!inventory.some(row=>row.path===path))||inventory.reduce((sum,row)=>sum+row.bytes,0)>128*1024*1024)fail();
 if(!Array.isArray(actualRaw)||actualRaw.length!==2)fail();const actual=actualRaw.map(file);
 if(new Set(actual.map(row=>row.path)).size!==2||!actual.some(row=>row.path==='manifest.json')||!actual.some(row=>row.path===filename&&row.bytes===size&&row.sha256===hash))fail();
}
