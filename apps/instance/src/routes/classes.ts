import { Hono } from "hono";
import { z } from "zod";
import { pool } from "../db.ts";
import { requirePermission, type Env } from "../auth/session.ts";
import { body, camelRows } from "./util.ts";

// Client classifications: an admin-managed list with a colour (Bronze, Silver, Gold by default).
export const classRoutes = new Hono<Env>();
classRoutes.use("*", requirePermission("admin.classes.manage"));

const Key = z.string().regex(/^[a-z][a-z0-9-]{1,30}$/);
const Color = z.string().regex(/^#[0-9a-fA-F]{6}$/);

classRoutes.get("/", async (c) => c.json(camelRows(await pool.query(
  "select k.*, (select count(*)::int from clients c where c.class_key = k.key) as clients from client_classes k order by position, key"))));

classRoutes.post("/", async (c) => {
  const d = await body(c, z.object({ key: Key, labelFr: z.string().min(1).max(60), labelEn: z.string().min(1).max(60), color: Color }));
  try { await pool.query("insert into client_classes (key, label_fr, label_en, color, position) values ($1,$2,$3,$4,(select coalesce(max(position),0)+10 from client_classes))", [d.key, d.labelFr, d.labelEn, d.color]); }
  catch (e) { if ((e as { code?: string }).code === "23505") return c.json({ error: "key_exists" }, 409); throw e; }
  return c.json({ ok: true }, 201);
});

classRoutes.patch("/:key", async (c) => {
  const d = await body(c, z.object({ labelFr: z.string().min(1).max(60).optional(), labelEn: z.string().min(1).max(60).optional(), color: Color.optional(), position: z.number().int().optional() }));
  const r = await pool.query("update client_classes set label_fr = coalesce($2,label_fr), label_en = coalesce($3,label_en), color = coalesce($4,color), position = coalesce($5,position) where key = $1", [c.req.param("key"), d.labelFr, d.labelEn, d.color, d.position]);
  return r.rowCount ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
});

/** Deleting a class clears it on the clients that had it (they just become unclassified). */
classRoutes.delete("/:key", async (c) => {
  await pool.query("delete from client_classes where key = $1", [c.req.param("key")]);
  return c.json({ ok: true });
});
