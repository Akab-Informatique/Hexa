import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { serveStatic } from "@hono/node-server/serve-static";
import { z } from "zod";
import pg from "pg";
import {
  BrandingSchema,
  LicenseCheckRequestSchema,
  VERSION_RE,
  compareVersions,
  type LicenseCheckResponse,
} from "@nexo/shared";
import { config } from "./config.ts";
import { decrypt, derive, encrypt, randomToken, safeEqual } from "./crypto.ts";
import { buildBundle, newSecrets } from "./bundle.ts";

const Slug = z.string().regex(/^[a-z][a-z0-9-]{1,30}$/, "lowercase letters, digits, dashes");
const Version = z.string().regex(VERSION_RE);
const Domain = z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i);

const ClientInput = z.object({
  id: Slug,
  name: z.string().min(1),
  domain: Domain,
  adminEmail: z.string().email(),
  plan: z.string().default("standard"),
  maxUsers: z.number().int().positive().nullable().default(null),
  modules: z.array(Slug).default([]),
  flags: z.record(z.boolean()).default({}),
  branding: BrandingSchema.partial().default({}),
  pinnedVersion: Version,
  channel: z.string().default("stable"),
  expiresAt: z.string().datetime().nullable().default(null),
  appPort: z.number().int().min(1024).max(65535).default(3000),
  notes: z.string().default(""),
  /** Demo data the instance seeds on its first start (for demo tenants only). */
  seedProfile: z.enum(["none", "accounting", "bookkeeping", "tax"]).default("none"),
});
const ClientPatch = ClientInput.omit({ id: true }).partial().extend({ active: z.boolean().optional() });

type Row = Record<string, any>;
const publicClient = (r: Row) => ({
  id: r.id, name: r.name, domain: r.domain, adminEmail: r.admin_email, plan: r.plan, maxUsers: r.max_users, modules: r.modules,
  flags: r.flags, branding: r.branding, pinnedVersion: r.pinned_version, channel: r.channel,
  active: r.active, expiresAt: r.expires_at, appPort: r.app_port, notes: r.notes, createdAt: r.created_at,
  lastSeenAt: r.last_seen_at, lastVersion: r.last_version, lastHealth: r.last_health, lastUserCount: r.last_user_count, seedProfile: r.seed_profile,
});

export function buildApp(pool: pg.Pool): Hono {
  const app = new Hono();

  // ---------- Public: called by client instances ----------
  app.get("/api/ping", (c) => c.json({ ok: true }));

  app.post("/api/license/check", async (c) => {
    const parsed = LicenseCheckRequestSchema.safeParse(await c.req.json().catch(() => null));
    const deny = (reason: string): Response => c.json({ valid: false, reason } satisfies Partial<LicenseCheckResponse>, 200);
    if (!parsed.success) return c.json({ valid: false, reason: "bad request" }, 400);
    const req = parsed.data;
    const r = (await pool.query("select * from clients where id=$1", [req.clientId])).rows[0] as Row | undefined;
    // Same answer for "unknown client" and "wrong key" so ids can't be probed.
    if (!r || !safeEqual(decrypt(r.license_key_enc, config.secret()), req.licenseKey)) return deny("unknown client or key");
    await pool.query(
      "update clients set last_seen_at=now(), last_version=$2, last_health=$3, last_user_count=$4 where id=$1",
      [r.id, req.version, req.health, req.userCount ?? null],
    );
    if (!r.active) return deny("license suspended");
    if (r.expires_at && new Date(r.expires_at) < new Date()) return deny("license expired");
    const branding = BrandingSchema.parse({ appName: r.name, ...r.branding });
    return c.json({
      valid: true, plan: r.plan, maxUsers: r.max_users, modules: r.modules, flags: r.flags, branding,
      pinnedVersion: r.pinned_version, channel: r.channel, expiresAt: r.expires_at,
    } satisfies LicenseCheckResponse);
  });

  // Used by the marketing site's "Find your firm": slug -> that firm's sign-in address. Public on purpose
  // (it only reveals a login URL), CORS-open so the static site can call it.
  app.get("/api/tenants/lookup", async (c) => {
    const slug = (c.req.query("slug") ?? "").toLowerCase().trim();
    const r = /^[a-z][a-z0-9-]{1,30}$/.test(slug) ? await pool.query("select domain, name from clients where id=$1 and active", [slug]) : { rows: [] as Row[] };
    c.header("access-control-allow-origin", "*");
    return r.rows[0] ? c.json({ url: "https://" + r.rows[0].domain, name: r.rows[0].name }) : c.json({ error: "not found" }, 404);
  });

  // CI registers a release after pushing images: POST /api/releases with Bearer RELEASE_TOKEN.
  const releaseAuth = async (c: any, next: any) => {
    const bearer = (c.req.header("authorization") ?? "").replace(/^Bearer /, "");
    if (config.releaseToken && bearer && safeEqual(bearer, config.releaseToken)) return next();
    return adminAuth(c, next);
  };

  // ---------- Admin (basic auth) ----------
  const adminAuth = (c: any, next: any) =>
    basicAuth({ username: config.adminUser, password: config.adminPassword() })(c, next);

  app.post("/api/releases", releaseAuth, async (c) => {
    const body = z.object({ version: Version, channel: z.string().default("stable"), notes: z.string().default("") })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.flatten() }, 400);
    await pool.query(
      `insert into releases (version, channel, notes) values ($1,$2,$3)
       on conflict (version) do update set channel=excluded.channel, notes=excluded.notes`,
      [body.data.version, body.data.channel, body.data.notes],
    );
    return c.json({ ok: true }, 201);
  });

  app.use("/api/clients/*", adminAuth);
  app.use("/api/clients", adminAuth);
  app.use("/api/releases", async (c, next) => (c.req.method === "POST" ? next() : adminAuth(c, next)));
  app.use("/api/fleet", adminAuth);

  app.get("/api/releases", async (c) => {
    const rows = (await pool.query("select * from releases")).rows as Row[];
    rows.sort((a, b) => compareVersions(b.version, a.version));
    return c.json(rows.map((r) => ({ version: r.version, channel: r.channel, notes: r.notes, createdAt: r.created_at })));
  });

  app.get("/api/clients", async (c) =>
    c.json((await pool.query("select * from clients order by name")).rows.map(publicClient)),
  );

  app.post("/api/clients", async (c) => {
    const parsed = ClientInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const d = parsed.data;
    const secret = config.secret();
    try {
      await pool.query(
        `insert into clients (id,name,domain,plan,max_users,modules,flags,branding,pinned_version,channel,
           license_key_enc,secrets_enc,expires_at,app_port,notes,admin_email,seed_profile)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [d.id, d.name, d.domain, d.plan, d.maxUsers, d.modules, d.flags, d.branding, d.pinnedVersion, d.channel,
         encrypt(randomToken(32), secret), encrypt(JSON.stringify(newSecrets()), secret), d.expiresAt, d.appPort, d.notes, d.adminEmail, d.seedProfile],
      );
    } catch (err) {
      if ((err as { code?: string }).code === "23505") return c.json({ error: "client id already exists" }, 409);
      throw err;
    }
    const row = (await pool.query("select * from clients where id=$1", [d.id])).rows[0] as Row;
    return c.json(publicClient(row), 201);
  });

  app.patch("/api/clients/:id", async (c) => {
    const parsed = ClientPatch.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const map: Record<string, string> = {
      name: "name", domain: "domain", adminEmail: "admin_email", plan: "plan", maxUsers: "max_users", modules: "modules", flags: "flags",
      branding: "branding", pinnedVersion: "pinned_version", channel: "channel", expiresAt: "expires_at",
      appPort: "app_port", notes: "notes", active: "active", seedProfile: "seed_profile",
    };
    const sets: string[] = [];
    const values: unknown[] = [c.req.param("id")];
    for (const [k, v] of Object.entries(parsed.data)) {
      if (v === undefined) continue;
      values.push(v);
      sets.push(`${map[k]}=$${values.length}`);
    }
    if (!sets.length) return c.json({ error: "nothing to update" }, 400);
    const r = await pool.query(`update clients set ${sets.join(",")} where id=$1 returning *`, values);
    return r.rowCount ? c.json(publicClient(r.rows[0])) : c.json({ error: "not found" }, 404);
  });

  /** Invalidates the old key: the running install stops validating until it gets the new bundle. */
  app.post("/api/clients/:id/rotate-key", async (c) => {
    const r = await pool.query("update clients set license_key_enc=$2 where id=$1 returning id", [
      c.req.param("id"), encrypt(randomToken(32), config.secret()),
    ]);
    return r.rowCount ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
  });

  app.get("/api/clients/:id/bundle", async (c) => {
    const r = (await pool.query("select * from clients where id=$1", [c.req.param("id")])).rows[0] as Row | undefined;
    if (!r) return c.json({ error: "not found" }, 404);
    const secret = config.secret();
    const zip = buildBundle(
      {
        id: r.id, name: r.name, domain: r.domain, pinnedVersion: r.pinned_version, appPort: r.app_port,
        licenseKey: decrypt(r.license_key_enc, secret), branding: { appName: r.name, ...r.branding },
        adminEmail: r.admin_email, seedProfile: r.seed_profile, initialAdminPassword: derive(secret, "admin", r.id, 20), appSecret: derive(secret, "app", r.id, 48),
      },
      {
        templatesDir: config.bundleTemplatesDir, consoleUrl: config.publicUrl, instanceImage: config.instanceImage,
        updaterImage: config.updaterImage, ghcrUser: config.ghcrUser, ghcrToken: config.ghcrToken,
        secrets: JSON.parse(decrypt(r.secrets_enc, secret)),
      },
    );
    return new Response(Buffer.from(zip), {
      headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="nexo-${r.id}.zip"` },
    });
  });

  app.get("/api/fleet", async (c) => {
    const [clients, releases] = await Promise.all([
      pool.query("select * from clients order by name"),
      pool.query("select version from releases"),
    ]);
    const latest = (releases.rows as Row[]).map((r) => r.version as string).sort(compareVersions).pop() ?? null;
    return c.json({
      latestRelease: latest,
      clients: (clients.rows as Row[]).map((r) => {
        const seen = r.last_seen_at ? Date.now() - new Date(r.last_seen_at).getTime() : null;
        return {
          ...publicClient(r),
          status: !r.active ? "suspended" : seen === null ? "never" : seen > 2 * 3_600_000 ? "offline" : r.last_health === "degraded" ? "degraded" : "online",
          behindPinned: Boolean(r.last_version) && compareVersions(r.pinned_version, r.last_version) > 0,
        };
      }),
    });
  });

  app.use("/*", adminAuth);
  app.use("/*", serveStatic({ root: config.publicDir }));
  return app;
}
