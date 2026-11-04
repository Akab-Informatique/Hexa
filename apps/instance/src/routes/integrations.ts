import { Hono } from "hono";
import { z } from "zod";
import { pool } from "../db.ts";
import { audit } from "../auth/access.ts";
import { open, seal } from "../auth/secrets.ts";
import { requirePermission, type Env } from "../auth/session.ts";
import { auth, body } from "./util.ts";

// Each firm registers its own apps with Microsoft, Intuit and Mailjet and enters the credentials here.
// Secret fields are sealed at rest and never returned: the API only says whether they are set.
export interface FieldDef { key: string; label: { fr: string; en: string }; secret?: boolean; options?: string[]; placeholder?: string }
export const PROVIDERS: Record<string, { label: string; fields: FieldDef[] }> = {
  o365: { label: "Microsoft 365", fields: [
    { key: "tenantId", label: { fr: "ID de l'annuaire (tenant)", en: "Directory (tenant) ID" } },
    { key: "clientId", label: { fr: "ID de l'application (client)", en: "Application (client) ID" } },
    { key: "clientSecret", label: { fr: "Secret client", en: "Client secret" }, secret: true },
  ] },
  sharepoint: { label: "SharePoint", fields: [
    { key: "siteUrl", label: { fr: "Adresse du site SharePoint", en: "SharePoint site URL" }, placeholder: "https://firm.sharepoint.com/sites/docs" },
  ] },
  mailjet: { label: "Mailjet", fields: [
    { key: "apiKey", label: { fr: "Clé d'API", en: "API key" }, secret: true },
    { key: "secretKey", label: { fr: "Clé secrète", en: "Secret key" }, secret: true },
    { key: "senderEmail", label: { fr: "Courriel de l'expéditeur", en: "Sender email" } },
    { key: "senderName", label: { fr: "Nom de l'expéditeur", en: "Sender name" } },
  ] },
  quickbooks: { label: "QuickBooks", fields: [
    { key: "environment", label: { fr: "Environnement", en: "Environment" }, options: ["sandbox", "production"] },
    { key: "clientId", label: { fr: "ID client Intuit", en: "Intuit client ID" } },
    { key: "clientSecret", label: { fr: "Secret client Intuit", en: "Intuit client secret" }, secret: true },
  ] },
};

export const integrationRoutes = new Hono<Env>();

integrationRoutes.get("/", requirePermission("admin.integrations.view", "admin.integrations.manage"), async (c) => {
  const r = await pool.query("select provider, config, secret_enc, enabled, updated_at from integrations");
  const byProvider = new Map(r.rows.map((x) => [x.provider as string, x]));
  return c.json(Object.entries(PROVIDERS).map(([key, def]) => {
    const row = byProvider.get(key);
    const secrets = open(row?.secret_enc);
    return {
      provider: key, label: def.label, enabled: Boolean(row?.enabled), updatedAt: row?.updated_at ?? null,
      fields: def.fields.map((f) => ({
        ...f,
        // Plain fields come back with their value; secret fields only say whether something is stored.
        value: f.secret ? "" : (row?.config?.[f.key] ?? ""),
        isSet: f.secret ? Boolean(secrets[f.key]) : Boolean(row?.config?.[f.key]),
      })),
      configured: def.fields.filter((f) => f.key !== "senderName").every((f) => (f.secret ? Boolean(secrets[f.key]) : Boolean(row?.config?.[f.key]))),
    };
  }));
});

integrationRoutes.put("/:provider", requirePermission("admin.integrations.manage"), async (c) => {
  const def = PROVIDERS[c.req.param("provider")];
  if (!def) return c.json({ error: "unknown provider" }, 404);
  const d = await body(c, z.object({ values: z.record(z.string().max(2000)).default({}), enabled: z.boolean().optional() }));
  const existing = (await pool.query("select config, secret_enc from integrations where provider = $1", [c.req.param("provider")])).rows[0];
  const config: Record<string, string> = { ...(existing?.config ?? {}) };
  const secrets = open(existing?.secret_enc);
  for (const f of def.fields) {
    const v = d.values[f.key];
    if (v === undefined) continue;
    // An empty secret field means "keep the stored one"; plain fields can be cleared.
    if (f.secret) { if (v !== "") secrets[f.key] = v; } else if (f.options && v && !f.options.includes(v)) return c.json({ error: `invalid ${f.key}` }, 400); else config[f.key] = v;
  }
  await pool.query(
    `insert into integrations (provider, config, secret_enc, enabled, updated_by, updated_at) values ($1, $2::jsonb, $3, $4, $5, now())
     on conflict (provider) do update set config = excluded.config, secret_enc = excluded.secret_enc, enabled = coalesce($6, integrations.enabled), updated_by = excluded.updated_by, updated_at = now()`,
    [c.req.param("provider"), JSON.stringify(config), seal(secrets), d.enabled ?? false, auth(c).user.id, d.enabled ?? null],
  );
  await audit("integration.updated", { userId: auth(c).user.id, target: c.req.param("provider") });
  return c.json({ ok: true });
});

/** Light status for pages that depend on an integration (calendar, inbox, email copy). */
export async function integrationStatus(): Promise<Record<string, { configured: boolean; enabled: boolean }>> {
  const r = await pool.query("select provider, config, secret_enc, enabled from integrations");
  const out: Record<string, { configured: boolean; enabled: boolean }> = {};
  for (const [key, def] of Object.entries(PROVIDERS)) {
    const row = r.rows.find((x) => x.provider === key);
    const secrets = open(row?.secret_enc);
    out[key] = {
      enabled: Boolean(row?.enabled),
      configured: Boolean(row) && def.fields.filter((f) => f.key !== "senderName").every((f) => (f.secret ? Boolean(secrets[f.key]) : Boolean(row.config?.[f.key]))),
    };
  }
  return out;
}
