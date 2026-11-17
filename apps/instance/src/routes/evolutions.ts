import { Hono } from "hono";
import { z } from "zod";
import { pool } from "../db.ts";
import { requirePermission, type Env } from "../auth/session.ts";
import { audit } from "../auth/access.ts";
import { auth, body, camelRows, isUuid } from "./util.ts";

/** The firm's backlog of portal changes. view = read; edit = create, change, delete, move status, comment. */
export const evolutionRoutes = new Hono<Env>();
const VIEW = ["evolutions.view", "evolutions.edit"];
const EDIT = ["evolutions.edit"];

const MAX_B64 = 4_000_000; // about 3 MB per image
const MAX_IMAGES = 6;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
const Image = z.object({ name: z.string().min(1).max(200), type: z.enum(IMAGE_TYPES), data: z.string().min(1).max(MAX_B64).regex(/^[A-Za-z0-9+/]+={0,2}$/) });
/** Declared type must match the real bytes (no script or SVG dressed up as an image). */
export function sniffImage(b64: string): (typeof IMAGE_TYPES)[number] | null {
  const b = Buffer.from(b64.slice(0, 32), "base64");
  if (b.subarray(0, 4).toString("hex") === "89504e47") return "image/png";
  if (b.subarray(0, 3).toString("hex") === "ffd8ff") return "image/jpeg";
  if (b.subarray(0, 3).toString("latin1") === "GIF") return "image/gif";
  if (b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}
const goodImage = (i: z.infer<typeof Image>) => sniffImage(i.data) === i.type;

const Input = z.object({
  title: z.string().trim().min(1).max(300),
  details: z.string().max(10000).default(""),
  priority: z.number().int().min(1).max(10).default(5),
  sopId: z.string().uuid().nullable().optional(),
});

const SELECT = `select e.id, e.title, e.details, e.priority, e.status, e.sop_id, e.created_at, e.updated_at, u.name as created_by_name, p.title as sop_title,
    (select count(*)::int from evolution_comments c where c.evolution_id = e.id) as comment_count,
    coalesce((select json_agg(json_build_object('id', i.id, 'name', i.name) order by i.created_at) from evolution_images i where i.evolution_id = e.id), '[]'::json) as images
  from portal_evolutions e left join users u on u.id = e.created_by left join procedures p on p.id = e.sop_id`;

evolutionRoutes.get("/", requirePermission(...VIEW), async (c) => {
  const r = await pool.query(`${SELECT} order by e.priority desc, e.created_at, e.id limit 1000`);
  return c.json(camelRows(r));
});

/** Procedures that can be linked (published ones). */
evolutionRoutes.get("/sops", requirePermission(...VIEW), async (c) => {
  const r = await pool.query("select id, title from procedures where status = 'published' order by lower(title) limit 500");
  return c.json(camelRows(r));
});

async function sopOk(sopId: string | null | undefined) {
  return !sopId || Boolean((await pool.query("select 1 from procedures where id = $1", [sopId])).rowCount);
}

evolutionRoutes.post("/", requirePermission(...EDIT), async (c) => {
  const d = await body(c, Input.extend({ images: z.array(Image).max(MAX_IMAGES).default([]) }));
  if (!(await sopOk(d.sopId))) return c.json({ error: "invalid_sop" }, 400);
  if (!d.images.every(goodImage)) return c.json({ error: "invalid_image" }, 400);
  const uid = auth(c).user.id;
  const id = (await pool.query("insert into portal_evolutions (title, details, priority, sop_id, created_by) values ($1,$2,$3,$4,$5) returning id", [d.title, d.details, d.priority, d.sopId ?? null, uid])).rows[0].id;
  for (const i of d.images) await pool.query("insert into evolution_images (evolution_id, name, content_type, size, data_b64, created_by) values ($1,$2,$3,$4,$5,$6)", [id, i.name, i.type, Math.floor((i.data.length * 3) / 4), i.data, uid]);
  await audit("evolution.created", { userId: uid, target: id, detail: { title: d.title, priority: d.priority } });
  return c.json({ id }, 201);
});

evolutionRoutes.put("/:id", requirePermission(...EDIT), async (c) => {
  const id = c.req.param("id");
  if (!isUuid(id)) return c.json({ error: "not found" }, 404);
  const d = await body(c, Input);
  if (!(await sopOk(d.sopId))) return c.json({ error: "invalid_sop" }, 400);
  const r = await pool.query("update portal_evolutions set title = $2, details = $3, priority = $4, sop_id = $5, updated_at = now() where id = $1", [id, d.title, d.details, d.priority, d.sopId ?? null]);
  if (!r.rowCount) return c.json({ error: "not found" }, 404);
  await audit("evolution.updated", { userId: auth(c).user.id, target: id, detail: { title: d.title, priority: d.priority } });
  return c.json({ ok: true });
});

evolutionRoutes.put("/:id/status", requirePermission(...EDIT), async (c) => {
  const id = c.req.param("id");
  if (!isUuid(id)) return c.json({ error: "not found" }, 404);
  const { status } = await body(c, z.object({ status: z.enum(["todo", "review", "done"]) }));
  const r = await pool.query("update portal_evolutions set status = $2, updated_at = now() where id = $1", [id, status]);
  if (!r.rowCount) return c.json({ error: "not found" }, 404);
  await audit("evolution.status", { userId: auth(c).user.id, target: id, detail: { status } });
  return c.json({ ok: true });
});

evolutionRoutes.delete("/:id", requirePermission(...EDIT), async (c) => {
  const id = c.req.param("id");
  if (!isUuid(id)) return c.json({ ok: true });
  const r = await pool.query("delete from portal_evolutions where id = $1 returning title", [id]);
  if (r.rowCount) await audit("evolution.deleted", { userId: auth(c).user.id, target: id, detail: { title: r.rows[0].title } });
  return c.json({ ok: true });
});

// ---- Comments ----
evolutionRoutes.get("/:id/comments", requirePermission(...VIEW), async (c) => {
  const id = c.req.param("id");
  if (!isUuid(id)) return c.json([]);
  const r = await pool.query("select c.id, c.body, c.created_at, c.user_id, u.name as user_name from evolution_comments c left join users u on u.id = c.user_id where c.evolution_id = $1 order by c.created_at", [id]);
  return c.json(camelRows(r));
});
evolutionRoutes.post("/:id/comments", requirePermission(...EDIT), async (c) => {
  const id = c.req.param("id");
  if (!isUuid(id)) return c.json({ error: "not found" }, 404);
  const d = await body(c, z.object({ body: z.string().trim().min(1).max(5000) }));
  if (!(await pool.query("select 1 from portal_evolutions where id = $1", [id])).rowCount) return c.json({ error: "not found" }, 404);
  await pool.query("insert into evolution_comments (evolution_id, user_id, body) values ($1,$2,$3)", [id, auth(c).user.id, d.body]);
  await audit("evolution.commented", { userId: auth(c).user.id, target: id });
  return c.json({ ok: true }, 201);
});
evolutionRoutes.delete("/comments/:cid", requirePermission(...EDIT), async (c) => {
  const cid = c.req.param("cid");
  if (!isUuid(cid)) return c.json({ ok: true });
  await pool.query("delete from evolution_comments where id = $1 and user_id = $2", [cid, auth(c).user.id]); // own comments only
  return c.json({ ok: true });
});

// ---- Images ----
evolutionRoutes.post("/:id/images", requirePermission(...EDIT), async (c) => {
  const id = c.req.param("id");
  if (!isUuid(id)) return c.json({ error: "not found" }, 404);
  const i = await body(c, Image);
  if (!goodImage(i)) return c.json({ error: "invalid_image" }, 400);
  if (!(await pool.query("select 1 from portal_evolutions where id = $1", [id])).rowCount) return c.json({ error: "not found" }, 404);
  const n = Number((await pool.query("select count(*) as n from evolution_images where evolution_id = $1", [id])).rows[0].n);
  if (n >= MAX_IMAGES) return c.json({ error: "too_many_files" }, 409);
  await pool.query("insert into evolution_images (evolution_id, name, content_type, size, data_b64, created_by) values ($1,$2,$3,$4,$5,$6)", [id, i.name, i.type, Math.floor((i.data.length * 3) / 4), i.data, auth(c).user.id]);
  return c.json({ ok: true }, 201);
});
evolutionRoutes.get("/images/:iid", requirePermission(...VIEW), async (c) => {
  const iid = c.req.param("iid");
  if (!isUuid(iid)) return c.json({ error: "not found" }, 404);
  const f = (await pool.query("select content_type, data_b64 from evolution_images where id = $1", [iid])).rows[0];
  if (!f) return c.json({ error: "not found" }, 404);
  return new Response(Buffer.from(f.data_b64, "base64"), { headers: { "content-type": f.content_type, "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox", "cache-control": "private, max-age=3600" } });
});
evolutionRoutes.delete("/images/:iid", requirePermission(...EDIT), async (c) => {
  const iid = c.req.param("iid");
  if (isUuid(iid)) await pool.query("delete from evolution_images where id = $1", [iid]);
  return c.json({ ok: true });
});
