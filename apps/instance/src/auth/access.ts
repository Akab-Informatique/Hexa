import { effectivePermissions, MODULES, permissionsFor, type Audience } from "@nexo/shared/permissions";
import { pool } from "../db.ts";

export async function rightsOf(user: { id: string; kind: Audience; is_master: boolean }): Promise<string[]> {
  const [groups, overrides] = await Promise.all([
    pool.query(
      `select g.permissions from groups g join user_groups ug on ug.group_id = g.id where ug.user_id = $1`,
      [user.id],
    ),
    pool.query("select permission, effect from user_permissions where user_id = $1", [user.id]),
  ]);
  return effectivePermissions({
    audience: user.kind,
    master: user.is_master,
    groupPermissions: groups.rows.map((r) => r.permissions as string[]),
    allow: overrides.rows.filter((r) => r.effect === "allow").map((r) => r.permission),
    deny: overrides.rows.filter((r) => r.effect === "deny").map((r) => r.permission),
  });
}

/** System groups are re-synced on every start so new permissions reach them without a migration. */
export async function seedSystemGroups(): Promise<void> {
  const staffAll = permissionsFor("staff");
  const readOnly = staffAll.filter((k) => /\.(view|use)$/.test(k) && !k.startsWith("admin."));
  const basic = staffAll.filter((k) => !k.startsWith("admin.") && !/\.(manage|approve|lock)$/.test(k));
  const defs = [
    { slug: "administrators", name: "Administrateurs", description: "Tous les droits du personnel", permissions: staffAll, locked: true },
    { slug: "staff", name: "Personnel", description: "Accès standard (sans gestion ni administration)", permissions: basic, locked: false },
    { slug: "read-only", name: "Lecture seule", description: "Consultation seulement", permissions: readOnly, locked: false },
  ];
  for (const d of defs) {
    // Locked groups are always reset; editable ones are only created, never overwritten.
    await pool.query(
      `insert into groups (slug, name, description, audience, permissions, is_system, locked)
       values ($1, $2, $3, 'staff', $4::jsonb, true, $5)
       on conflict (slug) do update set
         permissions = case when groups.locked then excluded.permissions else groups.permissions end`,
      [d.slug, d.name, d.description, JSON.stringify(d.permissions), d.locked],
    );
  }
}

/** The group every client portal user belongs to; it always holds every client right (a user can still be given fewer through overrides). */
export async function seedClientGroup(): Promise<void> {
  await pool.query(
    `insert into groups (slug, name, description, audience, permissions, is_system, locked)
     values ('client-portal', 'Portail client', 'Accès standard au portail client', 'client', $1::jsonb, true, true)
     on conflict (slug) do update set permissions = excluded.permissions`,
    [JSON.stringify(permissionsFor("client"))],
  );
}

export async function audit(action: string, opts: { userId?: string | null; target?: string; detail?: unknown; ip?: string } = {}) {
  await pool.query("insert into audit_log (user_id, action, target, detail, ip) values ($1, $2, $3, $4::jsonb, $5)", [
    opts.userId ?? null, action, opts.target ?? null, JSON.stringify(opts.detail ?? {}), opts.ip ?? null,
  ]);
}

export const catalog = () => MODULES;
