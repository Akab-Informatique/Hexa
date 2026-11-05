import fs from "node:fs";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { randomToken } from "./crypto.ts";

export interface BundleClient {
  id: string;
  name: string;
  domain: string;
  pinnedVersion: string;
  appPort: number;
  licenseKey: string;
  branding: Record<string, unknown>;
  /** First master administrator of the instance (must change the password at first login). */
  adminEmail: string;
  initialAdminPassword: string;
  /** Demo data profile seeded on the first start ("none" = empty). */
  seedProfile?: string;
  /** Encrypts the instance's TOTP secrets and integration credentials. */
  appSecret: string;
}

export interface BundleOptions {
  templatesDir: string;
  consoleUrl: string;
  instanceImage: string;
  updaterImage: string;
  ghcrUser: string;
  ghcrToken: string;
  /** Per-client secrets. Generated at creation and stored in the console so re-downloads match the running install. */
  secrets: { postgresPassword: string; updaterToken: string; adminToken: string };
}

export function newSecrets() {
  return { postgresPassword: randomToken(18), updaterToken: randomToken(24), adminToken: randomToken(24) };
}

const render = (tpl: string, vars: Record<string, string>) =>
  tpl.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
    if (!(k in vars)) throw new Error(`template variable ${k} is not defined`);
    return vars[k] as string;
  });

/** Build the zip a client unpacks on their server: compose file, .env, nginx site, install script, README. */
export function buildBundle(client: BundleClient, opts: BundleOptions): Uint8Array {
  const slug = client.id.replace(/[^a-z0-9]/g, "_");
  const vars: Record<string, string> = {
    CLIENT_ID: client.id,
    CLIENT_NAME: client.name,
    DOMAIN: client.domain,
    APP_PORT: String(client.appPort),
    APP_VERSION: client.pinnedVersion,
    INSTANCE_IMAGE: opts.instanceImage,
    UPDATER_IMAGE: opts.updaterImage,
    CONSOLE_URL: opts.consoleUrl,
    LICENSE_KEY: client.licenseKey,
    COMPOSE_PROJECT_NAME: `nexo_${slug}`,
    POSTGRES_PASSWORD: opts.secrets.postgresPassword,
    UPDATER_TOKEN: opts.secrets.updaterToken,
    INSTANCE_ADMIN_TOKEN: opts.secrets.adminToken,
    INITIAL_ADMIN_EMAIL: client.adminEmail,
    INITIAL_ADMIN_PASSWORD: client.initialAdminPassword,
    APP_SECRET: client.appSecret,
    SEED_PROFILE: client.seedProfile ?? "none",
    GHCR_USER: opts.ghcrUser,
    GHCR_TOKEN: opts.ghcrToken,
    // Single quotes wrap this value in .env, so escape any inside the JSON.
    BRANDING_JSON: JSON.stringify(client.branding).replace(/'/g, "\\u0027"),
  };
  const read = (name: string) => fs.readFileSync(path.join(opts.templatesDir, name), "utf8");
  const files: Record<string, Uint8Array> = {};
  const add = (target: string, template: string) => (files[`nexo-${client.id}/${target}`] = strToU8(render(read(template), vars)));
  add("docker-compose.yml", "docker-compose.yml");
  add(".env", "env.template");
  add(`nginx/${client.domain}.conf`, "nginx.conf.template");
  add("install.sh", "install.sh.template");
  add("README.md", "README.md.template");
  return zipSync(files);
}
