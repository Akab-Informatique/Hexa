import pg from "pg";
import { config } from "./config.ts";

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
