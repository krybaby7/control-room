import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {build} from 'esbuild';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {createRequire} from 'node:module';
const directory=await mkdtemp(join(process.cwd(),'.project-framing-render-'));
let editor:typeof import('../components/project-editor');
try{await build({entryPoints:['components/project-editor.tsx'],outfile:join(directory,'editor.cjs'),bundle:true,platform:'node',format:'cjs',packages:'external',jsx:'automatic',logLevel:'silent'});editor=createRequire(import.meta.url)(join(directory,'editor.cjs'));}finally{await rm(directory,{recursive:true,force:true});}
test('project editor offers bounded empty framing and an unchecked optional task plan',()=>{
 const html=renderToStaticMarkup(createElement(editor.PortfolioProjectEditor,{onSave:async()=>{},onClose:()=>{}}));
 assert.ok(html.indexOf('What this project is and why')<html.indexOf('Project name'));
 assert.match(html,/aria-label="What this project is and why"/);assert.match(html,/maxLength="2500"/);
 assert.ok(html.includes('Briefings measure your intentions against this framing.'));
 assert.match(html,/type="checkbox"[^>]*aria-label="Include my task plan in briefings"/);
 assert.doesNotMatch(html,/checked=""/);
});
