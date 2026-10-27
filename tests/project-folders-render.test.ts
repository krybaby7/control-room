import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {loadClient} from './helpers/render-client.ts';
const view=await loadClient<typeof import('../components/project-folders')>(new URL('../components/project-folders.tsx',import.meta.url));
test('project page lists its folders by name and offers an add action',()=>{
 const html=renderToStaticMarkup(createElement(view.ProjectFolderList,{keys:['app','lab'],repositories:[{key:'app',name:'The app'},{key:'lab',name:'Map lab'}],busy:false,onAdd:()=>{}}));
 for(const text of ['Folders on your PC','The app','Map lab','Add a folder from this PC','One briefing covers all these folders.'])assert.ok(html.includes(text));
});
test('full and archived project folder lists disable adding',()=>{
 for(const keys of [[],['a','b','c','d']]){const html=renderToStaticMarkup(createElement(view.ProjectFolderList,{keys,repositories:[],busy:true,onAdd:()=>{}}));assert.match(html,/disabled=""/);}
});

test('folder removals have names and four-folder limit has an accessible visible reason',()=>{
 const html=renderToStaticMarkup(createElement(view.ProjectFolderList,{keys:['a','b','c','d'],repositories:[{key:'a',name:'The app'}],busy:false,onAdd:()=>{},onRemove:()=>{}}));
 assert.ok(html.includes('Remove The app from project'));
 assert.ok(html.includes('A project can have up to four folders.'));
 assert.match(html,/<button[^>]*aria-describedby="[^"]+"[^>]*>Add a folder from this PC/);
 assert.ok(html.includes('Removing a folder keeps it registered on your PC'));
});
test('archived folders are readable with restore guidance and no folder actions',()=>{
 const html=renderToStaticMarkup(createElement(view.ProjectFolderList,{keys:['a'],repositories:[{key:'a',name:'The app'}],busy:false,archived:true,onAdd:()=>{},onRemove:()=>{}}));
 assert.ok(html.includes('The app'));assert.ok(html.includes('Restore this project'));
 assert.ok(!html.includes('>Add a folder from this PC</button>'));assert.ok(!html.includes('>Remove</button>'));
});
