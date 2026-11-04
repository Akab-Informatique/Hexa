import { Hono } from "hono";
import { z } from "zod";
import { addDays, mondayOf, todayISO } from "@nexo/shared/billing";
import { pool } from "../db.ts";
import { requirePermission, type Env } from "../auth/session.ts";
import { auth, body, camel, camelRows, can, isUuid } from "./util.ts";

export const teamRoutes = new Hono<Env>();

// =============================== Dashboards ===============================
// Model (from the reference, plus the lock): a dashboard has an owner, optional sharing with the team
// or chosen people (view / edit), and an admin lock. One shared record: edits reflect for everyone.
// Locked = only holders of team.dashboard.lock may change it; everyone else can copy it to make their own.

const WidgetSchema = z.object({ id: z.string().min(1).max(40), type: z.string().min(1).max(40), size: z.number().int().min(1).max(3) });
const DEFAULT_LAYOUT = [
  { id: "w1", type: "welcome", size: 2 }, { id: "w2", type: "my-tasks", size: 2 }, { id: "w3", type: "week-status", size: 1 },
  { id: "w4", type: "meeting-points", size: 1 }, { id: "w5", type: "quick-links", size: 1 },
];

interface Row { id: string; name: string; owner_id: string; visibility: string; team_access: string; locked: boolean; layout: unknown; owner_name?: string; member_access?: string | null }

function access(c: Parameters<typeof can>[0], r: Row) {
  const me = auth(c).user.id;
  const lockHolder = can(c, "team.dashboard.lock");
  const owner = r.owner_id === me;
  const editRight = owner || r.member_access === "edit" || (r.visibility === "team" && r.team_access === "edit");
  return {
    isOwner: owner,
    canEdit: (can(c, "team.dashboard.edit") && editRight && !r.locked) || lockHolder,
    canShare: (owner && can(c, "team.dashboard.share")) || lockHolder,
    canLock: lockHolder,
  };
}

const LIST = `select d.*, u.name as owner_name, m.access as member_access,
                (select coalesce(json_agg(json_build_object('userId', dm.user_id, 'name', mu.name, 'access', dm.access)), '[]')
                   from dashboard_members dm join users mu on mu.id = dm.user_id where dm.dashboard_id = d.id) as members
           from dashboards d join users u on u.id = d.owner_id
           left join dashboard_members m on m.dashboard_id = d.id and m.user_id = $1
          where (d.owner_id = $1 or m.user_id is not null or d.visibility = 'team')`;

teamRoutes.get("/dashboards", requirePermission("team.dashboard.view"), async (c) => {
  let r = await pool.query(`${LIST} order by d.owner_id = $1 desc, lower(d.name)`, [auth(c).user.id]);
  if (!r.rows.some((x) => x.owner_id === auth(c).user.id)) {
    // First visit: everyone gets a personal starter dashboard they can customize.
    await pool.query("insert into dashboards (name, owner_id, layout) values ($1, $2, $3::jsonb)", ["Mon tableau de bord", auth(c).user.id, JSON.stringify(DEFAULT_LAYOUT)]);
    r = await pool.query(`${LIST} order by d.owner_id = $1 desc, lower(d.name)`, [auth(c).user.id]);
  }
  return c.json(r.rows.map((x) => ({ ...camel(x), ...access(c, x as Row) })));
});

teamRoutes.post("/dashboards", requirePermission("team.dashboard.edit"), async (c) => {
  const d = await body(c, z.object({ name: z.string().min(1).max(80), layout: z.array(WidgetSchema).max(40).optional() }));
  const r = await pool.query("insert into dashboards (name, owner_id, layout) values ($1, $2, $3::jsonb) returning id", [d.name, auth(c).user.id, JSON.stringify(d.layout ?? DEFAULT_LAYOUT)]);
  return c.json({ id: r.rows[0].id }, 201);
});

async function loadDashboard(c: Parameters<typeof can>[0], id: string): Promise<Row | null> {
  if (!isUuid(id)) return null;
  const r = await pool.query(`${LIST} and d.id = $2`, [auth(c).user.id, id]);
  return (r.rows[0] as Row) ?? null;
}

teamRoutes.patch("/dashboards/:id", requirePermission("team.dashboard.view"), async (c) => {
  const id = c.req.param("id");
  const row = await loadDashboard(c, id);
  if (!row) return c.json({ error: "not found" }, 404);
  const a = access(c, row);
  const d = await body(c, z.object({
    name: z.string().min(1).max(80).optional(), layout: z.array(WidgetSchema).max(40).optional(),
    visibility: z.enum(["private", "team"]).optional(), teamAccess: z.enum(["view", "edit"]).optional(),
    locked: z.boolean().optional(), members: z.array(z.object({ userId: z.string().uuid(), access: z.enum(["view", "edit"]) })).optional(),
  }));
  if ((d.name !== undefined || d.layout !== undefined) && !a.canEdit) return c.json({ error: row.locked ? "this dashboard is locked" : "forbidden" }, 403);
  if ((d.visibility !== undefined || d.teamAccess !== undefined || d.members !== undefined) && !a.canShare) return c.json({ error: "forbidden" }, 403);
  if (d.locked !== undefined && !a.canLock) return c.json({ error: "forbidden" }, 403);

  await pool.query(
    `update dashboards set name = coalesce($2, name), layout = coalesce($3::jsonb, layout), visibility = coalesce($4, visibility),
            team_access = coalesce($5, team_access), locked = coalesce($6, locked), updated_at = now() where id = $1`,
    [id, d.name ?? null, d.layout ? JSON.stringify(d.layout) : null, d.visibility ?? null, d.teamAccess ?? null, d.locked ?? null],
  );
  if (d.members) {
    await pool.query("delete from dashboard_members where dashboard_id = $1", [id]);
    for (const m of d.members) if (m.userId !== row.owner_id) await pool.query("insert into dashboard_members values ($1, $2, $3)", [id, m.userId, m.access]);
  }
  return c.json({ ok: true });
});

/** "Copy to mine": the way to personalize a locked or view-only shared dashboard. */
teamRoutes.post("/dashboards/:id/copy", requirePermission("team.dashboard.edit"), async (c) => {
  const row = await loadDashboard(c, c.req.param("id"));
  if (!row) return c.json({ error: "not found" }, 404);
  const r = await pool.query("insert into dashboards (name, owner_id, layout) values ($1, $2, $3::jsonb) returning id", [`${row.name} (copie)`, auth(c).user.id, JSON.stringify(row.layout)]);
  return c.json({ id: r.rows[0].id }, 201);
});

teamRoutes.delete("/dashboards/:id", requirePermission("team.dashboard.edit"), async (c) => {
  const row = await loadDashboard(c, c.req.param("id"));
  if (!row) return c.json({ error: "not found" }, 404);
  if (!(row.owner_id === auth(c).user.id && !row.locked) && !can(c, "team.dashboard.lock")) return c.json({ error: "forbidden" }, 403);
  await pool.query("delete from dashboards where id = $1", [row.id]);
  return c.json({ ok: true });
});

// =============================== Weekly meeting ===============================
const Monday = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

teamRoutes.get("/meeting", requirePermission("team.meeting.view"), async (c) => {
  const week = mondayOf(c.req.query("week") && Monday.safeParse(c.req.query("week")).success ? c.req.query("week")! : todayISO());
  const weekEnd = addDays(week, 6);
  const me = auth(c).user.id;
  const VIS = `(t.visibility = 'team' or t.created_by = $1 or t.assignee_id = $1)`;

  const [points, hot, absences, stats, review] = await Promise.all([
    pool.query("select p.*, u.name as author_name from meeting_points p left join users u on u.id = p.author_id where p.week_start = $1 order by p.done, p.created_at", [week]),
    // "Hot tasks": urgent/high priority tasks open or due this week.
    pool.query(
      `select t.id, t.title, t.status, t.priority, t.due_date, a.name as assignee_name from tasks t left join users a on a.id = t.assignee_id
        where ${VIS} and t.priority in ('urgent','high') and (t.status <> 'done' or t.completed_at::date between $2 and $3)
          and (t.due_date is null or t.due_date <= $3) order by t.status = 'done', t.due_date nulls last limit 30`, [me, week, weekEnd]),
    pool.query("select a.*, u.name as user_name from absences a join users u on u.id = a.user_id where a.starts_on <= $2 and a.ends_on >= $1 order by a.starts_on", [week, weekEnd]),
    pool.query(
      `select count(*) filter (where t.status <> 'done' and t.due_date < $2)::int as overdue,
              count(*) filter (where t.status <> 'done' and t.due_date between $2 and $3)::int as due_this_week,
              count(*) filter (where t.status <> 'done' and t.assignee_id is null)::int as unassigned,
              count(*) filter (where t.status = 'blocked')::int as blocked
         from tasks t where ${VIS}`, [me, week, weekEnd]),
    // Review: for each of the 4 weeks before, tasks opened vs closed, plus what is still open from those weeks.
    Promise.all([1, 2, 3, 4].map(async (i) => {
      const s = addDays(week, -7 * i), e = addDays(s, 6);
      const r = await pool.query(
        `select count(*) filter (where t.created_at::date between $2 and $3)::int as opened,
                count(*) filter (where t.completed_at::date between $2 and $3)::int as closed
           from tasks t where ${VIS}`, [me, s, e]);
      const stillOpen = await pool.query(
        `select t.id, t.title, t.priority, t.due_date, a.name as assignee_name from tasks t left join users a on a.id = t.assignee_id
          where ${VIS} and t.status <> 'done' and t.due_date between $2 and $3 order by t.due_date limit 15`, [me, s, e]);
      return { weekStart: s, ...r.rows[0], stillOpen: camelRows(stillOpen) };
    })),
  ]);
  return c.json({ week, weekEnd, points: camelRows(points), hot: camelRows(hot), absences: camelRows(absences), stats: stats.rows[0], review });
});

const PointInput = z.object({ weekStart: Monday, kind: z.enum(["point", "hot", "issue"]).default("point"), title: z.string().min(1).max(300), body: z.string().max(5000).optional() });

teamRoutes.post("/meeting/points", requirePermission("team.meeting.edit", "team.meeting.manage"), async (c) => {
  const d = await body(c, PointInput);
  const r = await pool.query("insert into meeting_points (week_start, kind, title, body, author_id) values ($1, $2, $3, coalesce($4,''), $5) returning id", [mondayOf(d.weekStart), d.kind, d.title, d.body, auth(c).user.id]);
  return c.json({ id: r.rows[0].id }, 201);
});

teamRoutes.patch("/meeting/points/:id", requirePermission("team.meeting.edit", "team.meeting.manage"), async (c) => {
  const row = (await pool.query("select author_id from meeting_points where id = $1", [c.req.param("id")])).rows[0];
  if (!row) return c.json({ error: "not found" }, 404);
  const d = await body(c, z.object({ done: z.boolean().optional(), title: z.string().min(1).max(300).optional(), body: z.string().max(5000).optional() }));
  // Anyone in the meeting can tick a point off; only the author or a manager rewrites it.
  if ((d.title !== undefined || d.body !== undefined) && row.author_id !== auth(c).user.id && !can(c, "team.meeting.manage")) return c.json({ error: "forbidden" }, 403);
  await pool.query(
    `update meeting_points set title = coalesce($2, title), body = coalesce($3, body), done = coalesce($4, done),
            done_at = case when $4 is true then now() when $4 is false then null else done_at end where id = $1`,
    [c.req.param("id"), d.title ?? null, d.body ?? null, d.done ?? null],
  );
  return c.json({ ok: true });
});

teamRoutes.delete("/meeting/points/:id", requirePermission("team.meeting.edit", "team.meeting.manage"), async (c) => {
  const row = (await pool.query("select author_id from meeting_points where id = $1", [c.req.param("id")])).rows[0];
  if (!row) return c.json({ ok: true });
  if (row.author_id !== auth(c).user.id && !can(c, "team.meeting.manage")) return c.json({ error: "forbidden" }, 403);
  await pool.query("delete from meeting_points where id = $1", [c.req.param("id")]);
  return c.json({ ok: true });
});
