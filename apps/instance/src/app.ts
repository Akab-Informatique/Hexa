import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { compareVersions, VERSION_RE, type UpdaterStatus } from "@nexo/shared";
import { config } from "./config.ts";
import * as license from "./license.ts";
import { loadedModules } from "./modules.ts";
import { pool } from "./db.ts";

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

async function updater<T>(path: string, init?: RequestInit): Promise<T | null> {
  if (!config.updaterUrl) return null;
  try {
    const res = await fetch(`${config.updaterUrl}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${config.updaterToken}`, "content-type": "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export function buildApp(): Hono {
  const app = new Hono();

  // Public: needed by Docker healthcheck, the updater, and the login/branding screen.
  app.get("/api/health", async (c) => {
    const db = await pool.query("select 1").then(() => true, () => false);
    return c.json({ ok: db, version: config.version }, db ? 200 : 503);
  });
  app.get("/api/version", (c) => c.json({ version: config.version }));
  app.get("/api/config", (c) => {
    const lic = license.current();
    return c.json({
      version: config.version,
      branding: lic.branding,
      plan: lic.plan,
      maxUsers: lic.maxUsers,
      flags: lic.flags,
      modules: loadedModules,
      license: license.status(),
    });
  });

  // Everything else (modules, future app routes) requires a usable license.
  app.use("/api/modules/*", async (c, next) => {
    const s = license.status();
    if (!s.usable) return c.json({ error: "license", reason: s.reason }, 402);
    await next();
  });

  // ---- Updates (pull model) ----
  app.get("/api/update/status", async (c) => {
    const lic = license.current();
    const target = lic.pinnedVersion;
    const updateAvailable = Boolean(target) && VERSION_RE.test(target) && compareVersions(target, config.version) > 0;
    const run = await updater<UpdaterStatus>("/status");
    return c.json({ current: config.version, target, updateAvailable, updater: run, updaterConfigured: Boolean(config.updaterUrl) });
  });

  app.post("/api/update/apply", async (c) => {
    // TODO(app): replace the shared admin token with the app's real "administrator" permission.
    const token = c.req.header("x-admin-token") ?? "";
    if (!config.adminToken || !safeEqual(token, config.adminToken)) return c.json({ error: "forbidden" }, 403);
    const target = license.current().pinnedVersion;
    if (!VERSION_RE.test(target) || compareVersions(target, config.version) <= 0) {
      return c.json({ error: "no update available" }, 409);
    }
    const res = await updater<{ accepted?: boolean; error?: string }>("/apply", {
      method: "POST",
      body: JSON.stringify({ version: target }),
    });
    if (!res) return c.json({ error: "updater unreachable" }, 502);
    return c.json(res, res.accepted ? 202 : 409);
  });

  app.use("/*", serveStatic({ root: config.publicDir }));
  return app;
}
