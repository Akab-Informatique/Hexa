import { BrandingSchema, type Branding } from "@nexo/shared";

const e = process.env;

function envBranding(): Branding {
  try {
    return BrandingSchema.parse(e.BRANDING_JSON ? JSON.parse(e.BRANDING_JSON) : {});
  } catch {
    return BrandingSchema.parse({});
  }
}

export const config = {
  port: Number(e.PORT ?? 3000),
  version: e.APP_VERSION ?? "0.0.0-dev",
  databaseUrl:
    e.DATABASE_URL ??
    `postgres://${e.POSTGRES_USER ?? "nexo"}:${encodeURIComponent(e.POSTGRES_PASSWORD ?? "")}` +
      `@${e.POSTGRES_HOST ?? "localhost"}:${e.POSTGRES_PORT ?? "5432"}/${e.POSTGRES_DB ?? "nexo"}`,
  /** Identity + license. When CONSOLE_URL is unset the instance runs unlicensed (local dev only). */
  clientId: e.CLIENT_ID ?? "",
  licenseKey: e.LICENSE_KEY ?? "",
  consoleUrl: (e.CONSOLE_URL ?? "").replace(/\/$/, ""),
  /** How long the app keeps working if the console cannot be reached. */
  graceHours: Number(e.LICENSE_GRACE_HOURS ?? 72),
  checkIntervalMinutes: Number(e.LICENSE_CHECK_MINUTES ?? 60),
  updaterUrl: (e.UPDATER_URL ?? "").replace(/\/$/, ""),
  updaterToken: e.UPDATER_TOKEN ?? "",
  adminToken: e.INSTANCE_ADMIN_TOKEN ?? "",
  modulesDir: e.MODULES_DIR ?? "modules",
  migrationsDir: e.MIGRATIONS_DIR ?? "apps/instance/migrations",
  fallbackBranding: envBranding(),
  isProd: e.NODE_ENV === "production",
  /** Encrypts TOTP secrets and integration credentials at rest. Required in production. */
  appSecret: e.APP_SECRET ?? (e.NODE_ENV === "production" ? "" : "dev-only-app-secret-change-me"),
  requireMfa: (e.REQUIRE_MFA ?? (e.NODE_ENV === "production" ? "true" : "false")) === "true",
  /** First-run master administrator (created only when there are no users yet). */
  initialAdminEmail: e.INITIAL_ADMIN_EMAIL ?? "",
  initialAdminPassword: e.INITIAL_ADMIN_PASSWORD ?? "",
  /** Demo data seeded once on a brand-new install: none | accounting | bookkeeping | tax. */
  seedProfile: e.SEED_PROFILE ?? "none",
  webDir: e.WEB_DIR ?? "apps/web/dist",
  /** Extra browser origins allowed to call the API (the Vite dev server only). */
  devOrigins: (e.DEV_ORIGINS ?? "").split(",").filter(Boolean),
};
