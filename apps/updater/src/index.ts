import { timingSafeEqual } from "node:crypto";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { VERSION_RE } from "@hexa/shared";
import { applyUpdate, getStatus } from "./update.ts";

const TOKEN = process.env.UPDATER_TOKEN ?? "";
if (!TOKEN) {
  console.error("UPDATER_TOKEN is required");
  process.exit(1);
}

const authorized = (header: string | undefined) => {
  const given = Buffer.from((header ?? "").replace(/^Bearer /, ""));
  const want = Buffer.from(TOKEN);
  return given.length === want.length && timingSafeEqual(given, want);
};

const app = new Hono();

// Only reachable on the compose-internal network (no published port), and token-protected.
app.use("*", async (c, next) => {
  if (!authorized(c.req.header("authorization"))) return c.json({ error: "unauthorized" }, 401);
  await next();
});

app.get("/status", (c) => c.json(getStatus()));

app.post("/apply", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { version?: string };
  if (!body.version || !VERSION_RE.test(body.version)) return c.json({ error: "invalid version" }, 400);
  if (getStatus().state === "running") return c.json({ error: "an update is already running" }, 409);
  void applyUpdate(body.version);
  return c.json({ accepted: true }, 202);
});

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 4000) }, (i) => console.log(`[updater] listening on :${i.port}`));
