import { Hono } from "hono";
import { z } from "zod";
import { addRecurrence, todayISO, addDays, fridayOf, mondayOf } from "@hexa/shared/billing";
import { pool } from "../db.ts";
import { requirePermission, type Env } from "../auth/session.ts";
import { autoApproveClients, billTimeEntries, unbillTaskTime } from "../lib/timeBilling.ts";
import { stopTimer } from "./taskTimer.ts";
import { audit } from "../auth/access.ts";
import { ASSIGNEES_JSON, MAX_ASSIGNEES, invalidAssignees, isAssigneeSql, normalizeAssignees, setAssignees, taskVisibleSql } from "../lib/taskAssignees.ts";
import { copyAttachments, mailForTask, MAIL_ID } from "../lib/mailTask.ts";
import { ServiceError } from "../lib/services.ts";
import { auth, body, buildUpdate, camel, camelRows, can, isUuid } from "./util.ts";

export const taskRoutes = new Hono<Env>();

// Tasks and the Pipeline share one task table, so either family of rights opens the API.
const VIEW = ["tasks.view", "command.pipeline.view"];
const EDIT = ["tasks.edit", "command.pipeline.edit", "tasks.manage", "command.pipeline.manage"];
const isManager = (c: Parameters<typeof can>[0]) => can(c, "tasks.manage", "command.pipeline.manage");

/** Reference rule: private tasks are hidden even from managers; "selected" only to chosen viewers. */
const VISIBLE = taskVisibleSql("$1");

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable();
const TaskInput = z.object({
  title: z.string().min(1).max(300), description: z.string().max(20000).optional(),
  status: z.enum(["todo", "taken", "doing", "blocked", "done"]).optional(), priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  assigneeId: z.string().uuid().nullable().optional(), assigneeIds: z.array(z.string().uuid()).max(MAX_ASSIGNEES).optional(), clientId: z.string().uuid().nullable().optional(),
  startDate: Day.optional(), dueDate: Day.optional(), estimateMinutes: z.number().int().min(0).max(100000).nullable().optional(),
  visibility: z.enum(["team", "private", "selected"]).optional(), parentId: z.string().uuid().nullable().optional(),
  waitsForId: z.string().uuid().nullable().optional(),
  recurrence: z.object({ every: z.number().int().min(1).max(365), unit: z.enum(["day", "week", "month", "year"]), until: Day.optional() }).nullable().optional(),
  tags: z.array(z.string().max(40)).max(20).optional(), viewerIds: z.array(z.string().uuid()).optional(),
  kind: z.enum(["normal", "continuous", "daily"]).optional(), startTime: z.string().regex(/^\d{1,2}:\d{2}$/).nullable().optional(), dueTime: z.string().regex(/^\d{1,2}:\d{2}$/).nullable().optional(),
  remindEveryDays: z.number().int().min(1).max(365).nullable().optional(),
  checklist: z.array(z.string().trim().min(1).max(500)).max(100).optional(), // bullet points given when the task is created
});
const COLS: Record<string, string> = {
  title: "title", description: "description", status: "status", priority: "priority", assigneeId: "assignee_id", clientId: "client_id",
  startDate: "start_date", dueDate: "due_date", estimateMinutes: "estimate_minutes", visibility: "visibility", parentId: "parent_id",
  waitsForId: "waits_for_id", tags: "tags", kind: "kind", startTime: "start_time", dueTime: "due_time", remindEveryDays: "remind_every_days",
};

const SELECT = `select t.*, a.name as assignee_name, ${ASSIGNEES_JSON}, cl.name as client_name,
                (select count(*)::int from task_checklist k where k.task_id = t.id) as checklist_total,
                (select count(*)::int from task_checklist k where k.task_id = t.id and k.done) as checklist_done,
                (select count(*)::int from tasks s where s.parent_id = t.id) as subtask_total,
                (w.id is not null and w.status <> 'done') as is_waiting, w.title as waits_for_title
           from tasks t left join users a on a.id = t.assignee_id left join clients cl on cl.id = t.client_id left join tasks w on w.id = t.waits_for_id`;

taskRoutes.get("/", requirePermission(...VIEW), async (c) => {
  const me = auth(c).user.id;
  const q = c.req.query();
  const where: string[] = [VISIBLE];
  const args: unknown[] = [me];
  const arg = (v: unknown) => { args.push(v); return `$${args.length}`; };

  const assignee = q.assignee;
  if (assignee === "me") where.push(isAssigneeSql(arg(me)));
  else if (assignee === "none") where.push("not exists (select 1 from task_assignees x where x.task_id = t.id)");
  else if (assignee && isUuid(assignee)) where.push(isAssigneeSql(arg(assignee)));
  if (q.status === "open") where.push("t.status <> 'done'");
  else if (q.status && ["todo", "taken", "doing", "blocked", "done"].includes(q.status)) where.push(`t.status = ${arg(q.status)}`);
  if (q.client && isUuid(q.client)) where.push(`t.client_id = ${arg(q.client)}`);
  if (q.priority && ["low", "normal", "high", "urgent"].includes(q.priority)) where.push(`t.priority = ${arg(q.priority)}`);
  if (q.parent === "none") where.push("t.parent_id is null");
  else if (q.parent && isUuid(q.parent)) where.push(`t.parent_id = ${arg(q.parent)}`);
  const today = todayISO();
  if (q.due === "overdue") where.push(`t.due_date < ${arg(today)} and t.status <> 'done'`);
  else if (q.due === "today") where.push(`t.due_date = ${arg(today)}`);
  else if (q.due === "friday") where.push(`t.due_date between ${arg(today)} and ${arg(fridayOf(today))} and t.status <> 'done'`);
  else if (q.due === "week") where.push(`t.due_date between ${arg(mondayOf(today))} and ${arg(addDays(mondayOf(today), 6))}`);
  if (q.q?.trim()) where.push(`(t.title ilike '%' || ${arg(q.q.trim())} || '%' or t.description ilike '%' || ${arg(q.q.trim())} || '%')`);

  // Time logged per task, one aggregated join (no N+1); same visibility rule as the task detail's time list:
  // own entries in any status, others' only when submitted/approved, unless the viewer approves/manages timesheets.
  args.push(can(c, "mytools.timesheet.approve", "mytools.timesheet.manage"));
  const seeAll = `$${args.length}`;
  const r = await pool.query(
    `select x.*, coalesce(lt.minutes, 0)::int as logged_minutes from (${SELECT} where ${where.join(" and ")}) x
       left join (select e.task_id, sum(e.minutes) as minutes from timesheet_entries e
                   where e.task_id is not null and (${seeAll}::boolean or e.user_id = $1 or e.status in ('submitted','approved'))
                   group by e.task_id) lt on lt.task_id = x.id
      order by (x.status = 'done'), x.due_date nulls last, array_position(array['urgent','high','normal','low'], x.priority), x.created_at desc limit 500`,
    args,
  );
  return c.json(camelRows(r));
});

/** The Pipeline's "my day": everything that needs me today, in order of urgency. */
taskRoutes.get("/day", requirePermission(...VIEW), async (c) => {
  const me = auth(c).user.id;
  const today = todayISO();
  const r = await pool.query(
    `${SELECT} where ${VISIBLE} and ${isAssigneeSql("$1")} and t.status <> 'done' and (t.due_date <= $2 or t.status = 'doing')
      order by t.due_date nulls last, array_position(array['urgent','high','normal','low'], t.priority)`,
    [me, today],
  );
  const rows = camelRows<{ dueDate: string | null; status: string }>(r);
  return c.json({
    today,
    overdue: rows.filter((t) => t.dueDate && t.dueDate < today),
    dueToday: rows.filter((t) => t.dueDate === today),
    doing: rows.filter((t) => t.status === "doing" && !(t.dueDate && t.dueDate <= today)),
  });
});

taskRoutes.post("/", requirePermission(...EDIT), async (c) => {
  const d = await body(c, TaskInput);
  const me = auth(c).user.id;
  const people = normalizeAssignees(d.assigneeIds, d.assigneeId) ?? [me];
  const bad = await invalidAssignees(pool, people);
  if (bad.length) return c.json({ error: "invalid assignee" }, 400);
  const r = await pool.query(
    `insert into tasks (title, description, status, priority, assignee_id, created_by, client_id, start_date, due_date, estimate_minutes, visibility, parent_id, waits_for_id, recurrence, tags)
     values ($1, coalesce($2,''), coalesce($3,'todo'), coalesce($4,'normal'), $5, $6, $7, $8, $9, $10, coalesce($11,'team'), $12, $13, $14::jsonb, coalesce($15::text[], '{}')) returning id`,
    [d.title, d.description, d.status, d.priority, people[0] ?? null, me, d.clientId ?? null, d.startDate ?? null, d.dueDate ?? null,
     d.estimateMinutes ?? null, d.visibility, d.parentId ?? null, d.waitsForId ?? null, d.recurrence ? JSON.stringify(d.recurrence) : null, d.tags],
  );
  const id = r.rows[0].id as string;
  await setAssignees(pool, id, people);
  if (people.length > 1) await audit("task.assignees", { userId: me, target: id, detail: { assigneeIds: people } });
  if (d.checklist?.length) await pool.query("insert into task_checklist (task_id, text, position) select $1, t, i - 1 from unnest($2::text[]) with ordinality as u(t, i)", [id, d.checklist]);
  if (d.viewerIds?.length) for (const v of d.viewerIds) await pool.query("insert into task_viewers values ($1, $2) on conflict do nothing", [id, v]);
  if (d.kind || d.startTime || d.dueTime || d.remindEveryDays) {
    // A continuous task comes back every n days (a week by default); a daily one never has a due day.
    await pool.query("update tasks set kind = coalesce($2, kind), start_time = $3, due_time = $4, remind_every_days = case when coalesce($2, kind) = 'continuous' then coalesce($5, 7) else null end where id = $1", [id, d.kind ?? null, d.startTime ?? null, d.dueTime ?? null, d.remindEveryDays ?? null]);
  }
  return c.json({ id }, 201);
});

taskRoutes.get("/:id", requirePermission(...VIEW), async (c) => {
  const id = c.req.param("id");
  if (!isUuid(id)) return c.json({ error: "not found" }, 404);
  const r = await pool.query(`${SELECT} where t.id = $2 and ${VISIBLE}`, [auth(c).user.id, id]);
  if (!r.rows[0]) return c.json({ error: "not found" }, 404);
  const [checklist, notes, subtasks, viewers, time] = await Promise.all([
    pool.query("select * from task_checklist where task_id = $1 order by position, id", [id]),
    pool.query("select n.*, u.name as user_name from task_notes n left join users u on u.id = n.user_id where n.task_id = $1 order by n.created_at", [id]),
    pool.query("select id, title, status, assignee_id, due_date from tasks s where s.parent_id = $2 and (s.visibility = 'team' or s.created_by = $1 or exists (select 1 from task_assignees x where x.task_id = s.id and x.user_id = $1)) order by s.created_at", [auth(c).user.id, id]),
    pool.query("select u.id, u.name from task_viewers v join users u on u.id = v.user_id where v.task_id = $1", [id]),
    // Deliberate rule, narrower than time.ts (which keeps timesheets private to their owner and approvers): any viewer of a task
    // sees who logged how much and when, but only for the viewer's own entries or submitted/approved ones; drafts/rejected entries
    // of others stay hidden. The free-text description is only returned for the viewer's own entries (or to approvers/managers).
    // Billable flag only for the viewer's own entries; `editable` mirrors what PATCH/DELETE /api/time/entries/:id accept
    // (owner, entry and week still draft/rejected, not invoiced) so the pencil and trash only show where they will work.
    pool.query(
      `select e.id, e.work_date, e.minutes, case when $3 or e.user_id = $2 then e.description else '' end as description, u.name as user_name,
              e.user_id = $2 as mine, case when e.user_id = $2 then e.billable end as billable, e.client_id is not null as has_client,
              (e.user_id = $2 and e.status in ('draft','rejected')
                and coalesce((select w.status from timesheet_weeks w where w.user_id = e.user_id and w.week_start = date_trunc('week', e.work_date)::date), 'draft') in ('draft','rejected')
                and not exists (select 1 from billing_items b where b.source = 'time' and b.source_id = e.id and b.status <> 'pending')) as editable
         from timesheet_entries e join users u on u.id = e.user_id
        where e.task_id = $1 and ($3 or e.user_id = $2 or e.status in ('submitted','approved'))
        order by e.work_date desc, e.created_at desc`,
      [id, auth(c).user.id, can(c, "mytools.timesheet.approve", "mytools.timesheet.manage")]),
  ]);
  return c.json({ ...camel(r.rows[0]), checklist: camelRows(checklist), notes: camelRows(notes), subtasks: camelRows(subtasks), viewers: viewers.rows, timeEntries: camelRows(time) });
});

async function loadForEdit(c: Parameters<typeof can>[0], id: string) {
  const r = await pool.query("select t.*, " + isAssigneeSql("$1") + " as is_assignee from tasks t where t.id = $2 and " + VISIBLE, [auth(c).user.id, id]);
  const t = r.rows[0];
  if (!t) return null;
  const me = auth(c).user.id;
  // tasks.edit = my own tasks (created or assigned); tasks.manage = anyone's.
  return isManager(c) || t.created_by === me || t.is_assignee ? t : "forbidden";
}

taskRoutes.patch("/:id", requirePermission(...EDIT), async (c) => {
  const id = c.req.param("id");
  const t = await loadForEdit(c, id);
  if (!t) return c.json({ error: "not found" }, 404);
  if (t === "forbidden") return c.json({ error: "forbidden" }, 403);
  const d = await body(c, TaskInput.partial());
  const people = normalizeAssignees(d.assigneeIds, d.assigneeId);
  if (people && (await invalidAssignees(pool, people)).length) return c.json({ error: "invalid assignee" }, 400);
  if (d.parentId === id || d.waitsForId === id) return c.json({ error: "a task cannot depend on itself" }, 400);

  // Dependency loop check: following "waits for" from the new target must never come back to this task.
  if (d.waitsForId) {
    let cursor: string | null = d.waitsForId;
    for (let i = 0; cursor && i < 50; i++) {
      if (cursor === id) return c.json({ error: "dependency loop" }, 400);
      cursor = (await pool.query("select waits_for_id from tasks where id = $1", [cursor])).rows[0]?.waits_for_id ?? null;
    }
  }

  const closing = d.status === "done" && t.status !== "done";
  if (closing) {
    const wait = (await pool.query("select 1 from tasks w where w.id = $1 and w.status <> 'done'", [d.waitsForId === undefined ? t.waits_for_id : d.waitsForId])).rowCount;
    if (wait) return c.json({ error: "this task is waiting for another task that is not done" }, 409);
    const open = (await pool.query("select 1 from task_checklist where task_id = $1 and not done limit 1", [id])).rowCount;
    if (open) return c.json({ error: "complete the checklist first" }, 409);
  }

  // Completing a task ends any timer still running on it, like Stop: the time becomes a draft timesheet entry (nothing is lost) and is billed below.
  if (closing) {
    for (const r of (await pool.query("select user_id from task_timers where task_id = $1", [id])).rows) await stopTimer(r.user_id as string);
  }

  const { sets, values } = buildUpdate({ ...d, assigneeId: undefined }, COLS, 2);
  if (d.recurrence !== undefined) { values.push(d.recurrence ? JSON.stringify(d.recurrence) : null); sets.push(`recurrence = $${values.length + 1}::jsonb`); }
  if (d.status !== undefined) sets.push(d.status === "done" ? "completed_at = coalesce(completed_at, now())" : "completed_at = null");
  // Done = its billable time goes to the items waiting for approval, in the same transaction (never twice: unique source index).
  let billed: string[] = [];
  // Undo: done back to not done removes the time items still waiting for approval (same transaction).
  const reopening = d.status !== undefined && d.status !== "done" && t.status === "done";
  let unbilled = 0;
  const db = await pool.connect();
  try {
    await db.query("begin");
    if (sets.length) await db.query(`update tasks set ${sets.join(", ")}, updated_at = now() where id = $1`, [id, ...values]);
    if (closing) billed = await billTimeEntries(db, { taskId: id });
    if (reopening) unbilled = await unbillTaskTime(db, id);
    await db.query("commit");
  } catch (e) { await db.query("rollback").catch(() => undefined); throw e; } finally { db.release(); }
  if (people) {
    await setAssignees(pool, id, people);
    await audit("task.assignees", { userId: auth(c).user.id, target: id, detail: { assigneeIds: people } });
  }
  if (d.viewerIds) {
    await pool.query("delete from task_viewers where task_id = $1", [id]);
    for (const v of d.viewerIds) await pool.query("insert into task_viewers values ($1, $2) on conflict do nothing", [id, v]);
  }

  if (billed.length) {
    await autoApproveClients(billed);
    await audit("task.time_billed", { userId: auth(c).user.id, target: id, detail: { clients: billed.length } });
  }

  if (unbilled) await audit("task.time_unbilled", { userId: auth(c).user.id, target: id, detail: { items: unbilled } });

  // Recurring task: completing it creates the next occurrence (checklist reset, same assignee).
  let next: string | null = null;
  const rec = (d.recurrence === undefined ? t.recurrence : d.recurrence) as { every: number; unit: "day" | "week" | "month" | "year"; until?: string | null } | null;
  if (closing && rec) {
    const base = (d.dueDate === undefined ? t.due_date : d.dueDate) ?? todayISO();
    const nextDue = addRecurrence(base, rec);
    if (!rec.until || nextDue <= rec.until) {
      const nextStart = t.start_date ? addRecurrence(t.start_date, rec) : null;
      const n = await pool.query(
        `insert into tasks (title, description, priority, assignee_id, created_by, client_id, start_date, due_date, estimate_minutes, visibility, parent_id, recurrence, tags)
         select title, description, priority, assignee_id, created_by, client_id, $2, $3, estimate_minutes, visibility, parent_id, recurrence, tags from tasks where id = $1 returning id`,
        [id, nextStart, nextDue],
      );
      next = n.rows[0].id as string;
      await pool.query("insert into task_assignees (task_id, user_id) select $2, user_id from task_assignees where task_id = $1 on conflict do nothing", [id, next]);
      await pool.query("insert into task_checklist (task_id, text, position) select $2, text, position from task_checklist where task_id = $1", [id, next]);
    }
  }
  return c.json({ ok: true, nextId: next });
});

taskRoutes.delete("/:id", requirePermission(...EDIT), async (c) => {
  const id = c.req.param("id");
  const t = await loadForEdit(c, id);
  if (!t) return c.json({ error: "not found" }, 404);
  if (t === "forbidden") return c.json({ error: "forbidden" }, 403);
  await pool.query("delete from tasks where id = $1", [id]);
  return c.json({ ok: true });
});

// ---- Checklist and notes ----
taskRoutes.post("/:id/checklist", requirePermission(...EDIT), async (c) => {
  const id = c.req.param("id");
  const t = await loadForEdit(c, id);
  if (!t || t === "forbidden") return c.json({ error: t ? "forbidden" : "not found" }, t ? 403 : 404);
  const { text } = await body(c, z.object({ text: z.string().min(1).max(300) }));
  const pos = (await pool.query("select coalesce(max(position), -1) + 1 as p from task_checklist where task_id = $1", [id])).rows[0].p;
  const r = await pool.query("insert into task_checklist (task_id, text, position) values ($1, $2, $3) returning id", [id, text, pos]);
  return c.json({ id: r.rows[0].id }, 201);
});

taskRoutes.patch("/checklist/:cid", requirePermission(...EDIT), async (c) => {
  const row = (await pool.query("select task_id from task_checklist where id = $1", [c.req.param("cid")])).rows[0];
  if (!row) return c.json({ error: "not found" }, 404);
  const t = await loadForEdit(c, row.task_id);
  if (!t || t === "forbidden") return c.json({ error: "forbidden" }, 403);
  const d = await body(c, z.object({ done: z.boolean().optional(), text: z.string().min(1).max(300).optional() }));
  const { sets, values } = buildUpdate(d, { done: "done", text: "text" }, 2);
  if (sets.length) await pool.query(`update task_checklist set ${sets.join(", ")} where id = $1`, [c.req.param("cid"), ...values]);
  return c.json({ ok: true });
});

taskRoutes.delete("/checklist/:cid", requirePermission(...EDIT), async (c) => {
  const row = (await pool.query("select task_id from task_checklist where id = $1", [c.req.param("cid")])).rows[0];
  if (!row) return c.json({ ok: true });
  const t = await loadForEdit(c, row.task_id);
  if (!t || t === "forbidden") return c.json({ error: "forbidden" }, 403);
  await pool.query("delete from task_checklist where id = $1", [c.req.param("cid")]);
  return c.json({ ok: true });
});

taskRoutes.post("/:id/notes", requirePermission(...VIEW), async (c) => {
  const id = c.req.param("id");
  if (!isUuid(id)) return c.json({ error: "not found" }, 404);
  const visible = await pool.query("select 1 from tasks t where t.id = $2 and " + VISIBLE, [auth(c).user.id, id]);
  if (!visible.rowCount) return c.json({ error: "not found" }, 404);
  const { body: text, audience } = await body(c, z.object({ body: z.string().min(1).max(5000), audience: z.enum(["internal", "client"]).default("internal") }));
  if (audience === "client" && !can(c, ...EDIT)) return c.json({ error: "forbidden" }, 403);
  await pool.query("insert into task_notes (task_id, user_id, body, audience) values ($1, $2, $3, $4)", [id, auth(c).user.id, text, audience]);
  if (audience === "client") await audit("task.note_to_client", { userId: auth(c).user.id, target: id });
  return c.json({ ok: true }, 201);
});

/** After a task is made from an e-mail: copy the chosen attachments and add a first note with the link to the original. The person's own mailbox only. */
taskRoutes.post("/:id/from-mail", requirePermission("mytools.mail.use"), requirePermission(...EDIT), async (c) => {
  const id = c.req.param("id");
  const me = auth(c).user.id;
  if (!isUuid(id)) return c.json({ error: "not found" }, 404);
  const t = (await pool.query(`select created_by, exists (select 1 from task_assignees ta where ta.task_id = tasks.id and ta.user_id = $1) as is_assignee from tasks where id = $2 and ${taskVisibleSql("$1", "tasks")}`, [me, id])).rows[0];
  if (!t) return c.json({ error: "not found" }, 404);
  if (!(isManager(c) || t.created_by === me || t.is_assignee)) return c.json({ error: "forbidden" }, 403);
  const d = await body(c, z.object({ messageId: z.string().regex(MAIL_ID), attachmentIds: z.array(z.string().regex(MAIL_ID)).max(20).default([]) }));
  try {
    const m = await mailForTask(me, d.messageId);
    const files = d.attachmentIds.length ? await copyAttachments(me, id, d.messageId, d.attachmentIds) : { stored: [], skipped: [] };
    const when = m.receivedAt ? m.receivedAt.slice(0, 10) : "";
    const note = `Créée à partir du courriel de ${m.from}${when ? ` du ${when}` : ""}${m.webLink ? `\nOuvrir le courriel dans Outlook : ${m.webLink}` : ""}${files.skipped.length ? `\nPièces jointes non copiées : ${files.skipped.length}` : ""}`;
    await pool.query("insert into task_notes (task_id, user_id, body, audience) values ($1, $2, $3, 'internal')", [id, me, note.slice(0, 5000)]);
    await audit("task.from_mail", { userId: me, target: id, detail: { files: files.stored.length, skipped: files.skipped.length } });
    return c.json({ ok: true, files: files.stored.length, skipped: files.skipped.length, webLink: m.webLink });
  } catch (e) {
    if (e instanceof ServiceError) return c.json({ error: e.code, detail: e.detail }, e.status as 400);
    throw e;
  }
});
