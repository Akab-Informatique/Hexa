import { Hono } from "hono";
import { z } from "zod";
import { pool } from "../db.ts";
import { audit } from "../auth/access.ts";
import { requirePermission, type Env } from "../auth/session.ts";
import { leadsToAccess, levelOn, type Level, type Rule } from "../lib/docRules.ts";
import { cleanPath, getProvider, joinPath, SpError, type Item, type Provider } from "../lib/sharepoint.ts";
import { auth, body, camelRows, can } from "./util.ts";

// Documentation = the firm's SharePoint, browsed through the Graph API. SharePoint itself is never exposed:
// each request is checked against the portal's folder rules (doc_access), so who sees which folder is
// managed here. A rule on a folder covers everything below it. Users with docs.manage see every library.
export const docsRoutes = new Hono<Env>();
docsRoutes.use("*", requirePermission("docs.view", "docs.edit", "docs.manage"));

async function myRules(c: Parameters<typeof auth>[0], drive: string): Promise<Rule[]> {
  const a = auth(c);
  const r = await pool.query(
    `select path, level from doc_access where drive_id = $1 and (
       (principal_type = 'user' and principal_id = $2) or
       (principal_type = 'group' and principal_id in (select group_id from user_groups where user_id = $2)))`, [drive, a.user.id]);
  return r.rows as Rule[];
}

const sees = (c: Parameters<typeof auth>[0]) => can(c, "docs.manage");
const canManageAccess = (c: Parameters<typeof auth>[0]) => can(c, "docs.manage", "docs.access.manage");

async function provider(): Promise<Provider> {
  const p = await getProvider();
  if (!p) throw new SpError(503, "sharepoint_not_configured");
  return p;
}
async function assertDrive(p: Provider, drive: string) {
  if (!(await p.libraries()).some((l) => l.id === drive)) throw new SpError(404, "unknown library");
}

docsRoutes.onError((e, c) => {
  if (e instanceof SpError) return c.json({ error: e.message }, e.status as 400);
  throw e;
});

docsRoutes.get("/status", async (c) => {
  const p = await getProvider();
  return c.json({ configured: Boolean(p), mock: Boolean(p?.mock), canManageAccess: canManageAccess(c), canWrite: can(c, "docs.edit", "docs.manage") });
});

docsRoutes.get("/libraries", async (c) => {
  const p = await provider();
  const libs = await p.libraries();
  if (sees(c)) return c.json(libs);
  const a = auth(c);
  const r = await pool.query(
    `select distinct drive_id from doc_access where (principal_type = 'user' and principal_id = $1) or
       (principal_type = 'group' and principal_id in (select group_id from user_groups where user_id = $1))`, [a.user.id]);
  const ok = new Set(r.rows.map((x) => x.drive_id as string));
  return c.json(libs.filter((l) => ok.has(l.id)));
});

docsRoutes.get("/browse", async (c) => {
  const p = await provider();
  const drive = c.req.query("drive") ?? "";
  const path = cleanPath(c.req.query("path") ?? "");
  await assertDrive(p, drive);
  const all = sees(c);
  const rules = all ? [] : await myRules(c, drive);
  const level: Level | null = all ? "edit" : levelOn(rules, path);
  if (!all && !level && !leadsToAccess(rules, path)) return c.json({ error: "forbidden" }, 403);
  const items = await p.list(drive, path);
  const shown: Item[] = items.filter((it) => {
    if (all || level) return true; // inside an allowed folder everything below is allowed too
    return it.folder && (Boolean(levelOn(rules, it.path)) || leadsToAccess(rules, it.path));
  });
  shown.sort((x, y) => Number(y.folder) - Number(x.folder) || x.name.localeCompare(y.name, undefined, { sensitivity: "base" }));
  // Opening a folder that is only on the way to an allowed one lists just the way through (level "path").
  return c.json({ level: all ? "manage" : level ?? "path", canWrite: Boolean(level === "edit" && can(c, "docs.edit", "docs.manage")), items: shown });
});

async function need(c: Parameters<typeof auth>[0], drive: string, path: string, write: boolean) {
  if (sees(c)) { if (write && !can(c, "docs.edit", "docs.manage")) throw new SpError(403, "forbidden"); return; }
  const level = levelOn(await myRules(c, drive), path);
  if (!level || (write && (level !== "edit" || !can(c, "docs.edit")))) throw new SpError(403, "forbidden");
}

docsRoutes.get("/file", async (c) => {
  const p = await provider();
  const drive = c.req.query("drive") ?? "";
  const path = cleanPath(c.req.query("path") ?? "");
  if (!path) throw new SpError(400, "invalid path");
  await assertDrive(p, drive);
  await need(c, drive, path, false);
  const f = await p.download(drive, path);
  const name = path.split("/").pop()!;
  await audit("docs.download", { userId: auth(c).user.id, target: `${drive}/${path}` });
  return new Response(f.data, { headers: {
    "content-type": f.contentType, "x-content-type-options": "nosniff",
    "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
  } });
});

const NameSchema = z.string().min(1).max(200).refine((n) => !/[\\/<>:"|?*\u0000-\u001f]/.test(n) && n !== "." && n !== "..", "invalid name");

docsRoutes.put("/file", async (c) => {
  const p = await provider();
  const drive = c.req.query("drive") ?? "";
  const path = cleanPath(c.req.query("path") ?? "");
  const name = NameSchema.parse(c.req.query("name") ?? "");
  await assertDrive(p, drive);
  await need(c, drive, path, true);
  const data = await c.req.arrayBuffer();
  if (data.byteLength === 0) throw new SpError(400, "empty file");
  await p.upload(drive, path, name, data);
  await audit("docs.upload", { userId: auth(c).user.id, target: `${drive}/${joinPath(path, name)}` });
  return c.json({ ok: true });
});

docsRoutes.post("/folder", async (c) => {
  const p = await provider();
  const d = await body(c, z.object({ drive: z.string().min(1), path: z.string().default(""), name: NameSchema }));
  const path = cleanPath(d.path);
  await assertDrive(p, d.drive);
  await need(c, d.drive, path, true);
  await p.mkdir(d.drive, path, d.name);
  await audit("docs.folder_created", { userId: auth(c).user.id, target: `${d.drive}/${joinPath(path, d.name)}` });
  return c.json({ ok: true });
});

docsRoutes.delete("/item", async (c) => {
  const p = await provider();
  const drive = c.req.query("drive") ?? "";
  const path = cleanPath(c.req.query("path") ?? "");
  if (!path) throw new SpError(400, "invalid path");
  await assertDrive(p, drive);
  await need(c, drive, path, true);
  await p.remove(drive, path);
  // Rules that pointed at a deleted folder would silently apply to a new folder of the same name.
  await pool.query("delete from doc_access where drive_id = $1 and (lower(path) = lower($2) or lower(path) like lower($2) || '/%')", [drive, path]);
  await audit("docs.deleted", { userId: auth(c).user.id, target: `${drive}/${path}` });
  return c.json({ ok: true });
});

// ------------------------------------------------------------------ Folder rules
docsRoutes.get("/access", async (c) => {
  if (!canManageAccess(c)) return c.json({ error: "forbidden" }, 403);
  const drive = c.req.query("drive");
  const r = await pool.query(
    `select a.id, a.drive_id, a.drive_name, a.path, a.principal_type, a.principal_id, a.level, a.created_at,
            coalesce(u.name, g.name) as principal_name
       from doc_access a left join users u on a.principal_type = 'user' and u.id = a.principal_id
                         left join groups g on a.principal_type = 'group' and g.id = a.principal_id
      where ($1::text is null or a.drive_id = $1) order by a.drive_name, lower(a.path), a.principal_type, lower(coalesce(u.name, g.name))`, [drive ?? null]);
  return c.json(camelRows(r));
});

const RuleInput = z.object({
  drive: z.string().min(1), path: z.string().default(""), principalType: z.enum(["user", "group"]), principalId: z.string().uuid(), level: z.enum(["view", "edit"]),
});

docsRoutes.post("/access", async (c) => {
  if (!canManageAccess(c)) return c.json({ error: "forbidden" }, 403);
  const p = await provider();
  const d = await body(c, RuleInput);
  const path = cleanPath(d.path);
  const lib = (await p.libraries()).find((l) => l.id === d.drive);
  if (!lib) throw new SpError(404, "unknown library");
  // Same rule as for rights: nobody hands out more access than they hold themselves.
  if (!sees(c)) {
    const mine = levelOn(await myRules(c, d.drive), path);
    if (!mine || (d.level === "edit" && mine !== "edit")) throw new SpError(403, "forbidden");
  }
  const exists = d.principalType === "user"
    ? (await pool.query("select 1 from users where id = $1 and kind = 'staff'", [d.principalId])).rowCount
    : (await pool.query("select 1 from groups where id = $1", [d.principalId])).rowCount;
  if (!exists) throw new SpError(404, "unknown user or group");
  // The folder must exist: a typo would otherwise create a rule that protects nothing.
  if (path) {
    const parent = path.split("/").slice(0, -1).join("/");
    const leaf = path.split("/").pop()!.toLowerCase();
    if (!(await p.list(d.drive, parent)).some((i) => i.folder && i.name.toLowerCase() === leaf)) throw new SpError(404, "folder not found");
  }
  const r = await pool.query(
    `insert into doc_access (drive_id, drive_name, path, principal_type, principal_id, level, created_by) values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (drive_id, path, principal_type, principal_id) do update set level = excluded.level returning id`,
    [d.drive, lib.name, path, d.principalType, d.principalId, d.level, auth(c).user.id]);
  await audit("docs.access_set", { userId: auth(c).user.id, target: `${lib.name}/${path} ${d.principalType}:${d.principalId} ${d.level}` });
  return c.json({ id: r.rows[0].id });
});

docsRoutes.delete("/access/:id", async (c) => {
  if (!canManageAccess(c)) return c.json({ error: "forbidden" }, 403);
  const row = (await pool.query("select drive_id, path from doc_access where id::text = $1", [c.req.param("id")])).rows[0];
  if (!row) return c.json({ error: "not found" }, 404);
  if (!sees(c) && !levelOn(await myRules(c, row.drive_id), row.path)) return c.json({ error: "forbidden" }, 403);
  const r = await pool.query("delete from doc_access where id::text = $1 returning drive_name, path", [c.req.param("id")]);
  await audit("docs.access_removed", { userId: auth(c).user.id, target: `${r.rows[0].drive_name}/${r.rows[0].path}` });
  return c.json({ ok: true });
});
