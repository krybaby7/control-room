import ts from 'typescript';
import {existsSync,readFileSync} from 'node:fs';
import {resolve,extname} from 'node:path';
import {registerHooks} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';

/** Load the actual client leaf with JSX compiled in process, retaining its real dependencies. */
export async function loadClient<T>(url:URL):Promise<T>{
 const hooks=registerHooks({
  resolve(specifier,context,next){const candidate=specifier.startsWith('@/')?pathToFileURL(resolve(process.cwd(),specifier.slice(2))).href:specifier.startsWith('.')?new URL(specifier,context.parentURL).href:null;if(candidate?.startsWith('file:')&&!extname(fileURLToPath(candidate))){for(const extension of ['.ts','.tsx','.mts'])if(existsSync(fileURLToPath(candidate)+extension))return {url:candidate+extension,shortCircuit:true};}return next(specifier,context);},
  load(url,context,next){if(/\.(?:tsx|ts|mts)$/.test(url)&&!url.includes('/node_modules/'))return {format:'module',source:ts.transpileModule(readFileSync(fileURLToPath(url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,shortCircuit:true};return next(url,context);},
 });
 try{return await import(url.href) as T;}finally{hooks.deregister();}
}
