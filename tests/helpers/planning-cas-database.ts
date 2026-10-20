import {DatabaseSync} from 'node:sqlite';
import {readdirSync,readFileSync} from 'node:fs';
import type {SqlDatabase,SqlStatement} from '../../lib/workspace-store.ts';
/** Synthetic file-backed SQLite only, allowing a genuinely independent isolate
 * to contend through the public compiler against the same physical database. */
export function openPlanningCasDatabase(path:string,migrate=false){
 const sqlite=new DatabaseSync(path);sqlite.exec('PRAGMA foreign_keys=ON');
 if(migrate)for(const name of readdirSync(new URL('../../drizzle/',import.meta.url)).filter(name=>name.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL('../../drizzle/'+name,import.meta.url),'utf8'));
 const runs=new WeakMap<SqlStatement,()=>{meta:{changes:number};results?:Record<string,unknown>[]}>();
 const db:SqlDatabase={
  prepare(sql){let values:(string|number|null)[]=[];const run=()=>{
    const prepared=sqlite.prepare(sql);
    // Native result metadata handles SELECT and WITH...SELECT without ever
    // confusing a WITH...INSERT mutation with a read. RETURNING also preserves
    // real top-level changes instead of inventing a zero mutation result.
    if(prepared.columns().length){
     const before=Number(sqlite.prepare('SELECT total_changes() n').get()!.n),results=prepared.all(...values),after=Number(sqlite.prepare('SELECT total_changes() n').get()!.n);
     const changes=after===before?0:Number(sqlite.prepare('SELECT changes() n').get()!.n);
     return {meta:{changes},results};
    }
    return {meta:{changes:Number(prepared.run(...values).changes)}};
   };
   const statement:SqlStatement={bind(...bindings){values=bindings;return this;},async first<T>(){return (sqlite.prepare(sql).get(...values)??null) as T|null;},async all<T>(){return {results:sqlite.prepare(sql).all(...values) as T[]};},async run(){return run();}};runs.set(statement,run);return statement;
  },
  async batch(statements){sqlite.exec('BEGIN IMMEDIATE');try{const results=statements.map(statement=>{const run=runs.get(statement);if(!run)throw new Error('Foreign synthetic statement');return run();});sqlite.exec('COMMIT');return results;}catch(error){sqlite.exec('ROLLBACK');throw error;}},
 };
 return {db,sqlite};
}
