import { serve } from "@hono/node-server";
import { migrate } from "@nexo/shared/migrate";
import { config } from "./config.ts";
import { pool } from "./db.ts";
import * as license from "./license.ts";
import { loadModules } from "./modules.ts";
import { buildApp } from "./app.ts";

async function main() {
  console.log(`[nexo] instance v${config.version} starting`);
  const applied = await migrate(pool, config.migrationsDir, "core");
  if (applied.length) console.log(`[migrate] applied: ${applied.join(", ")}`);

  await license.loadCached();
  await license.check();
  license.startPeriodicCheck();

  const app = buildApp();
  await loadModules(app);

  serve({ fetch: app.fetch, port: config.port }, (i) => console.log(`[nexo] listening on :${i.port}`));

  const shutdown = () => {
    void pool.end().finally(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
