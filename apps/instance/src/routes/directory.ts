import { Hono } from "hono";
import { pool } from "../db.ts";
import { requireReady, type Env } from "../auth/session.ts";
import { integrationStatus } from "./integrations.ts";

/** Small lookup lists for pickers (assignee, client...). Names only; nothing sensitive. */
export const directoryRoutes = new Hono<Env>();
directoryRoutes.use("*", requireReady);

directoryRoutes.get("/users", async (c) => {
  if (c.get("auth")!.user.kind !== "staff") return c.json({ error: "forbidden" }, 403);
  const r = await pool.query("select id, name from users where kind = 'staff' and active order by lower(name)");
  return c.json(r.rows);
});

directoryRoutes.get("/groups", async (c) => {
  if (c.get("auth")!.user.kind !== "staff") return c.json({ error: "forbidden" }, 403);
  const r = await pool.query("select id, name from groups where audience = 'staff' order by lower(name)");
  return c.json(r.rows);
});

directoryRoutes.get("/clients", async (c) => {
  if (c.get("auth")!.user.kind !== "staff") return c.json({ error: "forbidden" }, 403);
  const r = await pool.query("select id, name, status from clients where status <> 'inactive' order by lower(name)");
  return c.json(r.rows);
});

directoryRoutes.get("/integrations", async (c) => c.json(await integrationStatus()));
