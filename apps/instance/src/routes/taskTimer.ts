import { Hono } from "hono";
import { z } from "zod";
import { pool } from "../db.ts";
import { audit } from "../auth/access.ts";
import { requirePermission, type Env } from "../auth/session.ts";
import { addEntry, Fail } from "./time.ts";
import { auth, body, camel, camelRows, isUuid } from "./util.ts";

// The task timer: it starts when a task is opened (the screen decides), keeps running when the task is closed or the
// page is left, and when it stops the stretch of time waits as "pending" until it becomes a time entry with a short
// description (now or later, for example when the task is closed) or is dropped. Time entries are the ordinary
// timesheet entries, billable to the task's client, so approval and billing work as for any other time.
export const taskTimerRoutes = new Hono<Env>();

taskTimerRoutes.onError((e, c) => {
  if (e instanceof Fail) return c.json({ error: e.code }, e.status as 400);
  throw e;
});

const USE = requirePermission("mytools.timesheet.use", "mytools.timesheet.manage");
const VIEW = requirePermission("tasks.view", "command.pipeline.view");
const VISIBLE = `(t.visibility = 'team' or t.created_by = $1 or t.assignee_id = $1
                  or (t.visibility = 'selected' and exists (select 1 from task_viewers v where v.task_id = t.id and v.user_id = $1)))`;

const dayOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

async function running(userId: string) {
  const r = await pool.query(
    `select tm.task_id, tm.started_at, t.title, t.client_id, cl.name as client_name, t.status
       from task_timers tm join tasks t on t.id = tm.task_id left join clients cl on cl.id = t.client_id where tm.user_id = $1`, [userId]);
  return r.rows[0] ? camel(r.rows[0]) : null;
}

/** My running timer, and how many stretches of mine still wait to become time entries. */
taskTimerRoutes.get("/timer", VIEW, async (c) => {
  const me = auth(c).user.id;
  const pending = (await pool.query("select count(*)::int as n, coalesce(sum(minutes),0)::int as m from task_time_segments where user_id = $1 and status = 'pending'", [me])).rows[0];
  return c.json({ running: await running(me), pendingCount: pending.n, pendingMinutes: pending.m, now: new Date().toISOString() });
});

taskTimerRoutes.post("/timer/start", VIEW, USE, async (c) => {
  const me = auth(c).user.id;
  const d = await body(c, z.object({ taskId: z.string().uuid() }));
  const t = (await pool.query(`select t.id, t.status from tasks t where t.id = $2 and ${VISIBLE}`, [me, d.taskId])).rows[0];
  if (!t) throw new Fail(404, "not_found");
  const cur = await running(me);
  if (cur) {
    if ((cur as { taskId: string }).taskId === d.taskId) return c.json({ running: cur, already: true });
    throw new Fail(409, "timer_running");
  }
  await pool.query("insert into task_timers (user_id, task_id) values ($1, $2)", [me, d.taskId]);
  // Working on a new task means taking it over.
  if (t.status === "todo" || t.status === "taken") await pool.query("update tasks set status = 'doing', updated_at = now() where id = $1", [d.taskId]);
  return c.json({ running: await running(me) }, 201);
});

/** Stops the timer; the stretch becomes a pending segment the person then turns into a time entry (or not). */
taskTimerRoutes.post("/timer/stop", VIEW, USE, async (c) => {
  const me = auth(c).user.id;
  const t = (await pool.query("delete from task_timers where user_id = $1 returning task_id, started_at", [me])).rows[0];
  if (!t) throw new Fail(404, "no_timer");
  const seconds = Math.max(0, Math.round((Date.now() - new Date(t.started_at).getTime()) / 1000));
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  const seg = (await pool.query(
    "insert into task_time_segments (task_id, user_id, started_at, minutes) values ($1, $2, $3, $4) returning id", [t.task_id, me, t.started_at, minutes])).rows[0];
  const task = (await pool.query("select t.title, t.client_id, cl.name as client_name from tasks t left join clients cl on cl.id = t.client_id where t.id = $1", [t.task_id])).rows[0];
  return c.json({ segmentId: seg.id, taskId: t.task_id, minutes, startedAt: t.started_at, ...camel(task) });
});

/** Throws the running timer away (started by mistake). */
taskTimerRoutes.post("/timer/cancel", VIEW, USE, async (c) => {
  await pool.query("delete from task_timers where user_id = $1", [auth(c).user.id]);
  return c.json({ ok: true });
});

/** Every stretch of mine still waiting to become a time entry, with its task. */
taskTimerRoutes.get("/segments/pending", VIEW, async (c) => {
  const r = await pool.query(
    `select s.id, s.task_id, s.started_at, s.minutes, t.title, t.client_id, cl.name as client_name from task_time_segments s
       join tasks t on t.id = s.task_id left join clients cl on cl.id = t.client_id
      where s.user_id = $1 and s.status = 'pending' order by s.started_at`, [auth(c).user.id]);
  return c.json(camelRows(r));
});

taskTimerRoutes.get("/:id/segments", VIEW, async (c) => {
  const id = c.req.param("id");
  if (!isUuid(id)) throw new Fail(404, "not_found");
  const r = await pool.query(
    "select id, started_at, stopped_at, minutes, status from task_time_segments where task_id = $1 and user_id = $2 and status = 'pending' order by started_at", [id, auth(c).user.id]);
  return c.json(camelRows(r));
});

/** Turns a pending stretch into a timesheet entry billable to the task's client. */
taskTimerRoutes.post("/segments/:sid/log", VIEW, USE, async (c) => {
  const me = auth(c).user.id;
  const sid = c.req.param("sid");
  if (!isUuid(sid)) throw new Fail(404, "not_found");
  const d = await body(c, z.object({ description: z.string().trim().min(1).max(1000), minutes: z.number().int().min(1).max(1440).optional(), billable: z.boolean().optional() }));
  const seg = (await pool.query(
    "select s.*, t.client_id from task_time_segments s join tasks t on t.id = s.task_id where s.id = $1 and s.user_id = $2 and s.status = 'pending'", [sid, me])).rows[0];
  if (!seg) throw new Fail(404, "not_found");
  const minutes = d.minutes ?? Math.min(1440, seg.minutes);
  // Claimed first so a double click can never log it twice; given back if the entry is refused.
  const claim = (await pool.query("update task_time_segments set status = 'logged' where id = $1 and status = 'pending' returning id", [sid])).rowCount;
  if (!claim) throw new Fail(409, "already_logged");
  try {
    const e = await addEntry(c, {
      workDate: dayOf(new Date(seg.started_at)), typeKey: "work", minutes, taskId: seg.task_id, clientId: seg.client_id ?? null,
      description: d.description, billable: seg.client_id ? d.billable ?? true : false, // no client, nobody to bill
    });
    await pool.query("update task_time_segments set entry_id = $2 where id = $1", [sid, e.id]);
    return c.json({ entryId: e.id }, 201);
  } catch (err) {
    await pool.query("update task_time_segments set status = 'pending' where id = $1", [sid]);
    throw err;
  }
});

taskTimerRoutes.delete("/segments/:sid", VIEW, async (c) => {
  const sid = c.req.param("sid");
  if (!isUuid(sid)) throw new Fail(404, "not_found");
  await pool.query("update task_time_segments set status = 'discarded' where id = $1 and user_id = $2 and status = 'pending'", [sid, auth(c).user.id]);
  return c.json({ ok: true });
});

/** Closing a task without entering its time: drops every pending stretch of mine on it. */
taskTimerRoutes.post("/:id/segments/discard", VIEW, async (c) => {
  const id = c.req.param("id");
  if (!isUuid(id)) throw new Fail(404, "not_found");
  const r = await pool.query("update task_time_segments set status = 'discarded' where task_id = $1 and user_id = $2 and status = 'pending'", [id, auth(c).user.id]);
  await audit("task.time_discarded", { userId: auth(c).user.id, target: id, detail: { segments: r.rowCount } });
  return c.json({ discarded: r.rowCount });
});
