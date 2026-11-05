import { Hono } from "hono";
import { z } from "zod";
import { addDays, fridayOf, mondayOf, quebecHolidays, todayISO } from "@hexa/shared/billing";
import { pool } from "../db.ts";
import { audit } from "../auth/access.ts";
import { requirePermission, type Env } from "../auth/session.ts";
import { auth, body, camelRows, can, isUuid } from "./util.ts";

// The weekly meeting, modelled on the reference: a running list of points (notes, snooze, archive, drag order),
// "La semaine" (a Monday-Sunday planner with events, absences and holidays), the week-ahead brief (rules), three
// gauges that link to filtered lists, engagements in progress, and trends over the last weeks.
export const meetingRoutes = new Hono<Env>();
meetingRoutes.use("*", requirePermission("team.meeting.view"));

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const edit = (c: Parameters<typeof can>[0]) => can(c, "team.meeting.edit", "team.meeting.manage");
const manage = (c: Parameters<typeof can>[0]) => can(c, "team.meeting.manage");
const needEdit = requirePermission("team.meeting.edit", "team.meeting.manage");
const needManage = requirePermission("team.meeting.manage");
/** Tasks a person may see (same visibility rule as the task list). */
const VIS = "(t.visibility = 'team' or t.created_by = $1 or t.assignee_id = $1)";

// ------------------------------------------------------------------ Points
const openSql = "p.archived_at is null and (p.snooze_until is null or p.snooze_until <= $1::date)";

/** Kept for the dashboard widget: the points on the table now. */
meetingRoutes.get("/", async (c) => {
  const r = await pool.query(`select p.*, u.name as author_name from meeting_points p left join users u on u.id = p.author_id where ${openSql} order by p.position, p.created_at`, [todayISO()]);
  return c.json({ points: camelRows(r) });
});

meetingRoutes.get("/points", async (c) => {
  const view = c.req.query("view") === "later" ? "later" : c.req.query("view") === "archive" ? "archive" : "open";
  const q = (c.req.query("q") ?? "").trim();
  const where = view === "open" ? openSql : view === "later" ? "p.archived_at is null and p.snooze_until > $1::date" : "p.archived_at is not null and $1::date is not null and ($2 = '' or p.title ilike '%' || $2 || '%' or p.body ilike '%' || $2 || '%')";
  const r = await pool.query(
    `select p.*, u.name as author_name, (select count(*)::int from meeting_point_notes n where n.point_id = p.id) as note_count
       from meeting_points p left join users u on u.id = p.author_id where ${where}
      order by ${view === "archive" ? "p.archived_at desc" : "p.position, p.created_at"} limit 300`, view === "archive" ? [todayISO(), q] : [todayISO()]);
  const counts = await pool.query("select count(*) filter (where snooze_until > $1::date and archived_at is null)::int as later from meeting_points", [todayISO()]);
  return c.json({ points: camelRows(r), later: counts.rows[0].later });
});

meetingRoutes.post("/points", needEdit, async (c) => {
  const d = await body(c, z.object({ kind: z.enum(["point", "hot", "issue"]).default("point"), title: z.string().min(1).max(300), body: z.string().max(5000).optional() }));
  // A new point goes last.
  const r = await pool.query(
    "insert into meeting_points (week_start, kind, title, body, author_id, position) values ($1, $2, $3, coalesce($4,''), $5, (select coalesce(max(position), 0) + 1 from meeting_points)) returning id",
    [mondayOf(todayISO()), d.kind, d.title, d.body, auth(c).user.id]);
  return c.json({ id: r.rows[0].id }, 201);
});

meetingRoutes.put("/points/order", needManage, async (c) => {
  const d = await body(c, z.object({ ids: z.array(z.string().uuid()).max(500) }));
  for (const [i, id] of d.ids.entries()) await pool.query("update meeting_points set position = $2 where id = $1", [id, i]);
  return c.json({ ok: true });
});

meetingRoutes.patch("/points/:id", needEdit, async (c) => {
  const row = (await pool.query("select author_id from meeting_points where id::text = $1", [c.req.param("id")])).rows[0];
  if (!row) return c.json({ error: "not found" }, 404);
  const d = await body(c, z.object({ done: z.boolean().optional(), archived: z.boolean().optional(), title: z.string().min(1).max(300).optional(), body: z.string().max(5000).optional(), snoozeUntil: Day.nullable().optional() }));
  // Anyone in the meeting settles, puts off or restores a point; only the author or a manager rewrites it.
  if ((d.title !== undefined || d.body !== undefined) && row.author_id !== auth(c).user.id && !manage(c)) return c.json({ error: "forbidden" }, 403);
  if (d.snoozeUntil && d.snoozeUntil <= todayISO()) return c.json({ error: "snooze_in_the_past" }, 400);
  // Ticking a point settles it AND sends it to the archive; unticking or restoring puts it back on the list.
  const settle = d.done === true, reopen = d.done === false || d.archived === false;
  await pool.query(
    `update meeting_points set title = coalesce($2, title), body = coalesce($3, body),
        done = case when $4 then true when $5 then false else done end,
        done_at = case when $4 then now() when $5 then null else done_at end,
        archived_at = case when $4 or $6 then now() when $5 then null else archived_at end,
        snooze_until = case when $7 then $8::date when $5 then null else snooze_until end where id::text = $1`,
    [c.req.param("id"), d.title ?? null, d.body ?? null, settle, reopen, d.archived === true, d.snoozeUntil !== undefined, d.snoozeUntil ?? null]);
  return c.json({ ok: true });
});

meetingRoutes.delete("/points/:id", needEdit, async (c) => {
  const row = (await pool.query("select author_id from meeting_points where id::text = $1", [c.req.param("id")])).rows[0];
  if (!row) return c.json({ ok: true });
  if (row.author_id !== auth(c).user.id && !manage(c)) return c.json({ error: "forbidden" }, 403);
  await pool.query("delete from meeting_points where id::text = $1", [c.req.param("id")]);
  return c.json({ ok: true });
});

meetingRoutes.get("/points/:id/notes", async (c) => {
  if (!isUuid(c.req.param("id"))) return c.json([]);
  const r = await pool.query("select n.id, n.body, n.created_at, u.name as user_name from meeting_point_notes n left join users u on u.id = n.user_id where n.point_id = $1 order by n.created_at", [c.req.param("id")]);
  return c.json(camelRows(r));
});
meetingRoutes.post("/points/:id/notes", needEdit, async (c) => {
  const d = await body(c, z.object({ body: z.string().min(1).max(5000) }));
  if (!(await pool.query("select 1 from meeting_points where id::text = $1", [c.req.param("id")])).rowCount) return c.json({ error: "not found" }, 404);
  await pool.query("insert into meeting_point_notes (point_id, user_id, body) values ($1,$2,$3)", [c.req.param("id"), auth(c).user.id, d.body]);
  return c.json({ ok: true }, 201);
});

// ------------------------------------------------------------------ La semaine
meetingRoutes.get("/week", async (c) => {
  const q = c.req.query("from");
  const from = mondayOf(q && Day.safeParse(q).success ? q : todayISO());
  const to = addDays(from, 6);
  const me = auth(c).user.id;
  const [events, absences, tasks, projects] = await Promise.all([
    pool.query("select e.*, u.name as user_name from meeting_events e left join users u on u.id = e.user_id where e.event_date between $1 and $2 order by e.event_date, e.start_time nulls first", [from, to]),
    pool.query("select a.*, u.name as user_name from absences a join users u on u.id = a.user_id where a.starts_on <= $2 and a.ends_on >= $1 order by a.starts_on", [from, to]),
    pool.query(`select t.id, t.title, t.due_date, t.priority, a.name as assignee_name, cl.name as client_name from tasks t left join users a on a.id = t.assignee_id left join clients cl on cl.id = t.client_id
                 where ${VIS} and t.status <> 'done' and t.due_date between $2 and $3 order by t.due_date, t.priority`, [me, from, to]),
    pool.query("select id, name, due_date from meeting_projects where status = 'open' and due_date between $1 and $2 order by due_date", [from, to]),
  ]);
  const years = new Set([Number(from.slice(0, 4)), Number(to.slice(0, 4))]);
  const holidays = [...years].flatMap((y) => quebecHolidays(y)).filter((h) => h.date >= from && h.date <= to);
  const days = Array.from({ length: 7 }, (_, i) => {
    const date = addDays(from, i);
    const norm = (rows: Record<string, unknown>[]) => camelRows({ rows });
    return {
      date,
      holiday: holidays.find((h) => h.date === date) ?? null,
      events: norm(events.rows.filter((e) => String(e.event_date).slice(0, 10) === date)),
      absences: norm(absences.rows.filter((a) => String(a.starts_on).slice(0, 10) <= date && String(a.ends_on).slice(0, 10) >= date)),
      tasks: norm(tasks.rows.filter((t) => String(t.due_date).slice(0, 10) === date)),
      projects: norm(projects.rows.filter((p) => String(p.due_date).slice(0, 10) === date)),
    };
  });
  return c.json({ from, to, days, today: todayISO() });
});

const EventInput = z.object({ date: Day, start: z.string().regex(/^\d{1,2}:\d{2}$/).nullable().optional(), end: z.string().regex(/^\d{1,2}:\d{2}$/).nullable().optional(), title: z.string().min(1).max(200), note: z.string().max(2000).optional(), userId: z.string().uuid().nullable().optional() });

meetingRoutes.post("/events", needManage, async (c) => {
  const d = await body(c, EventInput);
  if (d.start && d.end && d.end <= d.start) return c.json({ error: "event_times" }, 400);
  const r = await pool.query("insert into meeting_events (event_date, start_time, end_time, title, note, user_id, created_by) values ($1,$2,$3,$4,coalesce($5,''),$6,$7) returning id", [d.date, d.start ?? null, d.end ?? null, d.title, d.note, d.userId ?? null, auth(c).user.id]);
  return c.json({ id: r.rows[0].id }, 201);
});
meetingRoutes.put("/events/:id", needManage, async (c) => {
  const d = await body(c, EventInput);
  if (d.start && d.end && d.end <= d.start) return c.json({ error: "event_times" }, 400);
  const r = await pool.query("update meeting_events set event_date = $2, start_time = $3, end_time = $4, title = $5, note = coalesce($6,''), user_id = $7 where id::text = $1", [c.req.param("id"), d.date, d.start ?? null, d.end ?? null, d.title, d.note, d.userId ?? null]);
  return r.rowCount ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
});
meetingRoutes.delete("/events/:id", needManage, async (c) => {
  await pool.query("delete from meeting_events where id::text = $1", [c.req.param("id")]);
  return c.json({ ok: true });
});

// Absences are added and removed from the week planner (the same rows HR and timesheets read).
meetingRoutes.post("/absences", needManage, async (c) => {
  const d = await body(c, z.object({ userId: z.string().uuid(), kind: z.enum(["vacation", "sick", "training", "personal", "other"]), startsOn: Day, endsOn: Day, note: z.string().max(500).optional() }));
  if (d.endsOn < d.startsOn) return c.json({ error: "the end date is before the start date" }, 400);
  const r = await pool.query("insert into absences (user_id, kind, starts_on, ends_on, note, created_by) values ($1,$2,$3,$4,coalesce($5,''),$6) returning id", [d.userId, d.kind, d.startsOn, d.endsOn, d.note, auth(c).user.id]);
  return c.json({ id: r.rows[0].id }, 201);
});
meetingRoutes.delete("/absences/:id", needManage, async (c) => {
  await pool.query("delete from absences where id::text = $1", [c.req.param("id")]);
  return c.json({ ok: true });
});

// ------------------------------------------------------------------ Engagements in progress
meetingRoutes.get("/projects", async (c) => {
  const done = c.req.query("done") === "1";
  const r = await pool.query(
    `select p.*, cl.name as client_name,
            (select coalesce(json_agg(json_build_object('userId', m.user_id, 'name', u.name) order by u.name), '[]') from meeting_project_members m join users u on u.id = m.user_id where m.project_id = p.id) as members,
            (select count(*)::int from meeting_project_notes n where n.project_id = p.id) as note_count
       from meeting_projects p left join clients cl on cl.id = p.client_id where p.status = $1 order by p.due_date nulls last, lower(p.name)`, [done ? "done" : "open"]);
  return c.json(camelRows(r));
});

const ProjectInput = z.object({ name: z.string().min(1).max(200), clientId: z.string().uuid().nullable().optional(), dueDate: Day.nullable().optional(), status: z.enum(["open", "done"]).optional(), memberIds: z.array(z.string().uuid()).max(50).optional() });

meetingRoutes.post("/projects", needEdit, async (c) => {
  const d = await body(c, ProjectInput);
  const r = await pool.query("insert into meeting_projects (name, client_id, due_date, created_by) values ($1,$2,$3,$4) returning id", [d.name, d.clientId ?? null, d.dueDate ?? null, auth(c).user.id]);
  for (const u of d.memberIds ?? []) await pool.query("insert into meeting_project_members values ($1,$2) on conflict do nothing", [r.rows[0].id, u]);
  return c.json({ id: r.rows[0].id }, 201);
});
meetingRoutes.patch("/projects/:id", needEdit, async (c) => {
  const d = await body(c, ProjectInput.partial());
  const id = c.req.param("id");
  const r = await pool.query(
    "update meeting_projects set name = coalesce($2,name), client_id = case when $3 then $4 else client_id end, due_date = case when $5 then $6::date else due_date end, status = coalesce($7,status) where id::text = $1",
    [id, d.name ?? null, d.clientId !== undefined, d.clientId ?? null, d.dueDate !== undefined, d.dueDate ?? null, d.status ?? null]);
  if (!r.rowCount) return c.json({ error: "not found" }, 404);
  if (d.memberIds) {
    await pool.query("delete from meeting_project_members where project_id::text = $1", [id]);
    for (const u of d.memberIds) await pool.query("insert into meeting_project_members select id, $2 from meeting_projects where id::text = $1 on conflict do nothing", [id, u]);
  }
  return c.json({ ok: true });
});
meetingRoutes.delete("/projects/:id", needManage, async (c) => {
  await pool.query("delete from meeting_projects where id::text = $1", [c.req.param("id")]);
  await audit("meeting.project_deleted", { userId: auth(c).user.id, target: c.req.param("id") });
  return c.json({ ok: true });
});
meetingRoutes.get("/projects/:id/notes", async (c) => {
  if (!isUuid(c.req.param("id"))) return c.json([]);
  const r = await pool.query("select n.id, n.body, n.created_at, u.name as user_name from meeting_project_notes n left join users u on u.id = n.user_id where n.project_id = $1 order by n.created_at desc", [c.req.param("id")]);
  return c.json(camelRows(r));
});
meetingRoutes.post("/projects/:id/notes", needEdit, async (c) => {
  const d = await body(c, z.object({ body: z.string().min(1).max(5000) }));
  await pool.query("insert into meeting_project_notes (project_id, user_id, body) select id, $2, $3 from meeting_projects where id::text = $1", [c.req.param("id"), auth(c).user.id, d.body]);
  return c.json({ ok: true }, 201);
});

// ------------------------------------------------------------------ Gauges, brief, trends
/** Colours turn from green to red at `warn`, and critical at `critical`. */
const THRESHOLDS = { overdue: { warn: 10, critical: 20 }, week: { warn: 15, critical: 25 }, unassigned: { warn: 5, critical: 10 } };

meetingRoutes.get("/gauges", async (c) => {
  const me = auth(c).user.id;
  const today = todayISO(), friday = fridayOf(today);
  const by = async (where: string, params: unknown[]) => {
    const r = await pool.query(`select t.assignee_id as id, coalesce(a.name, '') as name, count(*)::int as count from tasks t left join users a on a.id = t.assignee_id where ${VIS} and t.status <> 'done' and ${where} group by t.assignee_id, a.name order by count desc`, [me, ...params]);
    return { count: r.rows.reduce((s, x) => s + x.count, 0), byAssignee: r.rows.map((x) => ({ id: x.id, name: x.name, count: x.count })) };
  };
  return c.json({
    today, friday, thresholds: THRESHOLDS,
    overdue: await by("t.due_date < $2", [today]),
    week: await by("t.due_date between $2 and $3", [today, friday]),
    unassigned: await by("t.assignee_id is null", []),
  });
});

meetingRoutes.get("/brief", async (c) => {
  const me = auth(c).user.id;
  const today = todayISO();
  // The week looked at is this Monday-Friday, or the next one over a weekend.
  const dow = (new Date(`${today}T12:00:00`).getDay() + 6) % 7;
  const from = dow >= 5 ? addDays(mondayOf(today), 7) : mondayOf(today);
  const to = addDays(from, 4);
  const [abs, late, due, unassigned, load, projects, staff] = await Promise.all([
    pool.query("select u.name, a.kind, a.starts_on, a.ends_on from absences a join users u on u.id = a.user_id where a.starts_on <= $2 and a.ends_on >= $1", [from, to]),
    pool.query(`select count(*)::int as n from tasks t where ${VIS} and t.status <> 'done' and t.due_date < $2`, [me, today]),
    pool.query(`select count(*)::int as n from tasks t where ${VIS} and t.status <> 'done' and t.due_date between $2 and $3`, [me, from, to]),
    pool.query(`select count(*)::int as n from tasks t where ${VIS} and t.status <> 'done' and t.assignee_id is null`, [me]),
    pool.query(`select a.name, count(*)::int as n from tasks t join users a on a.id = t.assignee_id where ${VIS} and t.status <> 'done' and (t.due_date <= $2 or t.due_date is null) group by a.name order by n desc`, [me, to]),
    pool.query("select name, due_date from meeting_projects where status = 'open' and due_date <= $1 order by due_date", [to]),
    pool.query("select u.name from users u where u.kind = 'staff' and u.active and not exists (select 1 from tasks t where t.assignee_id = u.id and t.status <> 'done' and (t.due_date <= $1 or t.due_date is null)) order by u.name", [to]),
  ]);
  const years = new Set([Number(from.slice(0, 4)), Number(to.slice(0, 4))]);
  const hol = [...years].flatMap((y) => quebecHolidays(y)).filter((h) => h.date >= from && h.date <= to);
  type B = { tone: "ok" | "warn" | "danger" | "info"; fr: string; en: string };
  const bullets: B[] = [];
  const nLate = late.rows[0].n, nDue = due.rows[0].n, nUn = unassigned.rows[0].n;
  bullets.push({ tone: "info", fr: `${nDue} tâche(s) à échéance du ${from} au ${to}.`, en: `${nDue} task(s) due from ${from} to ${to}.` });
  if (nLate) bullets.push({ tone: nLate >= THRESHOLDS.overdue.warn ? "danger" : "warn", fr: `${nLate} tâche(s) déjà en retard.`, en: `${nLate} task(s) already late.` });
  if (nUn) bullets.push({ tone: nUn >= THRESHOLDS.unassigned.warn ? "danger" : "warn", fr: `${nUn} tâche(s) sans responsable.`, en: `${nUn} task(s) without an owner.` });
  for (const h of hol) bullets.push({ tone: "info", fr: `Congé : ${h.fr} (${h.date}).`, en: `Holiday: ${h.en} (${h.date}).` });
  for (const a of abs.rows) bullets.push({ tone: "info", fr: `${a.name} est absent(e) (${String(a.starts_on).slice(0, 10)} → ${String(a.ends_on).slice(0, 10)}).`, en: `${a.name} is away (${String(a.starts_on).slice(0, 10)} → ${String(a.ends_on).slice(0, 10)}).` });
  for (const p of projects.rows) bullets.push({ tone: String(p.due_date).slice(0, 10) < today ? "danger" : "warn", fr: `Dossier « ${p.name} » à livrer le ${String(p.due_date).slice(0, 10)}.`, en: `Engagement "${p.name}" due ${String(p.due_date).slice(0, 10)}.` });
  if (!nLate && !nUn && !abs.rows.length && !hol.length) bullets.push({ tone: "ok", fr: "Rien de particulier à signaler.", en: "Nothing in particular to flag." });
  const suggestions: { fr: string; en: string }[] = [];
  const over = load.rows.filter((x) => x.n >= 8);
  if (over.length) suggestions.push({ fr: `Alléger ${over.map((x) => x.name).join(", ")} (beaucoup de tâches pour la semaine).`, en: `Lighten ${over.map((x) => x.name).join(", ")} (many tasks for the week).` });
  if (nUn && staff.rows.length) suggestions.push({ fr: `Assigner les tâches sans responsable, par exemple à ${staff.rows.slice(0, 3).map((x) => x.name).join(", ")} (peu chargé(e)s).`, en: `Assign the unowned tasks, for example to ${staff.rows.slice(0, 3).map((x) => x.name).join(", ")} (lightly loaded).` });
  if (nLate) suggestions.push({ fr: "Revoir les tâches en retard : nouvelle échéance, aide ou fermeture.", en: "Review the late tasks: new due date, help, or close them." });
  if (abs.rows.length) suggestions.push({ fr: "Répartir le travail des personnes absentes avant leur départ.", en: "Share the work of the people who are away before they leave." });
  return c.json({ from, to, bullets, suggestions, source: "rules" });
});

meetingRoutes.get("/trends", async (c) => {
  const me = auth(c).user.id;
  const weeks = Math.min(52, Math.max(4, Number(c.req.query("weeks")) || 12));
  const thisMonday = mondayOf(todayISO());
  const out = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const start = addDays(thisMonday, -7 * i), end = addDays(start, 6);
    const r = await pool.query(
      `select count(*) filter (where t.created_at::date between $2 and $3)::int as created,
              count(*) filter (where t.completed_at::date between $2 and $3)::int as completed,
              count(*) filter (where t.created_at::date <= $3 and (t.completed_at is null or t.completed_at::date > $3))::int as open_at_end,
              avg(extract(epoch from (t.completed_at - t.created_at)) / 86400) filter (where t.completed_at::date between $2 and $3) as avg_days,
              count(*) filter (where t.completed_at::date between $2 and $3 and t.completed_at - t.created_at <= interval '2 days')::int as within2
         from tasks t where ${VIS}`, [me, start, end]);
    const x = r.rows[0];
    out.push({ weekStart: start, created: x.created, completed: x.completed, net: x.created - x.completed, openAtEnd: x.open_at_end, avgDays: x.avg_days == null ? null : Math.round(Number(x.avg_days) * 10) / 10, within2Pct: x.completed ? Math.round((x.within2 / x.completed) * 100) : null });
  }
  return c.json({ weeks, rows: out });
});
