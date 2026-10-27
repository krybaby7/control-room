import test from 'node:test';
import assert from 'node:assert/strict';
import {rememberedProjectAssistant,restoreProjectAssistant} from '../lib/project-assistant-preference.ts';

test('assistant preference uses project policy, otherwise the latest project briefing job',()=>{
 const jobs=[{kind:'brief',projectId:'p',provider:'codex' as const,createdAt:'2026-10-26T10:00:00Z'},{kind:'brief',projectId:'p',provider:'claude' as const,createdAt:'2026-10-27T10:00:00Z'},{kind:'analyze',projectId:'p',provider:'codex' as const,createdAt:'2026-10-27T11:00:00Z'},{kind:'brief',projectId:'other',provider:'codex' as const,createdAt:'2026-10-27T12:00:00Z'}];
 assert.equal(rememberedProjectAssistant('p',{jobs}),'claude');
 assert.equal(rememberedProjectAssistant('p',{jobs,policies:[{projectId:'p',provider:'codex'}]}),'codex');
 assert.equal(rememberedProjectAssistant('missing',{jobs}),null);
});
test('latest saved project briefing restores the choice when policy and jobs have no memory',async()=>{
 const applied:string[]=[],signal=new AbortController().signal;let reads=0;
 await restoreProjectAssistant({projectId:'p',connector:{jobs:[]},signal,hasOwnerChoice:()=>false,apply:value=>applied.push(value),readSaved:async()=>{reads++;return [{projectId:'p',recordedAt:'2026-10-26T10:00:00Z',briefing:{run:{provider:'codex'}}},{projectId:'other',recordedAt:'2026-10-27T12:00:00Z',briefing:{run:{provider:'codex'}}},{projectId:'p',recordedAt:'2026-10-27T10:00:00Z',briefing:{run:{provider:'claude'}}}];}});
 assert.equal(reads,1);assert.deepEqual(applied,['claude']);
});
test('existing memory skips the saved read, and no memory preserves the normal default',async()=>{
 const signal=new AbortController().signal,applied:string[]=[];
 await restoreProjectAssistant({projectId:'p',connector:{policies:[{projectId:'p',provider:'claude'}]},signal,hasOwnerChoice:()=>false,apply:value=>applied.push(value),readSaved:async()=>assert.fail('policy must avoid another read')});
 assert.deepEqual(applied,['claude']);
 await restoreProjectAssistant({projectId:'p',connector:{},signal,hasOwnerChoice:()=>false,apply:()=>assert.fail('default must remain unchanged'),readSaved:async()=>[]});
});
test('an explicit assistant choice during a delayed saved read cannot be overwritten',async()=>{
 let ownerChose=false,release!:()=>void;const delayed=new Promise<void>(resolve=>{release=resolve;});
 const work=restoreProjectAssistant({projectId:'p',connector:{},signal:new AbortController().signal,hasOwnerChoice:()=>ownerChose,apply:()=>assert.fail('late memory must preserve owner selection'),readSaved:async()=>{await delayed;return [{projectId:'p',recordedAt:'2026-10-27T10:00:00Z',briefing:{run:{provider:'codex'}}}];}});
 ownerChose=true;release();await work;
});
test('an aborted preference read never applies a choice to an unmounted project',async()=>{
 const controller=new AbortController();
 await restoreProjectAssistant({projectId:'p',connector:{},signal:controller.signal,hasOwnerChoice:()=>false,apply:()=>assert.fail('aborted project must not change'),readSaved:async()=>{controller.abort();return [{projectId:'p',recordedAt:'2026-10-27T10:00:00Z',briefing:{run:{provider:'claude'}}}];}});
});
