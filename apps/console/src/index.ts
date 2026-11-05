import { serve } from "@hono/node-server";
import pg from "pg";
import { migrate } from "@hexa/shared/migrate";
import { config } from "./config.ts";
import { buildApp } from "./app.ts";

async function main() {
  config.adminPassword(); // fail fast on missing required secrets
  if (config.secret().length < 32) throw new Error("CONSOLE_SECRET must be at least 32 characters");
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
  const applied = await migrate(pool, config.migrationsDir, "console");
  if (applied.length) console.log(`[migrate] applied: ${applied.join(", ")}`);
  serve({ fetch: buildApp(pool).fetch, port: config.port }, (i) => console.log(`[console] listening on :${i.port}`));
  const shutdown = () => void pool.end().finally(() => process.exit(0));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
