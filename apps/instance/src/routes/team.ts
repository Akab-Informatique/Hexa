import { Hono } from "hono";
import { z } from "zod";
import { addDays, mondayOf, todayISO } from "@hexa/shared/billing";
import { pool } from "../db.ts";
import { audit } from "../auth/access.ts";
import { requirePermission, type Env } from "../auth/session.ts";
import { auth, body, camel, camelRows, can, isUuid } from "./util.ts";

export const teamRoutes = new Hono<Env>();

// =============================== Dashboards ===============================
// Model (from the reference): several dashboards per person; built-in ones (undeletable); a dashboard can be shared
// with the team or chosen people (view / edit) and locked by an admin. A shared dashboard is ONE record, but anyone
// who may view it can arrange it "just for me" (a personal layout over the shared one, with "back to default").
// A person can also pick which dashboard opens first (their default).

const WidgetSchema = z.object({ id: z.string().min(1).max(40), type: z.string().min(1).max(40), size: z.number().int().min(1).max(3) });
const DEFAULT_LAYOUT = [
  { id: "w1", type: "welcome", size: 2 }, { id: "w2", type: "my-tasks", size: 2 }, { id: "w3", type: "week-status", size: 1 },
  { id: "w4", type: "meeting-points", size: 1 }, { id: "w5", type: "quick-links", size: 1 },
];
const TEAM_LAYOUT = [
  { id: "t1", type: "clock", size: 1 }, { id: "t2", type: "week-status", size: 1 }, { id: "t3", type: "tasks-by-person", size: 1 },
  { id: "t4", type: "upcoming-deadlines", size: 2 }, { id: "t5", type: "overdue-tasks", size: 1 }, { id: "t6", type: "board-latest", size: 2 }, { id: "t7", type: "meeting-points", size: 1 },
];

interface Row { id: string; name: string; owner_id: string; visibility: string; team_access: string; locked: boolean; layout: unknown; builtin: boolean; slug: string | null; owner_name?: string; member_access?: string | null; my_layout?: unknown; is_default?: boolean }

function access(c: Parameters<typeof can>[0], r: Row) {
  const me = auth(c).user.id;
  const lockHolder = can(c, "team.dashboard.lock");
  const manager = can(c, "team.dashboard.manage");
  const owner = r.owner_id === me;
  const editRight = owner || r.member_access === "edit" || (r.visibility === "team" && r.team_access === "edit");
  const shared = r.visibility === "team" || r.builtin;
  return {
    isOwner: owner, shared,
    canEdit: (can(c, "team.dashboard.edit") && editRight && !r.locked) || lockHolder || manager,
    canShare: (owner && can(c, "team.dashboard.share")) || lockHolder || manager,
    canLock: lockHolder || manager,
    // Anyone who sees a dashboard and may customize can arrange their own copy of the layout.
    canCustomize: can(c, "team.dashboard.edit"),
    canDelete: !r.builtin && ((owner && !r.locked && can(c, "team.dashboard.edit")) || manager || lockHolder),
  };
}

const LIST = `select d.*, u.name as owner_name, m.access as member_access, l.layout as my_layout, (df.dashboard_id is not null) as is_default,
                (select coalesce(json_agg(json_build_object('userId', dm.user_id, 'name', mu.name, 'access', dm.access)), '[]')
                   from dashboard_members dm join users mu on mu.id = dm.user_id where dm.dashboard_id = d.id) as members
           from dashboards d join users u on u.id = d.owner_id
           left join dashboard_members m on m.dashboard_id = d.id and m.user_id = $1
           left join dashboard_layouts l on l.dashboard_id = d.id and l.user_id = $1
           left join dashboard_defaults df on df.dashboard_id = d.id and df.user_id = $1
          where (d.owner_id = $1 or m.user_id is not null or d.visibility = 'team')`;

async function ensureBuiltins(userId: string) {
  const has = (await pool.query("select 1 from dashboards where slug = 'team'")).rowCount;
  if (!has) {
    const owner = (await pool.query("select id from users where kind = 'staff' and is_master order by created_at limit 1")).rows[0]?.id ?? userId;
    await pool.query("insert into dashboards (name, owner_id, visibility, team_access, slug, builtin, layout) values ('Tableau de l''équipe', $1, 'team', 'view', 'team', true, $2::jsonb) on conflict do nothing", [owner, JSON.stringify(TEAM_LAYOUT)]);
  }
}

const shapeRow = (c: Parameters<typeof can>[0], x: Row) => {
  const { my_layout: _m, ...rest } = x as Row & { my_layout?: unknown };
  void _m;
  return { ...camel(rest as unknown as Record<string, unknown>), layout: x.my_layout ?? x.layout, sharedLayout: x.layout, hasPersonalLayout: Boolean(x.my_layout), ...access(c, x) };
};

teamRoutes.get("/dashboards", requirePermission("team.dashboard.view"), async (c) => {
  const me = auth(c).user.id;
  await ensureBuiltins(me);
  let r = await pool.query(`${LIST} order by is_default desc, d.builtin desc, d.owner_id = $1 desc, lower(d.name)`, [me]);
  if (!r.rows.some((x) => x.owner_id === me && !x.builtin)) {
    // First visit: everyone gets a personal starter dashboard they can customize.
    await pool.query("insert into dashboards (name, owner_id, layout) values ($1, $2, $3::jsonb)", ["Mon tableau de bord", me, JSON.stringify(DEFAULT_LAYOUT)]);
    r = await pool.query(`${LIST} order by is_default desc, d.builtin desc, d.owner_id = $1 desc, lower(d.name)`, [me]);
  }
  return c.json(r.rows.map((x) => shapeRow(c, x as Row)));
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

/** The person's default dashboard (the one that opens first). */
teamRoutes.put("/dashboards/default", requirePermission("team.dashboard.view"), async (c) => {
  const d = await body(c, z.object({ dashboardId: z.string().uuid().nullable() }));
  if (d.dashboardId === null) { await pool.query("delete from dashboard_defaults where user_id = $1", [auth(c).user.id]); return c.json({ ok: true }); }
  if (!(await loadDashboard(c, d.dashboardId))) return c.json({ error: "not found" }, 404);
  await pool.query("insert into dashboard_defaults (user_id, dashboard_id) values ($1,$2) on conflict (user_id) do update set dashboard_id = excluded.dashboard_id", [auth(c).user.id, d.dashboardId]);
  return c.json({ ok: true });
});

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
  if (row.builtin && d.visibility !== undefined && d.visibility !== "team") return c.json({ error: "builtin_always_shared" }, 409);
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
  await audit("dashboard.updated", { userId: auth(c).user.id, target: row.name, detail: Object.keys(d) });
  return c.json({ ok: true });
});

/** "Just for me": arranges a dashboard for the person only; the shared layout is untouched. */
teamRoutes.put("/dashboards/:id/my-layout", requirePermission("team.dashboard.edit"), async (c) => {
  const row = await loadDashboard(c, c.req.param("id"));
  if (!row) return c.json({ error: "not found" }, 404);
  const d = await body(c, z.object({ layout: z.array(WidgetSchema).max(40) }));
  await pool.query("insert into dashboard_layouts (dashboard_id, user_id, layout) values ($1,$2,$3::jsonb) on conflict (dashboard_id, user_id) do update set layout = excluded.layout, updated_at = now()", [row.id, auth(c).user.id, JSON.stringify(d.layout)]);
  return c.json({ ok: true });
});

/** Back to the shared layout. */
teamRoutes.delete("/dashboards/:id/my-layout", requirePermission("team.dashboard.view"), async (c) => {
  await pool.query("delete from dashboard_layouts where dashboard_id::text = $1 and user_id = $2", [c.req.param("id"), auth(c).user.id]);
  return c.json({ ok: true });
});

/** "Copy to mine": the way to get a free-standing dashboard out of a locked or view-only shared one. */
teamRoutes.post("/dashboards/:id/copy", requirePermission("team.dashboard.edit"), async (c) => {
  const row = await loadDashboard(c, c.req.param("id"));
  if (!row) return c.json({ error: "not found" }, 404);
  const r = await pool.query("insert into dashboards (name, owner_id, layout) values ($1, $2, $3::jsonb) returning id", [`${row.name} (copie)`, auth(c).user.id, JSON.stringify(row.my_layout ?? row.layout)]);
  return c.json({ id: r.rows[0].id }, 201);
});

teamRoutes.delete("/dashboards/:id", requirePermission("team.dashboard.edit"), async (c) => {
  const row = await loadDashboard(c, c.req.param("id"));
  if (!row) return c.json({ error: "not found" }, 404);
  if (row.builtin) return c.json({ error: "builtin_cannot_be_deleted" }, 409);
  if (!access(c, row).canDelete) return c.json({ error: "forbidden" }, 403);
  await pool.query("delete from dashboards where id = $1", [row.id]);
  await audit("dashboard.deleted", { userId: auth(c).user.id, target: row.name });
  return c.json({ ok: true });
});

// The weekly meeting lives in routes/meeting.ts.
