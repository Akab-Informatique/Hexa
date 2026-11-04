import fs from "node:fs";
import type pg from "pg";

/**
 * Ordered, idempotent SQL migrations. Every *.sql file in `dir` is applied once, in
 * filename order, each in its own transaction. Safe when a client jumps several versions
 * (all missing files are applied in order) and when several containers start at once
 * (advisory lock). `scope` keeps core and per-module histories separate.
 */
export async function migrate(pool: pg.Pool, dir: string, scope = "core"): Promise<string[]> {
  const applied: string[] = [];
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock(727274)");
    await client.query(
      `create table if not exists schema_migrations (
         scope text not null, name text not null, applied_at timestamptz not null default now(),
         primary key (scope, name))`,
    );
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      const done = await client.query("select 1 from schema_migrations where scope=$1 and name=$2", [scope, file]);
      if (done.rowCount) continue;
      const sql = fs.readFileSync(`${dir}/${file}`, "utf8");
      try {
        await client.query("begin");
        await client.query(sql);
        await client.query("insert into schema_migrations (scope, name) values ($1, $2)", [scope, file]);
        await client.query("commit");
        applied.push(file);
      } catch (err) {
        await client.query("rollback");
        throw new Error(`Migration ${scope}/${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query("select pg_advisory_unlock(727274)").catch(() => {});
    client.release();
  }
  return applied;
}
