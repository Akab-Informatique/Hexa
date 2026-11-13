import { Hono } from "hono";
import { z } from "zod";
import { addDays, mondayOf } from "@hexa/shared/billing";
import { pool } from "../db.ts";
import { audit } from "../auth/access.ts";
import { requirePermission, type Env } from "../auth/session.ts";
import { splitByQuebecDay } from "../lib/timesheetPayroll.ts";
import { quebecToday } from "../lib/quebecDate.ts";
import { assertDayCap, Fail, recordEntry, snap } from "./time.ts";
import { auth, body, camel, camelRows, isUuid } from "./util.ts";

// The task timer: it starts when a task is opened (the screen decides), keeps running when the task is closed or the
// page is left. When it stops, the stretch of time BECOMES A DRAFT TIMESHEET ENTRY AT ONCE (source 'timer'), linked to the
// task and its client, so no minute can be lost: the person then edits its description, minutes and billable flag.
// Nothing is dropped any more: a draft timer entry can only be deleted through DELETE /time/entries/:id (audited).
//
// Minutes come from SERVER timestamps only (see minutesFromSeconds in lib/timesheetPayroll.ts): whole seconds, rounded UP
// to the minute, minimum 1. A stretch crossing a Quebec midnight is cut in one entry per day.
export const taskTimerRoutes = new Hono<Env>();

taskTimerRoutes.onError((e, c) => {
  if (e instanceof Fail) return c.json({ error: e.code }, e.status as 400);
  throw e;
});

const USE = requirePermission("mytools.timesheet.use", "mytools.timesheet.manage");
const VIEW = requirePermission("tasks.view", "command.pipeline.view");
const VISIBLE = `(t.visibility = 'team' or t.created_by = $1 or t.assignee_id = $1
                  or (t.visibility = 'selected' and exists (select 1 from task_viewers v where v.task_id = t.id and v.user_id = $1)))`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = { query: (text: string, values?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }> };

async function running(userId: string) {
  const r = await pool.query(
    `select tm.task_id, tm.started_at, t.title, t.client_id, cl.name as client_name, t.status
       from task_timers tm join tasks t on t.id = tm.task_id left join clients cl on cl.id = t.client_id where tm.user_id = $1`, [userId]);
  return r.rows[0] ? camel(r.rows[0]) : null;
}

/** My running timer, and how many stretches from before the automatic entries still wait (legacy, normally 0). */
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
  // One running timer per person: the primary key on task_timers.user_id settles a double click or a second tab.
  try { await pool.query("insert into task_timers (user_id, task_id) values ($1, $2)", [me, d.taskId]); }
  catch (e) { if ((e as { code?: string }).code === "23505") throw new Fail(409, "timer_running"); throw e; }
  // Working on a new task means taking it over.
  if (t.status === "todo" || t.status === "taken") await pool.query("update tasks set status = 'doing', updated_at = now() where id = $1", [d.taskId]);
  return c.json({ running: await running(me) }, 201);
});

/** Where a stretch lands: its own Quebec day, or, when that week was already sent or approved, the first open week (kept in origin_date). */
async function openSlot(db: Db, userId: string, date: string): Promise<{ workDate: string; originDate: string | null }> {
  let monday = mondayOf(date);
  for (let i = 0; i < 60; i++) {
    const w = (await db.query("select status from timesheet_weeks where user_id = $1 and week_start = $2", [userId, monday])).rows[0];
    if (!w || w.status === "draft" || w.status === "rejected") return monday === mondayOf(date) ? { workDate: date, originDate: null } : { workDate: monday, originDate: date };
    monday = addDays(monday, 7);
  }
  throw new Fail(409, "timesheet_locked");
}

interface Made { entryId: string; segmentId: string; workDate: string; originDate: string | null; minutes: number }

/** Writes the draft entries (and their segment records) of a stopped stretch, inside the caller's transaction. */
async function makeEntries(db: Db, o: { userId: string; taskId: string; title: string; clientId: string | null; startedAt: Date; stoppedAt: Date }): Promise<Made[]> {
  const out: Made[] = [];
  for (const ch of splitByQuebecDay(o.startedAt, o.stoppedAt)) {
    const slot = await openSlot(db, o.userId, ch.workDate);
    const e = (await db.query(
      `insert into timesheet_entries (user_id, work_date, type_key, minutes, client_id, task_id, description, billable, status, source, measured_minutes, origin_date)
       values ($1,$2,'work',$3,$4,$5,$6,$7,'draft','timer',$3,$8) returning id`,
      [o.userId, slot.workDate, ch.minutes, o.clientId, o.taskId, o.title.slice(0, 1000), o.clientId != null, slot.originDate])).rows[0];
    const s = (await db.query(
      "insert into task_time_segments (task_id, user_id, started_at, stopped_at, minutes, status, entry_id) values ($1,$2,$3,$4,$5,'logged',$6) returning id",
      [o.taskId, o.userId, new Date(ch.startMs), new Date(ch.endMs), ch.minutes, e.id])).rows[0];
    await db.query("insert into timesheet_entry_history (entry_id, user_id, actor_id, action, after) values ($1,$2,$2,'create',$3::jsonb)",
      [e.id, o.userId, JSON.stringify({ source: "timer", workDate: slot.workDate, originDate: slot.originDate, minutes: ch.minutes, taskId: o.taskId, clientId: o.clientId })]);
    out.push({ entryId: e.id, segmentId: s.id, workDate: slot.workDate, originDate: slot.originDate, minutes: ch.minutes });
  }
  return out;
}

/**
 * Stops the running timer and turns the stretch into draft entries, all in one transaction (a crash can never leave the
 * timer deleted without its entry). With discardUnder (cancel), a stretch shorter than that many seconds is a mis-click and is dropped.
 */
export async function stopTimer(userId: string, discardUnder = 0) {
  const db = await pool.connect();
  try {
    await db.query("begin");
    const t = (await db.query("delete from task_timers where user_id = $1 returning task_id, started_at, clock_timestamp() as stopped_at", [userId])).rows[0];
    if (!t) { await db.query("rollback"); return null; }
    const startedAt = new Date(t.started_at);
    const stoppedAt = new Date(t.stopped_at);
    const seconds = Math.max(0, Math.floor((stoppedAt.getTime() - startedAt.getTime()) / 1000));
    if (discardUnder && seconds < discardUnder) { await db.query("commit"); return { discarded: true as const, taskId: t.task_id as string, seconds }; }
    const task = (await db.query("select t.title, t.client_id, cl.name as client_name from tasks t left join clients cl on cl.id = t.client_id where t.id = $1", [t.task_id])).rows[0];
    const made = await makeEntries(db, { userId, taskId: t.task_id, title: task?.title ?? "", clientId: task?.client_id ?? null, startedAt, stoppedAt });
    await db.query("commit");
    for (const m of made) await audit("timesheet.entry_create", { userId, target: m.entryId, detail: { owner: userId, source: "timer", minutes: m.minutes } });
    const first = made[0]!;
    return {
      discarded: false as const, segmentId: first.segmentId, entryId: first.entryId, entryIds: made.map((m) => m.entryId), taskId: t.task_id as string,
      minutes: first.minutes, totalMinutes: made.reduce((a, m) => a + m.minutes, 0), startedAt: startedAt.toISOString(), workDate: first.workDate, carriedFrom: first.originDate,
      title: (task?.title ?? "") as string, clientId: (task?.client_id ?? null) as string | null, clientName: (task?.client_name ?? null) as string | null,
    };
  } catch (e) {
    await db.query("rollback").catch(() => undefined);
    throw e;
  } finally { db.release(); }
}

/** Stops the timer; the time is already a draft timesheet entry when this answers. */
taskTimerRoutes.post("/timer/stop", VIEW, USE, async (c) => {
  const r = await stopTimer(auth(c).user.id);
  if (!r) throw new Fail(404, "no_timer");
  return c.json(r);
});

/**
 * "Started by mistake": only a timer younger than one minute is thrown away. An older one is stopped like any other,
 * so cancelling can never lose time (the entry stays, the person deletes it while it is a draft).
 */
taskTimerRoutes.post("/timer/cancel", VIEW, USE, async (c) => {
  const r = await stopTimer(auth(c).user.id, 60);
  if (r?.discarded) await audit("task.timer_cancelled", { userId: auth(c).user.id, target: r.taskId, detail: { seconds: r.seconds } });
  return c.json({ ok: true, kept: Boolean(r && !r.discarded) });
});

/** Legacy stretches from before the automatic entries (normally none). */
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

/**
 * Edits the timesheet entry a stopped stretch created (description, minutes, billable), while it is draft or rejected and
 * the week is open. For a legacy pending stretch it creates the entry instead. Only the owner of the segment can use it.
 */
taskTimerRoutes.post("/segments/:sid/log", VIEW, USE, async (c) => {
  const me = auth(c).user.id;
  const sid = c.req.param("sid");
  if (!isUuid(sid)) throw new Fail(404, "not_found");
  const d = await body(c, z.object({ description: z.string().trim().min(1).max(1000).optional(), minutes: z.number().int().min(1).max(1440).optional(), billable: z.boolean().optional() }));
  const seg = (await pool.query(
    "select s.*, t.client_id, t.title from task_time_segments s join tasks t on t.id = s.task_id where s.id = $1 and s.user_id = $2", [sid, me])).rows[0];
  if (!seg) throw new Fail(404, "not_found");

  if (!seg.entry_id) { // legacy pending stretch: becomes an entry now (carried to an open week if its own is locked)
    if (seg.status !== "pending") throw new Fail(404, "not_found");
    const db = await pool.connect();
    try {
      await db.query("begin");
      const claim = (await db.query("update task_time_segments set status = 'logged' where id = $1 and status = 'pending' returning id", [sid])).rowCount;
      if (!claim) throw new Fail(409, "already_logged");
      const day = quebecToday(new Date(seg.started_at));
      const slot = await openSlot(db, me, day);
      const minutes = Math.min(1440, d.minutes ?? seg.minutes);
      const e = (await db.query(
        `insert into timesheet_entries (user_id, work_date, type_key, minutes, client_id, task_id, description, billable, status, source, measured_minutes, origin_date)
         values ($1,$2,'work',$3,$4,$5,$6,$7,'draft','timer',$8,$9) returning id`,
        [me, slot.workDate, minutes, seg.client_id ?? null, seg.task_id, (d.description ?? seg.title).slice(0, 1000), seg.client_id ? d.billable ?? true : false, Math.min(1440, seg.minutes), slot.originDate])).rows[0];
      await db.query("update task_time_segments set entry_id = $2 where id = $1", [sid, e.id]);
      await db.query("insert into timesheet_entry_history (entry_id, user_id, actor_id, action, after) values ($1,$2,$2,'create',$3::jsonb)", [e.id, me, JSON.stringify({ source: "timer", legacy: true, minutes })]);
      await db.query("commit");
      await audit("timesheet.entry_create", { userId: me, target: e.id, detail: { owner: me, source: "timer", legacy: true } });
      return c.json({ entryId: e.id }, 201);
    } catch (err) { await db.query("rollback").catch(() => undefined); throw err; } finally { db.release(); }
  }

  const e = (await pool.query("select * from timesheet_entries where id = $1 and user_id = $2", [seg.entry_id, me])).rows[0];
  if (!e) throw new Fail(404, "not_found");
  if (e.status !== "draft" && e.status !== "rejected") throw new Fail(409, "timesheet_locked");
  const wk = (await pool.query("select status from timesheet_weeks where user_id = $1 and week_start = $2", [me, mondayOf(e.work_date)])).rows[0];
  if (wk && wk.status !== "draft" && wk.status !== "rejected") throw new Fail(409, "timesheet_locked");
  if ((await pool.query("select 1 from billing_items where source = 'time' and source_id = $1 and status = 'invoiced'", [e.id])).rowCount) throw new Fail(409, "entry_invoiced");
  const minutes = d.minutes ?? e.minutes;
  if (minutes !== e.minutes) await assertDayCap(me, e.work_date, minutes, e.id);
  const billable = e.client_id ? d.billable ?? e.billable : false; // no client, nobody to bill
  const description = d.description ?? e.description;
  await pool.query("update timesheet_entries set minutes = $2, description = $3, billable = $4, billable_minutes = case when $4 then billable_minutes else null end, updated_at = now() where id = $1", [e.id, minutes, description, billable]);
  await recordEntry("update", me, e.id, me, snap(e), { ...snap(e), minutes, description, billable });
  return c.json({ entryId: e.id });
});

/** Time can no longer be dropped from here: delete the draft entry in the timesheet (audited) instead. */
taskTimerRoutes.delete("/segments/:sid", VIEW, async (c) => c.json({ error: "time_cannot_be_dropped" }, 409));

/** Kept so older screens keep working: it drops nothing (the time is already in the timesheet). */
taskTimerRoutes.post("/:id/segments/discard", VIEW, async (c) => c.json({ discarded: 0 }));

