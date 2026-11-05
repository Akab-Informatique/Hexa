import { pool } from "../db.ts";
import { config } from "../config.ts";
import { open, seal } from "../auth/secrets.ts";

// Addresses of the outside services. In production they are always the real ones; in development they can be pointed
// at the local mock (scripts/mock-services.mjs) with the env variables below, so every integration can be tried offline.
const e = process.env;
const dev = (name: string, real: string) => (config.isProd ? real : (e[name] ?? real).replace(/\/$/, ""));
export const URLS = {
  mailjet: () => dev("MAILJET_URL", "https://api.mailjet.com"),
  graph: () => dev("GRAPH_URL", "https://graph.microsoft.com/v1.0"),
  msLogin: () => dev("MS_LOGIN_URL", "https://login.microsoftonline.com"),
  intuitAuth: () => dev("INTUIT_AUTH_URL", "https://appcenter.intuit.com/connect/oauth2"),
  intuitToken: () => dev("INTUIT_TOKEN_URL", "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer"),
  qbo: (environment: string) => dev("QBO_API_URL", environment === "production" ? "https://quickbooks.api.intuit.com" : "https://sandbox-quickbooks.api.intuit.com"),
};

export interface Integration { config: Record<string, string>; secrets: Record<string, string>; enabled: boolean }

/** The saved settings of one integration, with its secrets opened (never sent to the browser). */
export async function loadIntegration(provider: string): Promise<Integration> {
  const r = (await pool.query("select config, secret_enc, enabled from integrations where provider = $1", [provider])).rows[0];
  return { config: (r?.config ?? {}) as Record<string, string>, secrets: open(r?.secret_enc), enabled: Boolean(r?.enabled) };
}

/** Merges values into an integration's settings and secrets (the credentials form keeps working beside the tokens). */
export async function patchIntegration(provider: string, patch: { config?: Record<string, string>; secrets?: Record<string, string> }, drop: string[] = []) {
  const cur = await loadIntegration(provider);
  const cfg = { ...cur.config, ...(patch.config ?? {}) };
  const sec = { ...cur.secrets, ...(patch.secrets ?? {}) };
  for (const k of drop) { delete cfg[k]; delete sec[k]; }
  await pool.query(
    `insert into integrations (provider, config, secret_enc, enabled, updated_at) values ($1,$2::jsonb,$3,$4,now())
     on conflict (provider) do update set config = excluded.config, secret_enc = excluded.secret_enc, updated_at = now()`,
    [provider, JSON.stringify(cfg), seal(sec), cur.enabled]);
}

/** The address OAuth providers send people back to. */
export const redirectUri = (path: string) => `${config.publicUrl}${path}`;

export class ServiceError extends Error { constructor(public status: number, public code: string, public detail?: string) { super(code); } }

/** fetch with a timeout, so a slow outside service never hangs a request. */
export async function http(url: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try { return await fetch(url, { ...init, signal: ctl.signal }); }
  catch (err) { throw new ServiceError(504, "service_unreachable", err instanceof Error ? err.message : String(err)); }
  finally { clearTimeout(t); }
}
