import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { compareVersions, VERSION_RE, type UpdaterStatus } from "@hexa/shared";
import { config } from "./config.ts";
import * as license from "./license.ts";
import { loadedModules } from "./modules.ts";
import { pool } from "./db.ts";
import { loadAuth, requireReady, sameOriginWrites, type Env } from "./auth/session.ts";
import { authRoutes } from "./routes/auth.ts";
import { adminRoutes } from "./routes/admin.ts";
import { clientRoutes } from "./routes/clients.ts";
import { taskRoutes } from "./routes/tasks.ts";
import { teamRoutes } from "./routes/team.ts";
import { myToolsRoutes } from "./routes/mytools.ts";
import { commandRoutes } from "./routes/command.ts";
import { accountingRoutes } from "./routes/accounting.ts";
import { hrRoutes } from "./routes/hr.ts";
import { portalAdminRoutes, portalRoutes } from "./routes/portal.ts";
import { taskTimerRoutes } from "./routes/taskTimer.ts";
import { docsRoutes } from "./routes/docs.ts";
import { timeRoutes } from "./routes/time.ts";
import { expenseRoutes } from "./routes/expenses.ts";
import { timeAdminRoutes } from "./routes/timeAdmin.ts";
import { serviceRoutes } from "./routes/services.ts";
import { invoicingRoutes } from "./routes/invoicing.ts";
import { meetingRoutes } from "./routes/meeting.ts";
import { pipelineRoutes } from "./routes/pipeline.ts";
import { vendorPaymentRoutes } from "./routes/vendorPayments.ts";
import { mailingRoutes } from "./routes/mailing.ts";
import { microsoftRoutes } from "./routes/microsoft.ts";
import { quickbooksRoutes } from "./routes/quickbooks.ts";
import { classRoutes } from "./routes/classes.ts";
import { directoryRoutes } from "./routes/directory.ts";
import { integrationRoutes } from "./routes/integrations.ts";
import { ZodError } from "zod";

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

export function buildApp(): Hono<Env> {
  const app = new Hono<Env>();

  app.use("/api/*", sameOriginWrites);
  app.use("/api/*", loadAuth);

  // Public: Docker healthcheck, the updater, and the login screen (needs branding before sign-in).
  app.get("/api/health", async (c) => {
    const db = await pool.query("select 1").then(() => true, () => false);
    return c.json({ ok: db, version: config.version }, db ? 200 : 503);
  });
  app.get("/api/version", (c) => c.json({ version: config.version }));
  app.get("/api/config", (c) => {
    const lic = license.current();
    const a = c.get("auth");
    return c.json({
      version: config.version,
      branding: lic.branding,
      // Detail only for signed-in users; the login page needs branding and nothing else.
      ...(a?.stage === "ready" ? { plan: lic.plan, maxUsers: lic.maxUsers, flags: lic.flags, modules: loadedModules, license: license.status() } : {}),
    });
  });

  app.route("/api/auth", authRoutes);
  app.route("/api/admin/integrations", integrationRoutes);
  app.route("/api/admin/time", timeAdminRoutes);
  app.route("/api/admin/classes", classRoutes);
  app.route("/api/admin", adminRoutes);

  // Business modules. Each route file enforces its own permissions (see packages/shared/src/permissions.ts).
  app.route("/api/clients", portalAdminRoutes);
  app.route("/api/portal", portalRoutes);
  app.route("/api/clients", clientRoutes);
  app.route("/api/pipeline", pipelineRoutes);
  app.route("/api/microsoft", microsoftRoutes);
  app.route("/api/tasks", taskTimerRoutes);
  app.route("/api/tasks", taskRoutes);
  app.route("/api/team/meeting", meetingRoutes);
  app.route("/api/team", teamRoutes);
  app.route("/api/my", myToolsRoutes);
  app.route("/api/command", commandRoutes);
  app.route("/api/accounting/quickbooks", quickbooksRoutes);
  app.route("/api/accounting", mailingRoutes);
  app.route("/api/accounting", vendorPaymentRoutes);
  app.route("/api/accounting", invoicingRoutes);
  app.route("/api/accounting", accountingRoutes);
  app.route("/api/hr", hrRoutes);
  app.route("/api/docs", docsRoutes);
  app.route("/api/time", timeRoutes);
  app.route("/api/expenses", expenseRoutes);
  app.route("/api/services", serviceRoutes);
  app.route("/api/directory", directoryRoutes);

  app.onError((err, c) => {
    if (err instanceof ZodError) return c.json({ error: err.issues.map((i) => i.path.join(".") + ": " + i.message).join("; ") }, 400);
    console.error(err);
    return c.json({ error: "internal error" }, 500);
  });

  // Module routes require a signed-in user and a usable license.
  app.use("/api/modules/*", requireReady, async (c, next) => {
    const s = license.status();
    if (!s.usable) return c.json({ error: "license", reason: s.reason }, 402);
    await next();
  });

  // ---- Updates (pull model). Only the master administrator may install. ----
  app.get("/api/update/status", requireReady, async (c) => {
    if (c.get("auth")!.user.kind !== "staff") return c.json({ error: "forbidden" }, 403);
    const lic = license.current();
    const target = lic.pinnedVersion;
    const updateAvailable = Boolean(target) && VERSION_RE.test(target) && compareVersions(target, config.version) > 0;
    const run = await updater<UpdaterStatus>("/status");
    return c.json({ current: config.version, target, updateAvailable, updater: run, updaterConfigured: Boolean(config.updaterUrl) });
  });

  app.post("/api/update/apply", requireReady, async (c) => {
    if (!c.get("auth")!.user.isMaster) return c.json({ error: "forbidden" }, 403);
    const target = license.current().pinnedVersion;
    if (!VERSION_RE.test(target) || compareVersions(target, config.version) <= 0) return c.json({ error: "no update available" }, 409);
    const res = await updater<{ accepted?: boolean; error?: string }>("/apply", { method: "POST", body: JSON.stringify({ version: target }) });
    if (!res) return c.json({ error: "updater unreachable" }, 502);
    return c.json(res, res.accepted ? 202 : 409);
  });

  app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

  // ---- Single-page app: static assets, with index.html fallback for client-side routes ----
  const index = path.resolve(config.webDir, "index.html");
  app.use("/*", serveStatic({ root: config.webDir }));
  app.get("*", (c) => (fs.existsSync(index) ? c.html(fs.readFileSync(index, "utf8")) : c.text("Web app not built (run: npm run build -w @hexa/web)", 503)));
  return app;
}
