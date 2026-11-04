import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Hono } from "hono";
import type { NexoModule } from "@nexo/shared";
import { migrate } from "@nexo/shared/migrate";
import { pool } from "./db.ts";
import { config } from "./config.ts";
import * as license from "./license.ts";

export const loadedModules: string[] = [];

/**
 * Loads only the modules the console enabled for this client. A module is a folder in
 * `modules/<name>/` with an index.ts that default-exports a NexoModule. Client-specific
 * work lives here, never in the core.
 */
export async function loadModules(app: Hono): Promise<void> {
  const wanted = license.current().modules;
  const flags = license.current().flags;
  for (const name of wanted) {
    if (!/^[a-z0-9-]+$/.test(name)) continue;
    const dir = path.resolve(config.modulesDir, name);
    const entry = ["index.ts", "index.js"].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
    if (!entry) {
      console.warn(`[modules] "${name}" enabled for this client but not installed in this image`);
      continue;
    }
    const mod = ((await import(pathToFileURL(entry).href)) as { default: NexoModule }).default;
    if (mod.migrationsDir) await migrate(pool, path.resolve(dir, mod.migrationsDir), `module:${name}`);
    const sub = new Hono();
    await mod.register({ app: sub, db: pool, flags, log: (m) => console.log(`[module:${name}] ${m}`) });
    app.route(`/api/modules/${name}`, sub);
    loadedModules.push(name);
    console.log(`[modules] loaded ${name}`);
  }
}
