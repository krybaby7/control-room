import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import type { SqlDatabase, SqlStatement } from '../../lib/workspace-store.ts';
export function database() {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of readdirSync(new URL('../../drizzle/', import.meta.url)).filter(n => n.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(`../../drizzle/${name}`, import.meta.url), 'utf8'));
  const runs = new WeakMap<SqlStatement, () => { meta: { changes: number }; results?:unknown[] }>();
  const db: SqlDatabase = {
    prepare(sql) { let values: (string | number | null)[] = []; const run = () => {
      const prepared=sqlite.prepare(sql);
      // Native result metadata handles SELECT, WITH SELECT and DML RETURNING;
      // textual prefixes cannot distinguish those statements safely.
      if(!prepared.columns().length)return {meta:{changes:Number(prepared.run(...values).changes)}};
      const before=sqlite.prepare('SELECT total_changes() AS total').get()!.total;
      const results=prepared.all(...values),after=sqlite.prepare('SELECT total_changes() AS total').get()!.total;
      const changes=before===after?0:Number(sqlite.prepare('SELECT changes() AS count').get()!.count);
      return {meta:{changes},results};
    }; const statement: SqlStatement = {
      bind(...args) { values = args; return this; },
      async first<T>() { return (sqlite.prepare(sql).get(...values) ?? null) as T | null; },
      async all<T>() { return {results:sqlite.prepare(sql).all(...values) as T[]}; },
      async run() { return run(); },
    }; runs.set(statement, run); return statement; },
    async batch(statements) { sqlite.exec('BEGIN IMMEDIATE'); try { const results = statements.map(s => runs.get(s)!()); sqlite.exec('COMMIT'); return results; } catch (e) { sqlite.exec('ROLLBACK'); throw e; } },
  };
  return { db, sqlite };
}
