import pg from "pg";
import { config } from "./config.ts";

// DATE stays a plain "YYYY-MM-DD" string (no timezone shifting); NUMERIC and BIGINT become numbers.
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(1700, (v) => Number.parseFloat(v));
pg.types.setTypeParser(20, (v) => Number.parseInt(v, 10));

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

export async function getSetting<T>(key: string): Promise<T | undefined> {
  const r = await pool.query("select value from settings where key=$1", [key]);
  return r.rows[0]?.value as T | undefined;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await pool.query(
    `insert into settings (key, value) values ($1, $2::jsonb)
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}
