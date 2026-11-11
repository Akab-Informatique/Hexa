import { serve } from "@hono/node-server";
import { migrate } from "@hexa/shared/migrate";
import { config } from "./config.ts";
import { pool } from "./db.ts";
import * as license from "./license.ts";
import { loadModules } from "./modules.ts";
import { buildApp } from "./app.ts";
import { bootstrap } from "./bootstrap.ts";
import { reminderTick } from "./routes/mailing.ts";
import { autoTaskTick } from "./lib/autoTasks.ts";
import { refreshContractBilling } from "./lib/contractBilling.ts";
import { quickbooksTick } from "./routes/quickbooks.ts";

async function main() {
  console.log(`[hexa] instance v${config.version} starting`);
  const applied = await migrate(pool, config.migrationsDir, "core");
  if (applied.length) console.log(`[migrate] applied: ${applied.join(", ")}`);

  if (config.isProd && config.appSecret.length < 32) throw new Error("APP_SECRET (32+ chars) is required in production");
  await bootstrap();
  await license.loadCached();
  await license.check();
  license.startPeriodicCheck();

  const app = buildApp();
  await loadModules(app);

  serve({ fetch: app.fetch, port: config.port }, (i) => console.log(`[hexa] listening on :${i.port}`));

  // Automatic invoice reminders (off until switched on) are checked every few minutes.
  setInterval(() => void reminderTick().catch((err) => console.error("[reminders]", err)), 5 * 60_000).unref();

  // Tasks the tax follow-up creates by itself (taxes, DAS, payroll, year-end, T4/RL-1): checked at start and every hour.
  void autoTaskTick().catch((err) => console.error("[auto-tasks]", err));
  setInterval(() => void autoTaskTick().catch((err) => console.error("[auto-tasks]", err)), 60 * 60_000).unref();

  // Contract and fixed-fee charges that have come due become to-bill lines (pending approval), once each: checked hourly.
  setInterval(() => void refreshContractBilling().catch((err) => console.error("[contract-billing]", err)), 60 * 60_000).unref();

  setInterval(() => void quickbooksTick().catch((err) => console.error("[quickbooks]", err)), 15 * 60_000).unref();

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
