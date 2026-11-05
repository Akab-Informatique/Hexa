import { Hono } from "hono";
import { z } from "zod";
import { addDays, mondayOf, quebecHolidays, todayISO } from "@hexa/shared/billing";
import { pool, getSetting, setSetting } from "../db.ts";
import { audit } from "../auth/access.ts";
import { requirePermission, type Env } from "../auth/session.ts";
import { busyBlocks } from "../lib/microsoft.ts";
import { auth, body, camelRows, can, isUuid } from "./util.ts";

// Pipeline "My day", modelled on the reference. What is on a person's plate (tasks due, late, urgent, in progress,
// daily and continuous ones coming back) is laid out on their working day by the portal: never in lunch, never on an
// event, in order of importance. Nothing is booked; it is a suggestion that is always current (rules, no AI).
export const pipelineRoutes = new Hono<Env>();
const VIEW = ["tasks.view", "command.pipeline.view"];
const EDIT = ["tasks.edit", "command.pipeline.edit", "tasks.manage", "command.pipeline.manage"];
pipelineRoutes.use("*", requirePermission(...VIEW));

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const HHMM = z.string().regex(/^\d{1,2}:\d{2}$/);
interface Settings { workStart: string; workEnd: string; lunchStart: string; lunchEnd: string }
const DEFAULTS: Settings = { workStart: "08:30", workEnd: "17:00", lunchStart: "12:00", lunchEnd: "13:00" };
const settings = async (): Promise<Settings> => ({ ...DEFAULTS, ...((await getSetting<Partial<Settings>>("pipeline")) ?? {}) });
const mins = (s: string) => { const [h, m] = s.split(":"); return Number(h) * 60 + Number(m); };
const clock = (n: number) => `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
const VISIBLE = `(t.visibility = 'team' or t.created_by = $1 or t.assignee_id = $1 or (t.visibility = 'selected' and exists (select 1 from task_viewers v where v.task_id = t.id and v.user_id = $1)))`;

pipelineRoutes.get("/settings", async (c) => c.json(await settings()));
pipelineRoutes.put("/settings", requirePermission("command.pipeline.manage"), async (c) => {
  const d = await body(c, z.object({ workStart: HHMM, workEnd: HHMM, lunchStart: HHMM, lunchEnd: HHMM }));
  if (mins(d.workEnd) <= mins(d.workStart) || mins(d.lunchEnd) <= mins(d.lunchStart)) return c.json({ error: "hours_invalid" }, 400);
  await setSetting("pipeline", d);
  await audit("pipeline.settings", { userId: auth(c).user.id });
  return c.json({ ok: true });
});

/** The people whose day a manager can look at. */
pipelineRoutes.get("/people", async (c) => {
  if (!can(c, "command.pipeline.manage")) return c.json([]);
  return c.json((await pool.query("select id, name from users where kind = 'staff' and active order by lower(name)")).rows);
});

/** A daily task starts over each day: back to "to do", checklist unticked. */
async function resetDaily(userId: string, date: string) {
  const r = await pool.query("update tasks set status = 'todo', completed_at = null, last_reset_on = $2 where assignee_id = $1 and kind = 'daily' and (last_reset_on is null or last_reset_on < $2) returning id", [userId, date]);
  for (const t of r.rows) await pool.query("update task_checklist set done = false where task_id = $1", [t.id]);
}

const nowMinutesQuebec = () => {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", hour12: false, hour: "2-digit", minute: "2-digit" }).formatToParts(new Date());
  return Number(p.find((x) => x.type === "hour")!.value) % 24 * 60 + Number(p.find((x) => x.type === "minute")!.value);
};

pipelineRoutes.get("/day", async (c) => {
  const me = auth(c).user.id;
  const q = c.req.query("date");
  const date = q && Day.safeParse(q).success ? q : todayISO();
  const want = c.req.query("userId");
  if (want && want !== me && !can(c, "command.pipeline.manage")) return c.json({ error: "forbidden" }, 403);
  const userId = want && isUuid(want) ? want : me;
  const own = userId === me;
  const s = await settings();
  // Daily tasks start over on the day itself; looking at a coming day must not do it early.
  if (own && date <= todayISO()) await resetDaily(userId, date);

  const rows = (await pool.query(
    `select t.id, t.title, t.status, t.priority, t.kind, t.due_date, t.due_time, t.start_date, t.start_time, t.estimate_minutes, t.remind_every_days, t.last_checked_on, cl.name as client_name,
            ${VISIBLE} as visible, (w.id is not null and w.status <> 'done') as waiting,
            exists (select 1 from tasks s2 where s2.parent_id = t.id and s2.status <> 'done') as has_open_children,
            (select count(*)::int from task_checklist k where k.task_id = t.id) as checklist_total, (select count(*)::int from task_checklist k where k.task_id = t.id and k.done) as checklist_done
       from tasks t left join clients cl on cl.id = t.client_id left join tasks w on w.id = t.waits_for_id
      where t.assignee_id = $2 and t.status <> 'done' and (t.start_date is null or t.start_date <= $3)`, [me, userId, date])).rows;

  const mon = mondayOf(date), sun = addDays(mon, 6);
  const due = (r: { due_date: string | null }) => (r.due_date ? String(r.due_date).slice(0, 10) : null);
  const checkpointDue = (r: { kind: string; remind_every_days: number | null; last_checked_on: string | null }) =>
    r.kind === "continuous" && (!r.last_checked_on || addDays(String(r.last_checked_on).slice(0, 10), r.remind_every_days ?? 7) <= date);
  const onPlate = rows.filter((r) => !r.has_open_children && (
    (due(r) !== null && due(r)! <= date) || r.priority === "urgent" || r.status === "doing" || r.kind === "daily" || checkpointDue(r)));
  const waiting = onPlate.filter((r) => r.waiting), ready = onPlate.filter((r) => !r.waiting);
  const score = (r: typeof rows[number]) => (r.priority === "urgent" ? 0 : r.priority === "high" ? 1 : 2) * 10 + (due(r) && due(r)! < date ? 0 : r.status === "doing" ? 1 : due(r) === date ? 2 : 3);
  ready.sort((a, b) => score(a) - score(b) || String(due(a) ?? "9").localeCompare(String(due(b) ?? "9")) || String(a.due_time ?? "99").localeCompare(String(b.due_time ?? "99")));

  // Capacity: the working day less lunch and the events of the day; zero on a weekend, a holiday or an absence.
  const dow = (new Date(`${date}T12:00:00`).getDay() + 6) % 7;
  const holiday = quebecHolidays(Number(date.slice(0, 4))).find((h) => h.date === date);
  const away = (await pool.query("select kind from absences where user_id = $1 and starts_on <= $2 and ends_on >= $2 limit 1", [userId, date])).rows[0];
  const dayOff = dow >= 5 ? "weekend" : holiday ? "holiday" : away ? "absence" : null;
  const events = (await pool.query("select title, start_time, end_time from meeting_events where event_date = $1 and (user_id is null or user_id = $2) and start_time is not null and end_time is not null order by start_time", [date, userId])).rows;
  // The person's own Outlook calendar (when connected) takes its hours off the day too.
  const outlook = own ? await busyBlocks(userId, date) : [];
  events.push(...outlook.map((o) => ({ title: `${o.title}`, start_time: o.start, end_time: o.end })));
  const ws = mins(s.workStart), we = mins(s.workEnd), ls = mins(s.lunchStart), le = mins(s.lunchEnd);
  const busy = [{ s: ls, e: le, kind: "lunch" as const, title: "" }, ...events.map((e) => ({ s: mins(e.start_time), e: mins(e.end_time), kind: "event" as const, title: e.title as string }))].sort((a, b) => a.s - b.s);
  const overlapIn = (a: number, b: number) => busy.reduce((t, x) => t + Math.max(0, Math.min(b, x.e) - Math.max(a, x.s)), 0);
  const capacity = dayOff ? 0 : Math.max(0, we - ws - overlapIn(ws, we));

  const items = ready.map((r) => ({ id: r.id, title: r.visible ? r.title : null, private: !r.visible, status: r.status, priority: r.priority, kind: r.kind, dueDate: due(r), dueTime: r.due_time, clientName: r.visible ? r.client_name : null, minutes: Math.max(5, r.estimate_minutes ?? 30), late: due(r) !== null && due(r)! < date, checklistTotal: r.checklist_total, checklistDone: r.checklist_done, checkpoint: checkpointDue(r), startTime: r.start_time }));
  // Lay the items out one after the other; never across lunch or an event; what does not fit is listed apart.
  let cursor = ws;
  if (own && date === todayISO()) cursor = Math.max(ws, Math.ceil(nowMinutesQuebec() / 15) * 15);
  const blocks: { kind: "task" | "event" | "lunch"; start: string; end: string; title: string | null; taskId?: string; priority?: string; private?: boolean }[] = [];
  const overflow: typeof items = [];
  if (dayOff) overflow.push(...items);
  else for (const it of items) {
    let start = Math.max(cursor, it.startTime ? mins(it.startTime) : 0);
    for (let guard = 0; guard < 20; guard++) { const hit = busy.find((b) => start < b.e && start + it.minutes > b.s); if (!hit) break; start = hit.e; }
    if (start + it.minutes <= we) { blocks.push({ kind: "task", start: clock(start), end: clock(start + it.minutes), title: it.title, taskId: it.id, priority: it.priority, private: it.private }); cursor = start + it.minutes; } else overflow.push(it);
  }
  if (!dayOff) for (const b of busy) blocks.push({ kind: b.kind, start: clock(b.s), end: clock(b.e), title: b.kind === "event" ? b.title : null });
  blocks.sort((a, b) => a.start.localeCompare(b.start));
  const planned = items.reduce((t, i) => t + i.minutes, 0);

  const week = rows.filter((r) => ["urgent", "high"].includes(r.priority) && due(r) !== null && due(r)! <= sun && !r.has_open_children)
    .sort((a, b) => String(due(a)).localeCompare(String(due(b)))).slice(0, 15)
    .map((r) => ({ id: r.id, title: r.visible ? r.title : null, private: !r.visible, priority: r.priority, dueDate: due(r), clientName: r.visible ? r.client_name : null }));

  return c.json({
    date, userId, own, settings: s, dayOff, dayOffName: holiday ? { fr: holiday.fr, en: holiday.en } : null,
    capacityMinutes: capacity, plannedMinutes: planned, freeMinutes: capacity - planned,
    items, waiting: waiting.map((r) => ({ id: r.id, title: r.visible ? r.title : null })), blocks, overflow, week,
    source: "rules", nowMinutes: own && date === todayISO() ? nowMinutesQuebec() : null,
  });
});

// ------------------------------------------------------------------ Continuous tasks and files
async function editable(c: Parameters<typeof can>[0], id: string) {
  if (!isUuid(id)) return null;
  const t = (await pool.query("select created_by, assignee_id from tasks where id = $1", [id])).rows[0];
  if (!t) return null;
  const me = auth(c).user.id;
  return can(c, "tasks.manage", "command.pipeline.manage") || t.created_by === me || t.assignee_id === me ? t : "forbidden";
}

/** "I checked it": a continuous task comes back after its reminder days. */
pipelineRoutes.post("/tasks/:id/check", requirePermission(...EDIT), async (c) => {
  const t = await editable(c, c.req.param("id"));
  if (!t) return c.json({ error: "not found" }, 404);
  if (t === "forbidden") return c.json({ error: "forbidden" }, 403);
  const d = await body(c, z.object({ date: Day.optional() }));
  const r = await pool.query("update tasks set last_checked_on = $2 where id = $1 and kind = 'continuous' returning id", [c.req.param("id"), d.date ?? todayISO()]);
  return r.rowCount ? c.json({ ok: true }) : c.json({ error: "not_continuous" }, 409);
});

const MAX_B64 = 7_000_000; // about 5 MB
pipelineRoutes.get("/tasks/:id/files", async (c) => {
  if (!isUuid(c.req.param("id"))) return c.json([]);
  const ok = await pool.query(`select 1 from tasks t where t.id = $2 and ${VISIBLE}`, [auth(c).user.id, c.req.param("id")]);
  if (!ok.rowCount) return c.json([]);
  const r = await pool.query("select f.id, f.name, f.content_type, f.size, f.created_at, u.name as by_name from task_files f left join users u on u.id = f.created_by where f.task_id = $1 order by f.created_at", [c.req.param("id")]);
  return c.json(camelRows(r));
});
pipelineRoutes.post("/tasks/:id/files", requirePermission(...EDIT), async (c) => {
  const t = await editable(c, c.req.param("id"));
  if (!t) return c.json({ error: "not found" }, 404);
  if (t === "forbidden") return c.json({ error: "forbidden" }, 403);
  const d = await body(c, z.object({ name: z.string().min(1).max(200), type: z.string().max(100).optional(), data: z.string().min(1).max(MAX_B64) }));
  const n = Number((await pool.query("select count(*) as n from task_files where task_id = $1", [c.req.param("id")])).rows[0].n);
  if (n >= 20) return c.json({ error: "too_many_files" }, 409);
  const size = Math.floor((d.data.length * 3) / 4);
  await pool.query("insert into task_files (task_id, name, content_type, size, data_b64, created_by) values ($1,$2,$3,$4,$5,$6)", [c.req.param("id"), d.name, d.type ?? "application/octet-stream", size, d.data, auth(c).user.id]);
  return c.json({ ok: true }, 201);
});
/** Always a download, never shown in the page. */
pipelineRoutes.get("/files/:fid", async (c) => {
  const f = (await pool.query(`select f.* from task_files f join tasks t on t.id = f.task_id where f.id::text = $2 and ${VISIBLE}`, [auth(c).user.id, c.req.param("fid")])).rows[0];
  if (!f) return c.json({ error: "not found" }, 404);
  return new Response(Buffer.from(f.data_b64, "base64"), { headers: { "content-type": "application/octet-stream", "x-content-type-options": "nosniff", "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}` } });
});
pipelineRoutes.delete("/files/:fid", requirePermission(...EDIT), async (c) => {
  const f = (await pool.query("select task_id from task_files where id::text = $1", [c.req.param("fid")])).rows[0];
  if (!f) return c.json({ ok: true });
  const t = await editable(c, f.task_id);
  if (!t || t === "forbidden") return c.json({ error: "forbidden" }, 403);
  await pool.query("delete from task_files where id::text = $1", [c.req.param("fid")]);
  return c.json({ ok: true });
});
