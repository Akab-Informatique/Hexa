import { Hono } from "hono";
import { z } from "zod";
import { isKnownPermission, MODULES, permissionsFor, ungrantable } from "@nexo/shared/permissions";
import { pool } from "../db.ts";
import { audit, rightsOf } from "../auth/access.ts";
import { hashPassword, temporaryPassword } from "../auth/crypto.ts";
import { clientIp, requirePermission, type Env } from "../auth/session.ts";
import * as license from "../license.ts";
import { loadedModules } from "../modules.ts";
import { config } from "../config.ts";

export const adminRoutes = new Hono<Env>();

const Perm = z.string().refine(isKnownPermission, "unknown permission");
const uniq = <T>(a: T[]) => [...new Set(a)];

adminRoutes.get("/catalog", requirePermission("admin.users.view", "admin.groups.manage"), (c) => c.json(MODULES));

// ------------------------------- Users -------------------------------
adminRoutes.get("/users", requirePermission("admin.users.view"), async (c) => {
  const r = await pool.query(
    `select u.id, u.email, u.name, u.kind, u.active, u.is_master, u.locale, u.totp_enabled, u.last_login_at, u.created_at,
            coalesce(json_agg(ug.group_id) filter (where ug.group_id is not null), '[]') as group_ids
       from users u left join user_groups ug on ug.user_id = u.id
      where u.kind = 'staff' group by u.id order by lower(u.name)`,
  );
  return c.json(r.rows.map((u) => ({ ...u, groupIds: u.group_ids, group_ids: undefined })));
});

adminRoutes.get("/users/:id", requirePermission("admin.users.view"), async (c) => {
  const id = c.req.param("id");
  const u = (await pool.query("select id, email, name, kind, active, is_master, locale, totp_enabled from users where id = $1", [id])).rows[0];
  if (!u) return c.json({ error: "not found" }, 404);
  const [groups, overrides, rights] = await Promise.all([
    pool.query("select group_id from user_groups where user_id = $1", [id]),
    pool.query("select permission, effect from user_permissions where user_id = $1", [id]),
    rightsOf({ id, kind: u.kind, is_master: u.is_master }),
  ]);
  return c.json({ ...u, groupIds: groups.rows.map((g) => g.group_id), overrides: overrides.rows, rights });
});

const UserInput = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(120),
  groupIds: z.array(z.string().uuid()).default([]),
});

adminRoutes.post("/users", requirePermission("admin.users.manage"), async (c) => {
  const a = c.get("auth")!;
  const body = UserInput.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: body.error.flatten() }, 400);
  const bad = await groupEscalation(a, body.data.groupIds);
  if (bad.length) return c.json({ error: "cannot grant rights you do not hold", rights: bad }, 403);
  const temp = temporaryPassword();
  try {
    const r = await pool.query(
      `insert into users (kind, email, name, password_hash, must_change_password) values ('staff', $1, $2, $3, true) returning id`,
      [body.data.email, body.data.name, await hashPassword(temp)],
    );
    const id = r.rows[0].id as string;
    for (const g of body.data.groupIds) await pool.query("insert into user_groups values ($1, $2) on conflict do nothing", [id, g]);
    await audit("user.created", { userId: a.user.id, target: body.data.email, ip: clientIp(c) });
    // Shown once. Email delivery arrives with the Mailjet integration.
    return c.json({ id, temporaryPassword: temp }, 201);
  } catch (err) {
    if ((err as { code?: string }).code === "23505") return c.json({ error: "email already used" }, 409);
    throw err;
  }
});

const UserPatch = z.object({
  name: z.string().min(1).max(120).optional(),
  active: z.boolean().optional(),
  groupIds: z.array(z.string().uuid()).optional(),
  overrides: z.array(z.object({ permission: Perm, effect: z.enum(["allow", "deny"]) })).optional(),
});

adminRoutes.patch("/users/:id", requirePermission("admin.users.manage"), async (c) => {
  const a = c.get("auth")!;
  const id = c.req.param("id");
  const body = UserPatch.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: body.error.flatten() }, 400);
  const target = (await pool.query("select id, is_master from users where id = $1", [id])).rows[0];
  if (!target) return c.json({ error: "not found" }, 404);
  if (target.is_master && !a.user.isMaster) return c.json({ error: "only a master user can change a master user" }, 403);
  if (id === a.user.id && body.data.active === false) return c.json({ error: "you cannot deactivate yourself" }, 400);

  const d = body.data;
  const escalation = [
    ...(d.groupIds ? await groupEscalation(a, d.groupIds) : []),
    ...ungrantable(a.rights, a.user.isMaster, (d.overrides ?? []).filter((o) => o.effect === "allow").map((o) => o.permission)),
  ];
  if (escalation.length) return c.json({ error: "cannot grant rights you do not hold", rights: uniq(escalation) }, 403);

  if (d.name !== undefined) await pool.query("update users set name = $2 where id = $1", [id, d.name]);
  if (d.active !== undefined) {
    await pool.query("update users set active = $2 where id = $1", [id, d.active]);
    if (!d.active) await pool.query("delete from sessions where user_id = $1", [id]);
  }
  if (d.groupIds) {
    await pool.query("delete from user_groups where user_id = $1", [id]);
    for (const g of d.groupIds) await pool.query("insert into user_groups values ($1, $2)", [id, g]);
  }
  if (d.overrides) {
    await pool.query("delete from user_permissions where user_id = $1", [id]);
    for (const o of d.overrides) await pool.query("insert into user_permissions values ($1, $2, $3)", [id, o.permission, o.effect]);
  }
  await audit("user.updated", { userId: a.user.id, target: id, detail: Object.keys(d), ip: clientIp(c) });
  return c.json({ ok: true });
});

adminRoutes.post("/users/:id/reset-password", requirePermission("admin.users.manage"), async (c) => {
  const a = c.get("auth")!;
  const id = c.req.param("id");
  const target = (await pool.query("select is_master from users where id = $1", [id])).rows[0];
  if (!target) return c.json({ error: "not found" }, 404);
  if (target.is_master && !a.user.isMaster) return c.json({ error: "only a master user can reset a master user" }, 403);
  const temp = temporaryPassword();
  await pool.query("update users set password_hash = $2, must_change_password = true, failed_logins = 0, locked_until = null where id = $1", [id, await hashPassword(temp)]);
  await pool.query("delete from sessions where user_id = $1", [id]);
  await audit("user.password_reset", { userId: a.user.id, target: id, ip: clientIp(c) });
  return c.json({ temporaryPassword: temp });
});

/** Rights granted through groups the acting admin is about to assign but does not hold themselves. */
async function groupEscalation(a: { rights: string[]; user: { isMaster: boolean } }, groupIds: string[]): Promise<string[]> {
  if (!groupIds.length || a.user.isMaster) return [];
  const r = await pool.query("select permissions from groups where id = any($1::uuid[])", [groupIds]);
  return uniq(ungrantable(a.rights, false, r.rows.flatMap((g) => g.permissions as string[])));
}

// ------------------------------- Groups -------------------------------
adminRoutes.get("/groups", requirePermission("admin.users.view", "admin.groups.manage"), async (c) => {
  const r = await pool.query(
    `select g.id, g.slug, g.name, g.description, g.permissions, g.is_system, g.locked,
            (select count(*)::int from user_groups ug where ug.group_id = g.id) as members
       from groups g where g.audience = 'staff' order by g.is_system desc, lower(g.name)`,
  );
  return c.json(r.rows.map((g) => ({ ...g, isSystem: g.is_system, is_system: undefined })));
});

const GroupInput = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(300).default(""),
  permissions: z.array(Perm).default([]),
});

adminRoutes.post("/groups", requirePermission("admin.groups.manage"), async (c) => {
  const a = c.get("auth")!;
  const body = GroupInput.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: body.error.flatten() }, 400);
  const bad = ungrantable(a.rights, a.user.isMaster, body.data.permissions);
  if (bad.length) return c.json({ error: "cannot grant rights you do not hold", rights: bad }, 403);
  const slug = `${body.data.name.toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${Math.random().toString(36).slice(2, 6)}`;
  const r = await pool.query(
    "insert into groups (slug, name, description, permissions) values ($1, $2, $3, $4::jsonb) returning id",
    [slug, body.data.name, body.data.description, JSON.stringify(uniq(body.data.permissions))],
  );
  await audit("group.created", { userId: a.user.id, target: body.data.name, ip: clientIp(c) });
  return c.json({ id: r.rows[0].id }, 201);
});

adminRoutes.patch("/groups/:id", requirePermission("admin.groups.manage"), async (c) => {
  const a = c.get("auth")!;
  const id = c.req.param("id");
  const body = GroupInput.partial().safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: body.error.flatten() }, 400);
  const g = (await pool.query("select locked, permissions from groups where id = $1", [id])).rows[0];
  if (!g) return c.json({ error: "not found" }, 404);
  if (g.locked) return c.json({ error: "this group is locked" }, 403);
  if (body.data.permissions) {
    // You may only add rights you hold; removing rights you lack is allowed (it only reduces access).
    const added = body.data.permissions.filter((k) => !(g.permissions as string[]).includes(k));
    const bad = ungrantable(a.rights, a.user.isMaster, added);
    if (bad.length) return c.json({ error: "cannot grant rights you do not hold", rights: bad }, 403);
  }
  await pool.query(
    `update groups set name = coalesce($2, name), description = coalesce($3, description),
            permissions = coalesce($4::jsonb, permissions) where id = $1`,
    [id, body.data.name ?? null, body.data.description ?? null, body.data.permissions ? JSON.stringify(uniq(body.data.permissions)) : null],
  );
  await audit("group.updated", { userId: a.user.id, target: id, ip: clientIp(c) });
  return c.json({ ok: true });
});

adminRoutes.delete("/groups/:id", requirePermission("admin.groups.manage"), async (c) => {
  const id = c.req.param("id");
  const g = (await pool.query("select locked, is_system from groups where id = $1", [id])).rows[0];
  if (!g) return c.json({ error: "not found" }, 404);
  if (g.locked || g.is_system) return c.json({ error: "system groups cannot be deleted" }, 403);
  await pool.query("delete from groups where id = $1", [id]);
  await audit("group.deleted", { userId: c.get("auth")!.user.id, target: id });
  return c.json({ ok: true });
});

// -------------------- Read-only info and audit log --------------------
adminRoutes.get("/tenant", requirePermission("admin.branding.view"), (c) => {
  const lic = license.current();
  return c.json({
    version: config.version, plan: lic.plan, maxUsers: lic.maxUsers, branding: lic.branding,
    enabledModules: lic.modules, loadedModules, license: license.status(), allStaffRights: permissionsFor("staff").length,
  });
});

adminRoutes.get("/audit", requirePermission("admin.audit.view"), async (c) => {
  const r = await pool.query(
    `select a.id, a.at, a.action, a.target, a.detail, a.ip, u.name as user_name
       from audit_log a left join users u on u.id = a.user_id order by a.id desc limit 200`,
  );
  return c.json(r.rows);
});
