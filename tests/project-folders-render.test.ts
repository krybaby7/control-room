import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {build} from 'esbuild';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {createRequire} from 'node:module';
const directory=await mkdtemp(join(process.cwd(),'.project-folders-render-'));
let view:typeof import('../components/project-folders');
try{await build({entryPoints:['components/project-folders.tsx'],outfile:join(directory,'view.cjs'),bundle:true,platform:'node',format:'cjs',packages:'external',jsx:'automatic',logLevel:'silent'});view=createRequire(import.meta.url)(join(directory,'view.cjs'));}finally{await rm(directory,{recursive:true,force:true});}
test('project page lists its folders by name and offers an add action',()=>{
 const html=renderToStaticMarkup(createElement(view.ProjectFolderList,{keys:['app','lab'],repositories:[{key:'app',name:'The app'},{key:'lab',name:'Map lab'}],busy:false,onAdd:()=>{}}));
 for(const text of ['Folders on this PC','The app','Map lab','Add folder','One briefing covers all these folders.'])assert.ok(html.includes(text));
});
test('full and archived project folder lists disable adding',()=>{
 for(const keys of [[],['a','b','c','d']]){const html=renderToStaticMarkup(createElement(view.ProjectFolderList,{keys,repositories:[],busy:true,onAdd:()=>{}}));assert.match(html,/disabled=""/);}
});
