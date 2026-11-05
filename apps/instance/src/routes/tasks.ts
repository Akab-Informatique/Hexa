import { Hono } from "hono";
import { z } from "zod";
import { addRecurrence, todayISO, addDays, fridayOf, mondayOf } from "@nexo/shared/billing";
import { pool } from "../db.ts";
import { requirePermission, type Env } from "../auth/session.ts";
import { auth, body, buildUpdate, camel, camelRows, can, isUuid } from "./util.ts";

export const taskRoutes = new Hono<Env>();

// Tasks and the Pipeline share one task table, so either family of rights opens the API.
const VIEW = ["tasks.view", "command.pipeline.view"];
const EDIT = ["tasks.edit", "command.pipeline.edit", "tasks.manage", "command.pipeline.manage"];
const isManager = (c: Parameters<typeof can>[0]) => can(c, "tasks.manage", "command.pipeline.manage");

/** Reference rule: private tasks are hidden even from managers; "selected" only to chosen viewers. */
const VISIBLE = `(t.visibility = 'team' or t.created_by = $1 or t.assignee_id = $1
                  or (t.visibility = 'selected' and exists (select 1 from task_viewers v where v.task_id = t.id and v.user_id = $1)))`;

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable();
const TaskInput = z.object({
  title: z.string().min(1).max(300), description: z.string().max(20000).optional(),
  status: z.enum(["todo", "doing", "blocked", "done"]).optional(), priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  assigneeId: z.string().uuid().nullable().optional(), clientId: z.string().uuid().nullable().optional(),
  startDate: Day.optional(), dueDate: Day.optional(), estimateMinutes: z.number().int().min(0).max(100000).nullable().optional(),
  visibility: z.enum(["team", "private", "selected"]).optional(), parentId: z.string().uuid().nullable().optional(),
  waitsForId: z.string().uuid().nullable().optional(),
  recurrence: z.object({ every: z.number().int().min(1).max(365), unit: z.enum(["day", "week", "month", "year"]), until: Day.optional() }).nullable().optional(),
  tags: z.array(z.string().max(40)).max(20).optional(), viewerIds: z.array(z.string().uuid()).optional(),
  kind: z.enum(["normal", "continuous", "daily"]).optional(), startTime: z.string().regex(/^\d{1,2}:\d{2}$/).nullable().optional(), dueTime: z.string().regex(/^\d{1,2}:\d{2}$/).nullable().optional(),
  remindEveryDays: z.number().int().min(1).max(365).nullable().optional(),
});
const COLS: Record<string, string> = {
  title: "title", description: "description", status: "status", priority: "priority", assigneeId: "assignee_id", clientId: "client_id",
  startDate: "start_date", dueDate: "due_date", estimateMinutes: "estimate_minutes", visibility: "visibility", parentId: "parent_id",
  waitsForId: "waits_for_id", tags: "tags", kind: "kind", startTime: "start_time", dueTime: "due_time", remindEveryDays: "remind_every_days",
};

const SELECT = `select t.*, a.name as assignee_name, cl.name as client_name,
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
  if (assignee === "me") where.push(`t.assignee_id = ${arg(me)}`);
  else if (assignee === "none") where.push("t.assignee_id is null");
  else if (assignee && isUuid(assignee)) where.push(`t.assignee_id = ${arg(assignee)}`);
  if (q.status === "open") where.push("t.status <> 'done'");
  else if (q.status && ["todo", "doing", "blocked", "done"].includes(q.status)) where.push(`t.status = ${arg(q.status)}`);
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

  const r = await pool.query(
    `${SELECT} where ${where.join(" and ")}
      order by (t.status = 'done'), t.due_date nulls last, array_position(array['urgent','high','normal','low'], t.priority), t.created_at desc limit 500`,
    args,
  );
  return c.json(camelRows(r));
});

/** The Pipeline's "my day": everything that needs me today, in order of urgency. */
taskRoutes.get("/day", requirePermission(...VIEW), async (c) => {
  const me = auth(c).user.id;
  const today = todayISO();
  const r = await pool.query(
    `${SELECT} where ${VISIBLE} and t.assignee_id = $1 and t.status <> 'done' and (t.due_date <= $2 or t.status = 'doing')
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
  const r = await pool.query(
    `insert into tasks (title, description, status, priority, assignee_id, created_by, client_id, start_date, due_date, estimate_minutes, visibility, parent_id, waits_for_id, recurrence, tags)
     values ($1, coalesce($2,''), coalesce($3,'todo'), coalesce($4,'normal'), $5, $6, $7, $8, $9, $10, coalesce($11,'team'), $12, $13, $14::jsonb, coalesce($15::text[], '{}')) returning id`,
    [d.title, d.description, d.status, d.priority, d.assigneeId === undefined ? me : d.assigneeId, me, d.clientId ?? null, d.startDate ?? null, d.dueDate ?? null,
     d.estimateMinutes ?? null, d.visibility, d.parentId ?? null, d.waitsForId ?? null, d.recurrence ? JSON.stringify(d.recurrence) : null, d.tags],
  );
  const id = r.rows[0].id as string;
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
  const [checklist, notes, subtasks, viewers] = await Promise.all([
    pool.query("select * from task_checklist where task_id = $1 order by position, id", [id]),
    pool.query("select n.*, u.name as user_name from task_notes n left join users u on u.id = n.user_id where n.task_id = $1 order by n.created_at", [id]),
    pool.query("select id, title, status, assignee_id, due_date from tasks s where s.parent_id = $2 and (s.visibility = 'team' or s.created_by = $1 or s.assignee_id = $1) order by s.created_at", [auth(c).user.id, id]),
    pool.query("select u.id, u.name from task_viewers v join users u on u.id = v.user_id where v.task_id = $1", [id]),
  ]);
  return c.json({ ...camel(r.rows[0]), checklist: camelRows(checklist), notes: camelRows(notes), subtasks: camelRows(subtasks), viewers: viewers.rows });
});

async function loadForEdit(c: Parameters<typeof can>[0], id: string) {
  const r = await pool.query("select * from tasks t where t.id = $2 and " + VISIBLE, [auth(c).user.id, id]);
  const t = r.rows[0];
  if (!t) return null;
  const me = auth(c).user.id;
  // tasks.edit = my own tasks (created or assigned); tasks.manage = anyone's.
  return isManager(c) || t.created_by === me || t.assignee_id === me ? t : "forbidden";
}

taskRoutes.patch("/:id", requirePermission(...EDIT), async (c) => {
  const id = c.req.param("id");
  const t = await loadForEdit(c, id);
  if (!t) return c.json({ error: "not found" }, 404);
  if (t === "forbidden") return c.json({ error: "forbidden" }, 403);
  const d = await body(c, TaskInput.partial());
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

  const { sets, values } = buildUpdate(d, COLS, 2);
  if (d.recurrence !== undefined) { values.push(d.recurrence ? JSON.stringify(d.recurrence) : null); sets.push(`recurrence = $${values.length + 1}::jsonb`); }
  if (d.status !== undefined) sets.push(d.status === "done" ? "completed_at = coalesce(completed_at, now())" : "completed_at = null");
  if (sets.length) await pool.query(`update tasks set ${sets.join(", ")}, updated_at = now() where id = $1`, [id, ...values]);
  if (d.viewerIds) {
    await pool.query("delete from task_viewers where task_id = $1", [id]);
    for (const v of d.viewerIds) await pool.query("insert into task_viewers values ($1, $2) on conflict do nothing", [id, v]);
  }

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
  const visible = await pool.query("select 1 from tasks t where t.id = $2 and " + VISIBLE, [auth(c).user.id, id]);
  if (!visible.rowCount) return c.json({ error: "not found" }, 404);
  const { body: text } = await body(c, z.object({ body: z.string().min(1).max(5000) }));
  await pool.query("insert into task_notes (task_id, user_id, body) values ($1, $2, $3)", [id, auth(c).user.id, text]);
  return c.json({ ok: true }, 201);
});
