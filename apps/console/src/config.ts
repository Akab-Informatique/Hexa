const e = process.env;

function required(name: string): string {
  const v = e[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

export const config = {
  port: Number(e.PORT ?? 8080),
  databaseUrl:
    e.DATABASE_URL ??
    `postgres://${e.POSTGRES_USER ?? "hexa"}:${encodeURIComponent(e.POSTGRES_PASSWORD ?? "")}` +
      `@${e.POSTGRES_HOST ?? "localhost"}:${e.POSTGRES_PORT ?? "5432"}/${e.POSTGRES_DB ?? "hexa_console"}`,
  adminUser: e.ADMIN_USER ?? "admin",
  adminPassword: () => required("ADMIN_PASSWORD"),
  /** 32+ chars. Encrypts license keys at rest. Losing it means rotating every client's key. */
  secret: () => required("CONSOLE_SECRET"),
  /** Public URL clients use to reach this console (goes into every bundle). */
  publicUrl: (e.PUBLIC_URL ?? "http://localhost:8080").replace(/\/$/, ""),
  /** Base domain for each client's default address, e.g. "hexa.akab.ca" gives "clienta.hexa.akab.ca". Empty = none. */
  clientBaseDomain: (e.CLIENT_BASE_DOMAIN ?? "").trim().toLowerCase().replace(/^\.+|\.+$/g, ""),
  instanceImage: e.INSTANCE_IMAGE ??"ghcr.io/akab-informatique/hexa-instance",
  updaterImage: e.UPDATER_IMAGE ?? "ghcr.io/akab-informatique/hexa-updater",
  /** Read-only GHCR pull credentials handed to each client (optional but needed for private images). */
  ghcrUser: e.GHCR_PULL_USER ?? "",
  ghcrToken: e.GHCR_PULL_TOKEN ?? "",
  /** Release webhook secret, used by CI to register a new version. */
  releaseToken: e.RELEASE_TOKEN ?? "",
  bundleTemplatesDir: e.BUNDLE_TEMPLATES_DIR ?? "deploy/client-bundle",
  migrationsDir: e.MIGRATIONS_DIR ?? "apps/console/migrations",
  publicDir: e.PUBLIC_DIR ?? "apps/console/public",
};
