import { Hono } from "hono";
import { z } from "zod";
import { addDays, mondayOf, todayISO } from "@hexa/shared/billing";
import { pool } from "../db.ts";
import { requirePermission, type Env } from "../auth/session.ts";
import { auth, body, buildUpdate, camel, camelRows, can, isUuid } from "./util.ts";

export const myToolsRoutes = new Hono<Env>();

// Timesheets moved to routes/time.ts (typed entries, weekly approval, hours bank).

// =============================== Knowledge base ===============================
const KbInput = z.object({ title: z.string().min(1).max(200), category: z.string().max(80).optional(), body: z.string().max(100000).optional(), published: z.boolean().optional() });

myToolsRoutes.get("/kb", requirePermission("mytools.kb.view", "mytools.kb.edit"), async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  const editor = can(c, "mytools.kb.edit");
  const r = await pool.query(
    `select k.id, k.title, k.category, k.published, k.updated_at, u.name as author_name, left(k.body, 160) as excerpt from kb_articles k left join users u on u.id = k.author_id
      where ($1 or k.published) and ($2 = '' or k.title ilike '%'||$2||'%' or k.body ilike '%'||$2||'%') order by k.category, lower(k.title)`, [editor, q]);
  return c.json(camelRows(r));
});

myToolsRoutes.get("/kb/:id", requirePermission("mytools.kb.view", "mytools.kb.edit"), async (c) => {
  if (!isUuid(c.req.param("id"))) return c.json({ error: "not found" }, 404);
  const r = await pool.query("select k.*, u.name as author_name from kb_articles k left join users u on u.id = k.author_id where k.id = $1", [c.req.param("id")]);
  const row = r.rows[0];
  if (!row || (!row.published && !can(c, "mytools.kb.edit"))) return c.json({ error: "not found" }, 404);
  return c.json(camel(row));
});

myToolsRoutes.post("/kb", requirePermission("mytools.kb.edit"), async (c) => {
  const d = await body(c, KbInput);
  const r = await pool.query("insert into kb_articles (title, category, body, published, author_id) values ($1, coalesce($2,'Général'), coalesce($3,''), coalesce($4,true), $5) returning id", [d.title, d.category, d.body, d.published, auth(c).user.id]);
  return c.json({ id: r.rows[0].id }, 201);
});

myToolsRoutes.patch("/kb/:id", requirePermission("mytools.kb.edit"), async (c) => {
  const d = await body(c, KbInput.partial());
  const { sets, values } = buildUpdate(d, { title: "title", category: "category", body: "body", published: "published" }, 2);
  if (!sets.length) return c.json({ error: "nothing to update" }, 400);
  const r = await pool.query(`update kb_articles set ${sets.join(", ")}, updated_at = now() where id = $1 returning id`, [c.req.param("id"), ...values]);
  return r.rowCount ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
});

myToolsRoutes.delete("/kb/:id", requirePermission("mytools.kb.edit"), async (c) => {
  await pool.query("delete from kb_articles where id = $1", [c.req.param("id")]);
  return c.json({ ok: true });
});

// =============================== Procedures ===============================
// Reference model: a procedure is a draft until published; rights are view / edit / manage.
const ProcInput = z.object({
  title: z.string().min(1).max(200), description: z.string().max(2000).optional(), category: z.string().max(80).optional(),
  status: z.enum(["draft", "published"]).optional(),
  steps: z.array(z.object({ title: z.string().min(1).max(200), body: z.string().max(10000).optional() })).max(200).optional(),
});
const PROC_ANY = ["mytools.procedures.view", "mytools.procedures.edit", "mytools.procedures.manage"];

myToolsRoutes.get("/procedures", requirePermission(...PROC_ANY), async (c) => {
  const editor = can(c, "mytools.procedures.edit", "mytools.procedures.manage");
  const r = await pool.query(
    `select p.*, u.name as author_name, (select count(*)::int from procedure_steps s where s.procedure_id = p.id) as step_count
       from procedures p left join users u on u.id = p.author_id where $1 or p.status = 'published' order by p.category, lower(p.title)`, [editor]);
  return c.json(camelRows(r));
});

myToolsRoutes.get("/procedures/:id", requirePermission(...PROC_ANY), async (c) => {
  if (!isUuid(c.req.param("id"))) return c.json({ error: "not found" }, 404);
  const p = (await pool.query("select p.*, u.name as author_name from procedures p left join users u on u.id = p.author_id where p.id = $1", [c.req.param("id")])).rows[0];
  if (!p || (p.status !== "published" && !can(c, "mytools.procedures.edit", "mytools.procedures.manage"))) return c.json({ error: "not found" }, 404);
  const steps = await pool.query("select id, position, title, body from procedure_steps where procedure_id = $1 order by position", [p.id]);
  return c.json({ ...camel(p), steps: camelRows(steps) });
});

async function saveProcedure(id: string | null, d: z.infer<typeof ProcInput>, userId: string): Promise<string> {
  if (id) {
    await pool.query(
      "update procedures set title = $2, description = coalesce($3, description), category = coalesce($4, category), status = coalesce($5, status), updated_at = now() where id = $1",
      [id, d.title, d.description ?? null, d.category ?? null, d.status ?? null]);
  } else {
    id = (await pool.query("insert into procedures (title, description, category, status, author_id) values ($1, coalesce($2,''), coalesce($3,'Général'), coalesce($4,'draft'), $5) returning id", [d.title, d.description, d.category, d.status, userId])).rows[0].id;
  }
  if (d.steps) {
    await pool.query("delete from procedure_steps where procedure_id = $1", [id]);
    for (const [i, s] of d.steps.entries()) await pool.query("insert into procedure_steps (procedure_id, position, title, body) values ($1, $2, $3, coalesce($4,''))", [id, i, s.title, s.body]);
  }
  return id!;
}

myToolsRoutes.post("/procedures", requirePermission("mytools.procedures.edit", "mytools.procedures.manage"), async (c) =>
  c.json({ id: await saveProcedure(null, await body(c, ProcInput), auth(c).user.id) }, 201));

myToolsRoutes.put("/procedures/:id", requirePermission("mytools.procedures.edit", "mytools.procedures.manage"), async (c) => {
  const p = (await pool.query("select author_id from procedures where id = $1", [c.req.param("id")])).rows[0];
  if (!p) return c.json({ error: "not found" }, 404);
  // edit = my own procedures; manage = anyone's.
  if (p.author_id !== auth(c).user.id && !can(c, "mytools.procedures.manage")) return c.json({ error: "forbidden" }, 403);
  await saveProcedure(c.req.param("id"), await body(c, ProcInput), auth(c).user.id);
  return c.json({ ok: true });
});

myToolsRoutes.delete("/procedures/:id", requirePermission("mytools.procedures.edit", "mytools.procedures.manage"), async (c) => {
  const p = (await pool.query("select author_id from procedures where id = $1", [c.req.param("id")])).rows[0];
  if (!p) return c.json({ ok: true });
  if (p.author_id !== auth(c).user.id && !can(c, "mytools.procedures.manage")) return c.json({ error: "forbidden" }, 403);
  await pool.query("delete from procedures where id = $1", [c.req.param("id")]);
  return c.json({ ok: true });
});
