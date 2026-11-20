import { Hono } from "hono";
import { z } from "zod";
import { effectivePermissions, isKnownPermission, MODULES, RETIRED_PERMISSIONS, permissionsFor, ungrantable, type Audience } from "@hexa/shared/permissions";
import { isSafeIconUrl } from "@hexa/shared";
import { getSetting, pool, setSetting } from "../db.ts";
import { audit, rightsOf } from "../auth/access.ts";
import { hashPassword, MIN_PASSWORD, randomToken, sha256, temporaryPassword } from "../auth/crypto.ts";
import { clientIp, requirePermission, type Env } from "../auth/session.ts";
import * as license from "../license.ts";
import { loadedModules } from "../modules.ts";
import { config } from "../config.ts";
import { mailReady, resetMail, sendMail } from "../lib/mail.ts";
import { colorsFromCss, dedupeColors, extractBrand, normalizeColor, rankFavicons, safeGet, SiteError, sniffIcon, sniffImage, type ColorHit } from "../lib/siteBrand.ts";

export const adminRoutes = new Hono<Env>();

const Perm = z.string().refine(isKnownPermission, "unknown permission");
const uniq = <T>(a: T[]) => [...new Set(a)];

adminRoutes.get("/catalog", requirePermission("admin.users.view", "admin.groups.manage"), (c) => c.json(MODULES.map((m) => ({ ...m, permissions: m.permissions.filter((p) => !RETIRED_PERMISSIONS.has(p.key)) }))));

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
  const u = (await pool.query("select id, email, name, kind, active, is_master, locale, totp_enabled, phone from users where id = $1", [id])).rows[0];
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
  groupIds: z.array(z.string().uuid()).max(100).default([]),
  overrides: z.array(z.object({ permission: Perm, effect: z.enum(["allow", "deny"]) })).max(500).default([]),
});

adminRoutes.post("/users", requirePermission("admin.users.manage"), async (c) => {
  const a = c.get("auth")!;
  const body = UserInput.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: body.error.flatten() }, 400);
  const d = body.data;
  const staffKeys = new Set(permissionsFor("staff"));
  if (d.overrides.some((o) => !staffKeys.has(o.permission))) return c.json({ error: "unknown permission" }, 400);
  if (d.groupIds.length && (await pool.query("select id from groups where id = any($1::uuid[])", [d.groupIds])).rowCount !== uniq(d.groupIds).length)
    return c.json({ error: "unknown group" }, 400);
  // Same rule as update: a non-master admin only hands out rights they hold (groups and per-user allows).
  const bad = uniq([
    ...(await groupEscalation(a, d.groupIds)),
    ...ungrantable(a.rights, a.user.isMaster, d.overrides.filter((o) => o.effect === "allow").map((o) => o.permission)),
  ]);
  if (bad.length) return c.json({ error: "cannot grant rights you do not hold", rights: bad }, 403);
  const temp = temporaryPassword();
  const hash = await hashPassword(temp);
  const cx = await pool.connect();
  try {
    await cx.query("begin");
    const r = await cx.query(
      `insert into users (kind, email, name, password_hash, must_change_password) values ('staff', $1, $2, $3, true) returning id`,
      [d.email, d.name, hash],
    );
    const id = r.rows[0].id as string;
    for (const g of uniq(d.groupIds)) await cx.query("insert into user_groups values ($1, $2) on conflict do nothing", [id, g]);
    for (const o of new Map(d.overrides.map((x) => [x.permission, x])).values()) await cx.query("insert into user_permissions values ($1, $2, $3)", [id, o.permission, o.effect]);
    await cx.query("commit");
    await audit("user.created", { userId: a.user.id, target: d.email, detail: { groups: d.groupIds.length, overrides: d.overrides.length }, ip: clientIp(c) });
    // Shown once. Email delivery arrives with the Mailjet integration.
    return c.json({ id, temporaryPassword: temp }, 201);
  } catch (err) {
    await cx.query("rollback").catch(() => {});
    if ((err as { code?: string }).code === "23505") return c.json({ error: "email already used" }, 409);
    throw err;
  } finally {
    cx.release();
  }
});

const UserPatch = z.object({
  name: z.string().min(1).max(120).optional(),
  email: z.string().trim().toLowerCase().email().max(200).optional(),
  locale: z.enum(["fr", "en"]).optional(),
  phone: z.string().trim().max(40).regex(/^[0-9 +()\-.xXtext]*$/, "invalid phone").optional(),
  active: z.boolean().optional(),
  groupIds: z.array(z.string().uuid()).optional(),
  overrides: z.array(z.object({ permission: Perm, effect: z.enum(["allow", "deny"]) })).optional(),
});

adminRoutes.patch("/users/:id", requirePermission("admin.users.manage"), async (c) => {
  const a = c.get("auth")!;
  const id = c.req.param("id");
  const body = UserPatch.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: body.error.flatten() }, 400);
  const target = (await pool.query("select id, kind, is_master from users where id = $1", [id])).rows[0];
  if (!target) return c.json({ error: "not found" }, 404);
  if (target.is_master && !a.user.isMaster) return c.json({ error: "only a master user can change a master user" }, 403);
  if (id === a.user.id && body.data.active === false) return c.json({ error: "you cannot deactivate yourself" }, 400);

  const d = body.data;
  const sensitive = d.active !== undefined || d.groupIds !== undefined || d.overrides !== undefined;
  if (!a.user.isMaster && sensitive) {
    // Non-master actors never change their own groups or overrides.
    if (id === a.user.id && (d.groupIds !== undefined || d.overrides !== undefined))
      return c.json({ error: "you cannot change your own groups or rights" }, 403);
    // Nor touch an account that holds rights they lack.
    const above = await rightsAboveActor(a, target);
    if (above.length) return c.json({ error: "cannot modify a user who holds rights you do not hold", rights: above }, 403);
  }
  const escalation = [
    ...(d.groupIds ? await groupEscalation(a, d.groupIds) : []),
    ...ungrantable(a.rights, a.user.isMaster, (d.overrides ?? []).filter((o) => o.effect === "allow").map((o) => o.permission)),
  ];
  // Any right the target would gain (new allow, new group, or a removed deny) must be one the actor holds.
  if (!a.user.isMaster && (d.groupIds !== undefined || d.overrides !== undefined)) {
    const [before, after] = [await rightsOf({ id, kind: target.kind, is_master: false }), await rightsAfter(id, target.kind, d)];
    escalation.push(...ungrantable(a.rights, false, after.filter((k) => !before.includes(k))));
  }
  if (escalation.length) return c.json({ error: "cannot grant rights you do not hold", rights: uniq(escalation) }, 403);

  if (d.name !== undefined) await pool.query("update users set name = $2 where id = $1", [id, d.name]);
  if (d.locale !== undefined) await pool.query("update users set locale = $2 where id = $1", [id, d.locale]);
  if (d.phone !== undefined) await pool.query("update users set phone = $2 where id = $1", [id, d.phone]);
  if (d.email !== undefined) {
    try { await pool.query("update users set email = $2 where id = $1", [id, d.email]); }
    catch (err) { if ((err as { code?: string }).code === "23505") return c.json({ error: "email already used" }, 409); throw err; }
  }
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
  const target = (await pool.query("select id, kind, is_master from users where id = $1", [id])).rows[0];
  if (!target) return c.json({ error: "not found" }, 404);
  if (target.is_master && !a.user.isMaster) return c.json({ error: "only a master user can reset a master user" }, 403);
  if (!a.user.isMaster) {
    const above = await rightsAboveActor(a, target);
    if (above.length) return c.json({ error: "cannot modify a user who holds rights you do not hold", rights: above }, 403);
  }
  const temp = temporaryPassword();
  await pool.query("update users set password_hash = $2, must_change_password = true, failed_logins = 0, locked_until = null where id = $1", [id, await hashPassword(temp)]);
  await pool.query("delete from sessions where user_id = $1", [id]);
  await audit("user.password_reset", { userId: a.user.id, target: id, ip: clientIp(c) });
  return c.json({ temporaryPassword: temp });
});

const RESET_HOURS = 72;

/** Emails the person a one-time link to choose a new password; when no email can leave, the link is returned to hand over. */
adminRoutes.post("/users/:id/send-reset", requirePermission("admin.users.manage"), async (c) => {
  const a = c.get("auth")!;
  const id = c.req.param("id");
  const u = (await pool.query("select id, name, email, locale, is_master, active from users where id = $1 and kind = 'staff'", [id])).rows[0];
  if (!u) return c.json({ error: "not found" }, 404);
  if (u.is_master && !a.user.isMaster) return c.json({ error: "only a master user can reset a master user" }, 403);
  if (!u.active) return c.json({ error: "user is inactive" }, 400);
  const token = randomToken();
  await pool.query("delete from password_tokens where user_id = $1 and used_at is null", [id]);
  await pool.query("insert into password_tokens (token_hash, user_id, expires_at) values ($1, $2, now() + ($3 || ' hours')::interval)", [sha256(token), id, String(RESET_HOURS)]);
  const link = `${config.publicUrl || ""}/set-password?token=${token}`;
  let emailed = false;
  if (await mailReady()) {
    const m = resetMail({ firm: license.current().branding.appName, name: u.name, link, hours: RESET_HOURS }, u.locale === "en" ? "en" : "fr");
    const res = await sendMail({ to: [{ email: u.email, name: u.name }], ...m }).catch(() => ({ sent: 0 }));
    emailed = res.sent > 0;
  }
  await audit("user.reset_link_sent", { userId: a.user.id, target: id, detail: { emailed }, ip: clientIp(c) });
  return c.json({ emailed, link: emailed ? undefined : link });
});

/** An administrator chooses the password directly (for example by phone). The person can be made to change it at next sign-in. */
adminRoutes.post("/users/:id/set-password", requirePermission("admin.users.manage"), async (c) => {
  const a = c.get("auth")!;
  const id = c.req.param("id");
  const body = z.object({ password: z.string().min(MIN_PASSWORD).max(200), mustChange: z.boolean().default(true) }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: `password must be at least ${MIN_PASSWORD} characters` }, 400);
  const target = (await pool.query("select is_master from users where id = $1 and kind = 'staff'", [id])).rows[0];
  if (!target) return c.json({ error: "not found" }, 404);
  if (target.is_master && !a.user.isMaster) return c.json({ error: "only a master user can change a master user" }, 403);
  await pool.query("update users set password_hash = $2, must_change_password = $3, failed_logins = 0, locked_until = null where id = $1", [id, await hashPassword(body.data.password), body.data.mustChange]);
  if (id !== a.user.id) await pool.query("delete from sessions where user_id = $1", [id]);
  await audit("user.password_set", { userId: a.user.id, target: id, ip: clientIp(c) });
  return c.json({ ok: true });
});

/** Rights granted through groups the acting admin is about to assign but does not hold themselves. */
async function groupEscalation(a: { rights: string[]; user: { isMaster: boolean } }, groupIds: string[]): Promise<string[]> {
  if (!groupIds.length || a.user.isMaster) return [];
  const r = await pool.query("select permissions from groups where id = any($1::uuid[])", [groupIds]);
  return uniq(ungrantable(a.rights, false, r.rows.flatMap((g) => g.permissions as string[])));
}

/** Rights the target currently holds that the (non-master) actor does not. */
async function rightsAboveActor(a: { rights: string[] }, target: { id: string; kind: Audience; is_master: boolean }): Promise<string[]> {
  return uniq(ungrantable(a.rights, false, await rightsOf(target)));
}

/** The target's effective rights if the requested groups/overrides were applied (unspecified parts stay as stored). */
async function rightsAfter(
  id: string,
  kind: Audience,
  d: { groupIds?: string[]; overrides?: { permission: string; effect: "allow" | "deny" }[] },
): Promise<string[]> {
  const [groups, stored] = await Promise.all([
    d.groupIds
      ? pool.query("select permissions from groups where id = any($1::uuid[])", [d.groupIds])
      : pool.query("select g.permissions from groups g join user_groups ug on ug.group_id = g.id where ug.user_id = $1", [id]),
    d.overrides ? Promise.resolve(null) : pool.query("select permission, effect from user_permissions where user_id = $1", [id]),
  ]);
  const ov = d.overrides ?? stored!.rows;
  return effectivePermissions({
    audience: kind,
    master: false,
    groupPermissions: groups.rows.map((r) => r.permissions as string[]),
    allow: ov.filter((o) => o.effect === "allow").map((o) => o.permission),
    deny: ov.filter((o) => o.effect === "deny").map((o) => o.permission),
  });
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
    defaultBranding: license.baseBranding(), brandingOverride: license.brandingOverride(),
    enabledModules: lic.modules, loadedModules, license: license.status(), allStaffRights: permissionsFor("staff").length,
  });
});

// -------------------- The firm's own branding (white label) --------------------
const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const LOGO_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/svg+xml"]);
const LOGO_MAX = 400 * 1024;
const FAVICON_MAX = 256 * 1024;
const BRAND = requirePermission("admin.branding.manage");

adminRoutes.put("/branding", BRAND, async (c) => {
  const d = z.object({ appName: z.string().trim().max(60).optional(), primaryColor: Hex.optional(), accentColor: Hex.optional(), faviconUrl: z.string().refine(isSafeIconUrl).optional() })
    .safeParse(await c.req.json().catch(() => null));
  if (!d.success) return c.json({ error: d.error.flatten() }, 400);
  const cur = license.brandingOverride();
  await license.setBrandingOverride({ ...cur, appName: d.data.appName ?? cur.appName, primaryColor: d.data.primaryColor ?? cur.primaryColor, accentColor: d.data.accentColor ?? cur.accentColor, faviconUrl: d.data.faviconUrl ?? cur.faviconUrl });
  await audit("branding.updated", { userId: c.get("auth")!.user.id, detail: Object.keys(d.data), ip: clientIp(c) });
  return c.json({ ok: true });
});

adminRoutes.put("/branding/logo", BRAND, async (c) => {
  const type = (c.req.header("x-logo-type") ?? "").toLowerCase();
  if (!LOGO_TYPES.has(type)) return c.json({ error: "logo must be a PNG, JPG, WebP or SVG image" }, 400);
  const data = Buffer.from(await c.req.arrayBuffer());
  if (!data.length) return c.json({ error: "empty file" }, 400);
  if (data.length > LOGO_MAX) return c.json({ error: "logo too large (400 KB maximum)" }, 413);
  await storeLogo(c.get("auth")!.user.id, type, data, clientIp(c));
  return c.json({ ok: true });
});

async function storeLogo(userId: string, type: string, data: Buffer, ip?: string) {
  await setSetting("branding_logo", { type, b64: data.toString("base64") });
  await license.setBrandingOverride({ ...license.brandingOverride(), logoUrl: `/api/branding/logo?v=${Date.now()}` });
  await audit("branding.logo_set", { userId, ip });
}

const siteFailure = (e: unknown) => {
  const code = e instanceof SiteError ? e.code : "fetch_failed";
  return { body: { error: code }, status: (code === "blocked_address" || code === "invalid_url" ? 400 : 502) as 400 | 502 };
};

/** Looks at the firm's public website and suggests colors and logos. Nothing is saved: the administrator chooses. */
adminRoutes.post("/branding/from-site", BRAND, async (c) => {
  const d = z.object({ url: z.string().trim().min(3).max(300) }).safeParse(await c.req.json().catch(() => null));
  if (!d.success) return c.json({ error: "invalid_url" }, 400);
  try {
    const page = await safeGet(d.data.url, { maxBytes: 1_500_000, accept: "text/html,application/xhtml+xml", truncate: true });
    if (!/html|xml/.test(page.type)) return c.json({ error: "not_a_web_page" }, 400);
    const found = extractBrand(page.body.toString("utf8"), page.url);
    const css = await Promise.all(found.stylesheets.map((u) => safeGet(u, { maxBytes: 300_000, accept: "text/css,*/*", truncate: true }).then((r) => r.body.toString("utf8")).catch(() => "")));
    const manifest = found.manifest ? await safeGet(found.manifest, { maxBytes: 100_000, accept: "application/json,*/*" }).then((r) => JSON.parse(r.body.toString("utf8")) as { theme_color?: string; background_color?: string }).catch(() => null) : null;
    const fromManifest: ColorHit[] = [];
    for (const k of ["theme_color", "background_color"] as const) { const hex = normalizeColor(String(manifest?.[k] ?? "")); if (hex) fromManifest.push({ hex, source: `manifest ${k}` }); }
    const fromCss = colorsFromCss(css.join("\n"));
    // The page's declared colors first, then CSS variables, then the colors the site uses most.
    const colors = dedupeColors([...found.colors, ...fromManifest.filter((x) => x.source.includes("theme")), ...fromCss.filter((x) => x.source !== "used"), ...fromCss.filter((x) => x.source === "used"), ...fromManifest]).slice(0, 8);
    const logos = (await Promise.all(found.logos.map(async (l) => {
      try {
        const r = await safeGet(l.url, { maxBytes: LOGO_MAX, accept: "image/*" });
        const type = sniffImage(r.body);
        if (!type) return null;
        return { url: r.url, source: l.source, type, bytes: r.body.length, dataUrl: r.body.length <= 250 * 1024 ? `data:${type};base64,${r.body.toString("base64")}` : undefined };
      } catch { return null; }
    }))).filter((x): x is NonNullable<typeof x> => x !== null);
    // Suggested tab icon: the first ranked candidate that really is a PNG/ICO/WebP. Only a suggestion; nothing is saved.
    let favicon: { url: string; source: string; type: string; bytes: number; dataUrl: string } | null = null;
    for (const ic of rankFavicons(found.icons).slice(0, 4)) {
      try {
        const r = await safeGet(ic.url, { maxBytes: FAVICON_MAX, accept: "image/*" });
        const type = sniffIcon(r.body);
        if (type) { favicon = { url: r.url, source: ic.source, type, bytes: r.body.length, dataUrl: `data:${type};base64,${r.body.toString("base64")}` }; break; }
      } catch { /* try the next one */ }
    }
    return c.json({ site: page.url, title: found.title, colors, logos, favicon });
  } catch (e) { const f = siteFailure(e); return c.json(f.body, f.status); }
});

/** Uses one of the logos found on the site (downloaded again by the server, checked, then stored). */
adminRoutes.post("/branding/logo-from-url", BRAND, async (c) => {
  const d = z.object({ url: z.string().trim().min(3).max(500) }).safeParse(await c.req.json().catch(() => null));
  if (!d.success) return c.json({ error: "invalid_url" }, 400);
  try {
    const r = await safeGet(d.data.url, { maxBytes: LOGO_MAX, accept: "image/*" });
    const type = sniffImage(r.body);
    if (!type) return c.json({ error: "not_an_image" }, 400);
    await storeLogo(c.get("auth")!.user.id, type, r.body, clientIp(c));
    return c.json({ ok: true });
  } catch (e) { const f = siteFailure(e); return c.json(f.body, f.status); }
});

// Tab icon (favicon): uploaded or taken from the site, stored here, served from /api/branding/favicon.
async function storeFavicon(userId: string, type: string, data: Buffer, ip?: string) {
  await setSetting("branding_favicon", { type, b64: data.toString("base64") });
  await license.setBrandingOverride({ ...license.brandingOverride(), faviconUrl: `/api/branding/favicon?v=${Date.now()}` });
  await audit("branding.favicon_set", { userId, ip });
}

adminRoutes.put("/branding/favicon", BRAND, async (c) => {
  const data = Buffer.from(await c.req.arrayBuffer());
  if (!data.length) return c.json({ error: "empty file" }, 400);
  if (data.length > FAVICON_MAX) return c.json({ error: "icon too large (256 KB maximum)" }, 413);
  const type = sniffIcon(data); // the real bytes decide, never the declared type
  if (!type) return c.json({ error: "icon must be a PNG, ICO or WebP image" }, 400);
  await storeFavicon(c.get("auth")!.user.id, type, data, clientIp(c));
  return c.json({ ok: true });
});

adminRoutes.post("/branding/favicon-from-url", BRAND, async (c) => {
  const d = z.object({ url: z.string().trim().min(3).max(500) }).safeParse(await c.req.json().catch(() => null));
  if (!d.success) return c.json({ error: "invalid_url" }, 400);
  try {
    const r = await safeGet(d.data.url, { maxBytes: FAVICON_MAX, accept: "image/*" });
    const type = sniffIcon(r.body);
    if (!type) return c.json({ error: "not_an_image" }, 400);
    await storeFavicon(c.get("auth")!.user.id, type, r.body, clientIp(c));
    return c.json({ ok: true });
  } catch (e) { const f = siteFailure(e); return c.json(f.body, f.status); }
});

adminRoutes.delete("/branding/favicon", BRAND, async (c) => {
  await setSetting("branding_favicon", null);
  const { faviconUrl: _drop, ...rest } = license.brandingOverride();
  void _drop;
  await license.setBrandingOverride(rest);
  await audit("branding.favicon_removed", { userId: c.get("auth")!.user.id, ip: clientIp(c) });
  return c.json({ ok: true });
});

adminRoutes.delete("/branding/logo", BRAND, async (c) => {
  await setSetting("branding_logo", null);
  const { logoUrl: _drop, ...rest } = license.brandingOverride();
  void _drop;
  await license.setBrandingOverride(rest);
  await audit("branding.logo_removed", { userId: c.get("auth")!.user.id, ip: clientIp(c) });
  return c.json({ ok: true });
});

/** Back to the supplier's default look. */
adminRoutes.delete("/branding", BRAND, async (c) => {
  await setSetting("branding_logo", null);
  await setSetting("branding_favicon", null);
  await license.setBrandingOverride({});
  await audit("branding.reset", { userId: c.get("auth")!.user.id, ip: clientIp(c) });
  return c.json({ ok: true });
});

adminRoutes.get("/audit", requirePermission("admin.audit.view"), async (c) => {
  const r = await pool.query(
    `select a.id, a.at, a.action, a.target, a.detail, a.ip, u.name as user_name
       from audit_log a left join users u on u.id = a.user_id order by a.id desc limit 200`,
  );
  return c.json(r.rows);
});
