import test from 'node:test';
import assert from 'node:assert/strict';
import {claudeArgs,parseClaudeOutput,validateClaudeAuth,analyzeWithClaude} from '../companion/claude.mjs';
import {readConfiguredClaudeModel} from '../companion/claude.mjs';
import {mkdtemp,mkdir,writeFile,rm,link,symlink,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const content={summary:'Analysis',architecture:[],findings:[],suggestedTasks:[],limitations:[]};
const wire=(extra=[])=>[ {type:'system',subtype:'init',model:'actual-configured-model'},...extra,{type:'result',subtype:'success',is_error:false,structured_output:content}].map(JSON.stringify).join('\n');
test('Claude preserves subscription and default model while disabling ambient execution',()=>{const a=claudeArgs();for(const f of ['--safe-mode','--restricted','--no-session-persistence','--strict-mcp-config','--disable-slash-commands'])assert.ok(a.includes(f));assert.equal(a[a.indexOf('--tools')+1],'');assert.ok(!a.includes('--bare'));assert.ok(!a.includes('--model'));assert.ok(!a.includes('--resume'));assert.ok(a.includes('--json-schema'));});
test('auth accepts only existing first-party subscription',()=>{assert.equal(validateClaudeAuth({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty'}),true);for(const s of [{loggedIn:false},{loggedIn:true,authMethod:'api_key'},{loggedIn:true,authMethod:'oauth_token'}])assert.throws(()=>validateClaudeAuth(s));});
test('terminal output preserves observed model and validates report',()=>assert.deepEqual(parseClaudeOutput(wire()),{content,observedModel:'actual-configured-model'}));
test('external tools, malformed reports and unsuccessful terminals are rejected',()=>{for(const s of [wire([{type:'assistant',message:{content:[{type:'tool_use',name:'Bash'}]}}]),wire().replace('"summary":"Analysis"','"summary":4'),'{bad',JSON.stringify({type:'result',subtype:'error_max_turns',is_error:true})])assert.throws(()=>parseClaudeOutput(s));});
test('internal structured output is permitted',()=>assert.deepEqual(parseClaudeOutput(wire([{type:'assistant',message:{content:[{type:'tool_use',name:'StructuredOutput'}]}}])).content,content));
test('pre-cancel performs no discovery or model call',async()=>{const c=new AbortController();c.abort();await assert.rejects(analyzeWithClaude({}, {signal:c.signal}));});
test('only the existing personal model is forwarded into fixed Claude settings',async()=>{
 const home=await mkdtemp(join(tmpdir(),'claude-model-'));try{
  assert.equal(await readConfiguredClaudeModel({home}),undefined);await mkdir(join(home,'.claude'));
  await writeFile(join(home,'.claude','settings.json'),JSON.stringify({model:'opus',hooks:{SessionStart:[{command:'must-not-run'}]},env:{ANTHROPIC_BASE_URL:'https://example.invalid'},mcpServers:{untrusted:{command:'must-not-run'}}}));
  const model=await readConfiguredClaudeModel({home}),args=claudeArgs({model}),settings=JSON.parse(args[args.indexOf('--settings')+1]);
  assert.equal(settings.model,'opus');assert.equal(settings.hooks,undefined);assert.equal(settings.mcpServers,undefined);assert.equal(settings.env.ANTHROPIC_BASE_URL,undefined);assert.ok(!args.includes('--model'));
  await writeFile(join(home,'.claude','settings.json'),'{}');assert.equal(await readConfiguredClaudeModel({home}),undefined);
  assert.equal(Object.hasOwn(JSON.parse(claudeArgs()[claudeArgs().indexOf('--settings')+1]),'model'),false);
 }finally{await rm(home,{recursive:true,force:true});}
});
test('unsafe, oversized, malformed and multiply-linked model settings fail before analysis',async()=>{
 const home=await mkdtemp(join(tmpdir(),'claude-model-bounds-'));try{
  const directory=join(home,'.claude'),file=join(directory,'settings.json');await mkdir(directory);
  for(const raw of ['{bad',JSON.stringify({model:{name:'opus'}}),JSON.stringify({model:'../../custom'}),JSON.stringify({model:'https://example.invalid/model'}),JSON.stringify({model:'opus',padding:'x'.repeat(65536)})]){
   await writeFile(file,raw);await assert.rejects(readConfiguredClaudeModel({home}));
  }
  await writeFile(file,JSON.stringify({model:'claude-sonnet-4-6'}));assert.equal(await readConfiguredClaudeModel({home}),'claude-sonnet-4-6');
  await link(file,join(directory,'linked-settings.json'));await assert.rejects(readConfiguredClaudeModel({home}));
  await rm(directory,{recursive:true,force:true});const target=join(home,'settings-target');await mkdir(target);await writeFile(join(target,'settings.json'),JSON.stringify({model:'opus'}));await symlink(target,directory,process.platform==='win32'?'junction':'dir');await assert.rejects(readConfiguredClaudeModel({home}));
  assert.throws(()=>claudeArgs({model:'--fallback-model custom'}));
 }finally{await rm(home,{recursive:true,force:true});}
});

test('native and canonical home spellings read the same exact personal model without importing ambient settings',async()=>{
 const home=await mkdtemp(join(tmpdir(),'claude-model-canonical-'));try{
  await mkdir(join(home,'.claude'));await writeFile(join(home,'.claude','settings.json'),JSON.stringify({model:'claude-sonnet-4-6',hooks:{SessionStart:[{command:'must-not-run'}]}}));
  // Windows TEMP may contain an 8.3 ancestor alias expanded by realpath. Both
  // spellings refer to this actual synthetic directory, not a model fallback.
  const canonicalHome=await realpath(home);for(const selected of [home,canonicalHome]){const model=await readConfiguredClaudeModel({home:selected}),args=claudeArgs({model});assert.equal(model,'claude-sonnet-4-6');assert.equal(JSON.parse(args[args.indexOf('--settings')+1]).model,model);assert.ok(!args.join(' ').includes('must-not-run'));}
 }finally{await rm(home,{recursive:true,force:true});}
});
test('home and ancestor junctions or symlinks cannot redirect personal model settings',async()=>{
 const root=await mkdtemp(join(tmpdir(),'claude-model-home-links-'));try{
  const target=join(root,'actual'),profile=join(target,'profile'),alias=join(root,'alias');await mkdir(join(profile,'.claude'),{recursive:true});await writeFile(join(profile,'.claude','settings.json'),JSON.stringify({model:'opus'}));assert.equal(await readConfiguredClaudeModel({home:profile}),'opus');
  await symlink(target,alias,process.platform==='win32'?'junction':'dir');await assert.rejects(readConfiguredClaudeModel({home:join(alias,'profile')}));
  const homeLink=join(root,'profile-alias');await symlink(profile,homeLink,process.platform==='win32'?'junction':'dir');await assert.rejects(readConfiguredClaudeModel({home:homeLink}));assert.equal(await readConfiguredClaudeModel({home:profile}),'opus');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('malformed UTF-8 and multiply-linked settings remain rejected after home canonicalization',async()=>{
 const home=await mkdtemp(join(tmpdir(),'claude-model-file-links-'));try{
  await mkdir(join(home,'.claude'));const file=join(home,'.claude','settings.json');await writeFile(file,Buffer.from([0x7b,0x22,0x6d,0x6f,0x64,0x65,0x6c,0x22,0x3a,0x22,0xff,0x22,0x7d]));await assert.rejects(readConfiguredClaudeModel({home}));
  await rm(file);const target=join(home,'external-settings.json');await writeFile(target,JSON.stringify({model:'opus'}));await link(target,file);await assert.rejects(readConfiguredClaudeModel({home}));
 }finally{await rm(home,{recursive:true,force:true});}
});
