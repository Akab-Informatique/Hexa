import { Hono } from "hono";
import { z } from "zod";
import { pool } from "../db.ts";
import { audit } from "../auth/access.ts";
import { requirePermission, type Env } from "../auth/session.ts";
import { auth, body, camelRows } from "./util.ts";

// Administration of the time and expense types. The kind of a time type fixes its rules (work day, bank payout,
// vacation, sick, holiday, travel, client work, other) and cannot change; labels, order and on/off can.
export const timeAdminRoutes = new Hono<Env>();
timeAdminRoutes.use("*", requirePermission("admin.time.manage"));

const Key = z.string().regex(/^[a-z][a-z0-9-]{1,30}$/);
const LOCKED_KINDS = new Set(["workday", "bankpay", "vacation", "sick", "holiday", "travel", "work"]);

timeAdminRoutes.get("/time-types", async (c) => c.json(camelRows(await pool.query("select * from time_types order by position, key"))));

timeAdminRoutes.post("/time-types", async (c) => {
  const d = await body(c, z.object({ key: Key, labelFr: z.string().min(1).max(80), labelEn: z.string().min(1).max(80) }));
  // New types are plain "other" time: they sit inside the work day and add no pay of their own.
  try {
    await pool.query("insert into time_types (key, kind, label_fr, label_en, position) values ($1,'other',$2,$3,(select coalesce(max(position),0)+10 from time_types))", [d.key, d.labelFr, d.labelEn]);
  } catch (e) { if ((e as { code?: string }).code === "23505") return c.json({ error: "key_exists" }, 409); throw e; }
  await audit("timetype.created", { userId: auth(c).user.id, target: d.key });
  return c.json({ ok: true }, 201);
});

timeAdminRoutes.patch("/time-types/:key", async (c) => {
  const d = await body(c, z.object({ labelFr: z.string().min(1).max(80).optional(), labelEn: z.string().min(1).max(80).optional(), active: z.boolean().optional(), position: z.number().int().optional() }));
  const cur = (await pool.query("select kind, built_in from time_types where key = $1", [c.req.param("key")])).rows[0];
  if (!cur) return c.json({ error: "not found" }, 404);
  if (d.active === false && LOCKED_KINDS.has(cur.kind)) return c.json({ error: "type_required" }, 409);
  await pool.query("update time_types set label_fr = coalesce($2,label_fr), label_en = coalesce($3,label_en), active = coalesce($4,active), position = coalesce($5,position) where key = $1", [c.req.param("key"), d.labelFr, d.labelEn, d.active, d.position]);
  return c.json({ ok: true });
});

timeAdminRoutes.delete("/time-types/:key", async (c) => {
  const cur = (await pool.query("select built_in, kind from time_types where key = $1", [c.req.param("key")])).rows[0];
  if (!cur) return c.json({ ok: true });
  if (cur.built_in || LOCKED_KINDS.has(cur.kind)) return c.json({ error: "type_required" }, 409);
  if ((await pool.query("select 1 from timesheet_entries where type_key = $1 limit 1", [c.req.param("key")])).rowCount) return c.json({ error: "type_in_use" }, 409);
  await pool.query("delete from time_types where key = $1", [c.req.param("key")]);
  return c.json({ ok: true });
});

const ExpType = z.object({ labelFr: z.string().min(1).max(80), labelEn: z.string().min(1).max(80), unit: z.enum(["none", "km"]), rate: z.number().min(0).max(100).optional(), billable: z.boolean().optional(), active: z.boolean().optional() });

timeAdminRoutes.get("/expense-types", async (c) => c.json(camelRows(await pool.query("select * from expense_types order by position, key"))));

timeAdminRoutes.post("/expense-types", async (c) => {
  const d = await body(c, ExpType.extend({ key: Key }));
  try {
    await pool.query("insert into expense_types (key, label_fr, label_en, unit, rate_cents, billable, position) values ($1,$2,$3,$4,$5,$6,(select coalesce(max(position),0)+10 from expense_types))", [d.key, d.labelFr, d.labelEn, d.unit, Math.round((d.rate ?? 0) * 100), Boolean(d.billable)]);
  } catch (e) { if ((e as { code?: string }).code === "23505") return c.json({ error: "key_exists" }, 409); throw e; }
  return c.json({ ok: true }, 201);
});

timeAdminRoutes.patch("/expense-types/:key", async (c) => {
  const d = await body(c, ExpType.partial());
  const cur = (await pool.query("select unit from expense_types where key = $1", [c.req.param("key")])).rows[0];
  if (!cur) return c.json({ error: "not found" }, 404);
  // Changing the unit of a type that already has items would turn kilometres into dollars.
  if (d.unit && d.unit !== cur.unit && (await pool.query("select 1 from expense_items where type_key = $1 limit 1", [c.req.param("key")])).rowCount) return c.json({ error: "type_in_use" }, 409);
  await pool.query(
    "update expense_types set label_fr = coalesce($2,label_fr), label_en = coalesce($3,label_en), unit = coalesce($4,unit), rate_cents = coalesce($5,rate_cents), billable = coalesce($6,billable), active = coalesce($7,active) where key = $1",
    [c.req.param("key"), d.labelFr, d.labelEn, d.unit, d.rate != null ? Math.round(d.rate * 100) : null, d.billable, d.active]);
  return c.json({ ok: true });
});

timeAdminRoutes.delete("/expense-types/:key", async (c) => {
  if ((await pool.query("select 1 from expense_items where type_key = $1 limit 1", [c.req.param("key")])).rowCount) return c.json({ error: "type_in_use" }, 409);
  await pool.query("delete from expense_types where key = $1", [c.req.param("key")]);
  return c.json({ ok: true });
});
