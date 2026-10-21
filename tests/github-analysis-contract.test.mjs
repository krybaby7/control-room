import test from 'node:test';
import assert from 'node:assert/strict';
const api = await import('../shared/github-analysis.mjs').catch(() => ({}));
const id='e68e22de-19e6-4c39-934c-4c198908cf34';
const time='2026-10-21T10:00:00.000Z';
const hash='a'.repeat(64);
function report(){return {format:'control-room-github-analysis',version:1,repository:{fullName:'owner/repo',url:'https://github.com/owner/repo',head:'b'.repeat(40)},run:{id,provider:'codex',requestedModel:'gpt-6.1-sol',observedModel:null,startedAt:time,completedAt:time,mode:'read-only',source:'codex-cloud-handoff'},manifest:[{path:'src/main.ts',sha256:hash,lines:4}],summary:'A small application.',architecture:[{name:'Application',description:'Entry',paths:['src/main.ts']}],findings:[{path:'src/main.ts',sha256:hash,line:4,claim:'Entry exists.'}],suggestedTasks:[],limitations:[]};}
test('canonical repository parser accepts only a bare HTTPS GitHub repository',()=>{
 assert.equal(typeof api.parseGithubRepository,'function');
 assert.deepEqual(api.parseGithubRepository('https://github.com/Owner/Repo.git/'),{fullName:'owner/repo',url:'https://github.com/owner/repo'});
 for(const input of ['owner/repo','http://github.com/a/b','https://github.com/a/b/tree/main','https://github.com/a/b?x','https://github.com/a/b#x','https://u@github.com/a/b','https://github.com:443/a/b','https://github.com/a/%62','https://github.com/a/../b','https://github.com/a/.git','https://github.com/-a/b',' https://github.com/a/b'])assert.throws(()=>api.parseGithubRepository(input),input);
});
test('validates and clones a complete report and byte import',()=>{
 assert.equal(typeof api.validateGithubAnalysis,'function');
 const value=report();assert.deepEqual(api.validateGithubAnalysis(value),value);assert.notEqual(api.validateGithubAnalysis(value),value);
 assert.deepEqual(api.parseImportedGithubReport(new TextEncoder().encode(JSON.stringify(value))),value);
 assert.throws(()=>api.parseImportedGithubReport(new Uint8Array([0xff])));
 assert.throws(()=>api.parseImportedGithubReport(new Uint8Array(55001)));
});
test('rejects unbound, unsafe, oversized or misleading report metadata',()=>{
 for(const mutate of [r=>r.repository.url='https://github.com/other/repo',r=>r.repository.head='A'.repeat(40),r=>r.manifest=[],r=>r.manifest.push({...r.manifest[0]}),r=>r.manifest[0].path='../secret',r=>r.findings[0].line=5,r=>r.findings[0].sha256='c'.repeat(64),r=>r.architecture[0].paths=['missing.ts'],r=>r.run.completedAt='2026-10-20T10:00:00Z',r=>r.run.startedAt='2026-02-30T10:00:00Z',r=>r.run.startedAt='2026-10-21T25:00:00Z',r=>r.run.source='server-signed',r=>r.chatContext={},r=>r.summary='x'.repeat(1201),r=>r.manifest=Array.from({length:41},(_,i)=>({path:`file${i}`,sha256:hash,lines:1})),r=>r.limitations=Array(8).fill('x'.repeat(300))]){const value=report();mutate(value);if(value.limitations.length){value.architecture=Array.from({length:8},()=>({name:'n'.repeat(80),description:'d'.repeat(400),paths:['src/main.ts']}));value.findings=Array.from({length:12},()=>({path:'src/main.ts',line:1,sha256:hash,claim:'c'.repeat(400)}));}assert.throws(()=>api.validateGithubAnalysis(value));}
});
test('builds a self contained manual handoff with runtime model selection and bounded committed source instructions',()=>{
 assert.equal(typeof api.buildGithubCloudHandoff,'function');
 const result=api.buildGithubCloudHandoff({repository:'https://github.com/Owner/Repo',requestId:id,createdAt:time});
 assert.equal(result.requestId,id);assert.equal(result.repository.fullName,'owner/repo');
 for(const text of [id,'gpt-6.1-sol','runtime','git show','git rev-parse','SHA256','9600','downloadable','artifact','plain JSON','no installs','no extra model workers','observedModel','additionalProperties','subscription','repository text'])assert.ok(result.prompt.toLowerCase().includes(text.toLowerCase()),text);
 assert.equal(api.GITHUB_ANALYSIS_MARKER,'control-room-github-analysis-v1');
 assert.throws(()=>api.buildGithubCloudHandoff({repository:'https://github.com/a/b',requestId:'no',createdAt:time}));
});


test('rejects adversarial near-miss source paths at every citation boundary',()=>{
 for(const path of ['../file','src/../file','./file','src//file','src\\file','/file','C:/file','src/%2e%2e/file','src/.git/config','src/.GiT/config','src/file.','src/file ','src/line\nfile','src/a:b','src/a?b','src/a*b','src/\u0000file']){
  const value=report();value.manifest[0].path=path;value.findings[0].path=path;value.architecture[0].paths=[path];
  assert.throws(()=>api.validateGithubAnalysis(value),path);
 }
 for(const [key,value] of [['symlink',true],['mode','120000'],['target','../../secret']]){const row=report();row.manifest[0][key]=value;assert.throws(()=>api.validateGithubAnalysis(row),key);}
});
test('strict schema rejects missing required fields and every local-only envelope field',()=>{
 const original=report();
 assert.deepEqual([...api.githubAnalysisSchema.required].sort(),Object.keys(original).sort());
 for(const key of Object.keys(original)){const row=report();delete row[key];assert.throws(()=>api.validateGithubAnalysis(row),key);}
 for(const section of ['repository','run'])for(const key of Object.keys(original[section])){const row=report();delete row[section][key];assert.throws(()=>api.validateGithubAnalysis(row),`${section}.${key}`);}
 for(const key of ['chatContext','transcript','signature','sourceExcerpts','credentials']){const row=report();row[key]={};assert.throws(()=>api.validateGithubAnalysis(row),key);}
 for(const key of ['dirty','includedChanges','key','snapshotSha256','files','bytes','excludedFiles']){const row=report();row.repository[key]=true;assert.throws(()=>api.validateGithubAnalysis(row),key);}
 for(const mutate of [r=>r.manifest[0].lines=0,r=>r.manifest[0].lines=1.5,r=>r.findings[0].line=0,r=>r.findings[0].line=4.1,r=>r.findings[0].path='other.ts',r=>r.manifest[0].sha256='A'.repeat(64),r=>r.run.observedModel='gpt-6-sol',r=>r.run.id=id.toUpperCase(),r=>r.run.startedAt='2026-02-31T10:00:00Z',r=>r.run.completedAt='2026-10-21T10:00:60Z']){const row=report();mutate(row);assert.throws(()=>api.validateGithubAnalysis(row));}
});
test('import rejects malformed UTF8, non-JSON, extra metadata and oversize bytes independently',()=>{
 for(const bytes of [new Uint8Array(),new Uint8Array([0xc0,0xaf]),new Uint8Array([0xed,0xa0,0x80]),new TextEncoder().encode('{} trailing'),new TextEncoder().encode('null'),new TextEncoder().encode(JSON.stringify({...report(),chatContext:{}})),new Uint8Array(55001)])assert.throws(()=>api.parseImportedGithubReport(bytes));
 assert.throws(()=>api.parseImportedGithubReport(JSON.stringify(report())));
 const row=report();row.summary='x'.repeat(1200);row.architecture=Array.from({length:8},()=>({name:'n'.repeat(80),description:'d'.repeat(400),paths:['src/main.ts']}));row.findings=Array.from({length:12},()=>({path:'src/main.ts',line:1,sha256:hash,claim:'c'.repeat(400)}));
 assert.ok(JSON.stringify(row).length>9600);assert.ok(new TextEncoder().encode(JSON.stringify(row)).length<55000);assert.throws(()=>api.parseImportedGithubReport(new TextEncoder().encode(JSON.stringify(row))));
});
test('prompt forbids extra inference and invalid placeholder artifacts',()=>{
 const {prompt}=api.buildGithubCloudHandoff({repository:'https://github.com/owner/repo',requestId:id,createdAt:time});
 for(const text of ['no extra model inference','never return placeholder','nonempty','100644/100755','outside the repository','git remote get-url origin'])assert.ok(prompt.includes(text),text);
 const schema=JSON.parse(prompt.split('Exact JSON Schema:\n')[1]);assert.deepEqual(schema,api.githubAnalysisSchema);
});

test('legacy identity matching safely canonicalizes HTTP and case-insensitive GitHub origins only',()=>{
 assert.equal(typeof api.canonicalGithubRepositoryUrl,'function');
 for(const input of ['http://github.com/Owner/Repo.git/','https://GITHUB.COM/OWNER/REPO','HTTP://GitHub.Com/owner/repo','https://github.com/owner/repo/'])assert.equal(api.canonicalGithubRepositoryUrl(input),'https://github.com/owner/repo');
 assert.equal(api.parseGithubRepository('https://github.com/owner/repo').url,'https://github.com/owner/repo');
 assert.throws(()=>api.parseGithubRepository('http://github.com/owner/repo'));
 for(const input of ['https://u@github.com/a/b','https://u:p@github.com/a/b','https://github.com:443/a/b','http://github.com:80/a/b','https://github.com/a/b?x','https://github.com/a/b#x','https://github.com/a/%62','https://github.com/a/../b','https://github.com/a/./b','https://github.com/a/b\\','https://github.com/a/\nb','https://github.com.evil/a/b','ftp://github.com/a/b','//github.com/a/b',null,42]){
  assert.equal(api.canonicalGithubRepositoryUrl(input),null,String(input));
 }
});

