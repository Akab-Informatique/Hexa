import { Hono } from "hono";
import { z } from "zod";
import { addDays, mondayOf, todayISO } from "@nexo/shared/billing";
import { pool } from "../db.ts";
import { requirePermission, type Env } from "../auth/session.ts";
import { auth, body, buildUpdate, camel, camelRows, can, isUuid } from "./util.ts";

export const myToolsRoutes = new Hono<Env>();

// =============================== Timesheet ===============================
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const EntryInput = z.object({
  workDate: Day, minutes: z.number().int().min(1).max(1440), clientId: z.string().uuid().nullable().optional(),
  taskId: z.string().uuid().nullable().optional(), description: z.string().max(1000).optional(), billable: z.boolean().optional(),
});

myToolsRoutes.get("/timesheet", requirePermission("mytools.timesheet.use"), async (c) => {
  const week = mondayOf(c.req.query("week") && Day.safeParse(c.req.query("week")).success ? c.req.query("week")! : todayISO());
  const r = await pool.query(
    `select e.*, cl.name as client_name, t.title as task_title from timesheet_entries e
       left join clients cl on cl.id = e.client_id left join tasks t on t.id = e.task_id
      where e.user_id = $1 and e.work_date between $2 and $3 order by e.work_date, e.created_at`,
    [auth(c).user.id, week, addDays(week, 6)],
  );
  const entries = camelRows<{ minutes: number; status: string }>(r);
  return c.json({
    week, entries,
    totalMinutes: entries.reduce((a, e) => a + e.minutes, 0),
    editable: entries.every((e) => e.status === "draft" || e.status === "rejected"),
    hasDraft: entries.some((e) => e.status === "draft" || e.status === "rejected"),
  });
});

myToolsRoutes.post("/timesheet", requirePermission("mytools.timesheet.use"), async (c) => {
  const d = await body(c, EntryInput);
  const r = await pool.query(
    "insert into timesheet_entries (user_id, work_date, minutes, client_id, task_id, description, billable) values ($1, $2, $3, $4, $5, coalesce($6,''), coalesce($7, true)) returning id",
    [auth(c).user.id, d.workDate, d.minutes, d.clientId ?? null, d.taskId ?? null, d.description, d.billable],
  );
  return c.json({ id: r.rows[0].id }, 201);
});

myToolsRoutes.patch("/timesheet/:id", requirePermission("mytools.timesheet.use"), async (c) => {
  const d = await body(c, EntryInput.partial());
  const { sets, values } = buildUpdate(d, { workDate: "work_date", minutes: "minutes", clientId: "client_id", taskId: "task_id", description: "description", billable: "billable" }, 3);
  if (!sets.length) return c.json({ error: "nothing to update" }, 400);
  // Only my own entries, and only while still a draft (or sent back by the approver).
  const r = await pool.query(`update timesheet_entries set ${sets.join(", ")}, status = 'draft' where id = $1 and user_id = $2 and status in ('draft','rejected') returning id`, [c.req.param("id"), auth(c).user.id, ...values]);
  return r.rowCount ? c.json({ ok: true }) : c.json({ error: "entry not found or already submitted" }, 409);
});

myToolsRoutes.delete("/timesheet/:id", requirePermission("mytools.timesheet.use"), async (c) => {
  await pool.query("delete from timesheet_entries where id = $1 and user_id = $2 and status in ('draft','rejected')", [c.req.param("id"), auth(c).user.id]);
  return c.json({ ok: true });
});

myToolsRoutes.post("/timesheet/submit", requirePermission("mytools.timesheet.use"), async (c) => {
  const { week } = await body(c, z.object({ week: Day }));
  const start = mondayOf(week);
  const r = await pool.query(
    "update timesheet_entries set status = 'submitted' where user_id = $1 and work_date between $2 and $3 and status in ('draft','rejected') returning id",
    [auth(c).user.id, start, addDays(start, 6)],
  );
  return c.json({ submitted: r.rowCount });
});

myToolsRoutes.get("/timesheet/pending", requirePermission("mytools.timesheet.approve"), async (c) => {
  const r = await pool.query(
    `select e.*, u.name as user_name, cl.name as client_name from timesheet_entries e join users u on u.id = e.user_id left join clients cl on cl.id = e.client_id
      where e.status = 'submitted' order by u.name, e.work_date`);
  return c.json(camelRows(r));
});

/** Approving billable time hands it to accounting as "work to bill" (once: unique per entry). */
myToolsRoutes.post("/timesheet/:id/decision", requirePermission("mytools.timesheet.approve"), async (c) => {
  const { decision, reason } = await body(c, z.object({ decision: z.enum(["approve", "reject"]), reason: z.string().max(300).optional() }));
  const e = (await pool.query("select * from timesheet_entries where id = $1 and status = 'submitted'", [c.req.param("id")])).rows[0];
  if (!e) return c.json({ error: "not found" }, 404);
  // Nobody approves their own time (reference rule).
  if (e.user_id === auth(c).user.id) return c.json({ error: "you cannot approve your own time" }, 403);
  await pool.query("update timesheet_entries set status = $2, approved_by = $3, approved_at = now() where id = $1", [e.id, decision === "approve" ? "approved" : "rejected", auth(c).user.id]);
  if (decision === "approve" && e.billable && e.client_id) {
    const rate = (await pool.query("select hourly_rate from client_contracts where client_id = $1 and kind = 'hourly' and status = 'active' and hourly_rate is not null order by created_at desc limit 1", [e.client_id])).rows[0]?.hourly_rate ?? 0;
    await pool.query(
      `insert into billing_items (client_id, source, source_id, description, quantity, unit_price, work_date, created_by)
       values ($1, 'time', $2, $3, $4, $5, $6, $7) on conflict do nothing`,
      [e.client_id, e.id, e.description || "Temps de travail", Math.round((e.minutes / 60) * 100) / 100, rate, e.work_date, e.user_id],
    );
  }
  void reason;
  return c.json({ ok: true });
});

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
