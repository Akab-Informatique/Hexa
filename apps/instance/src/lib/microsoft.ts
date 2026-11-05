import { pool } from "../db.ts";
import { config } from "../config.ts";
import { seal, unseal } from "../auth/crypto.ts";
import { readState as readOauthState, signState as signOauthState } from "./oauthState.ts";
import { http, loadIntegration, redirectUri, ServiceError, URLS } from "./services.ts";

// Each person signs in to their own Microsoft 365 account through the firm's Entra app (delegated, authorization code).
// Only the refresh token is kept (sealed); a signed, short-lived "state" ties the return trip to the person who started it.
// Read-only: calendar and inbox. The app registration needs the redirect address shown on the integration page.
export const MS_SCOPES = "offline_access openid profile User.Read Calendars.Read Mail.Read";
export const MS_CALLBACK = "/api/microsoft/callback";

export async function msApp(): Promise<{ tenantId: string; clientId: string; clientSecret: string } | null> {
  const m = await loadIntegration("o365");
  if (!m.enabled || !m.config.tenantId || !m.config.clientId || !m.secrets.clientSecret) return null;
  return { tenantId: m.config.tenantId, clientId: m.config.clientId, clientSecret: m.secrets.clientSecret };
}

export const signState = (userId: string, now?: number) => signOauthState("ms", userId, now);
export const readState = (state: string, now?: number) => readOauthState("ms", state, now);

export async function authorizeUrl(userId: string): Promise<string> {
  const app = await msApp();
  if (!app) throw new ServiceError(409, "microsoft_not_configured");
  if (!config.publicUrl) throw new ServiceError(409, "public_url_missing");
  const q = new URLSearchParams({ client_id: app.clientId, response_type: "code", redirect_uri: redirectUri(MS_CALLBACK), response_mode: "query", scope: MS_SCOPES, state: signState(userId), prompt: "select_account" });
  return `${URLS.msLogin()}/${encodeURIComponent(app.tenantId)}/oauth2/v2.0/authorize?${q}`;
}

interface Tokens { access_token: string; refresh_token?: string; expires_in: number }
async function tokenCall(app: NonNullable<Awaited<ReturnType<typeof msApp>>>, params: Record<string, string>): Promise<Tokens> {
  const res = await http(`${URLS.msLogin()}/${encodeURIComponent(app.tenantId)}/oauth2/v2.0/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: app.clientId, client_secret: app.clientSecret, scope: MS_SCOPES, ...params }),
  });
  const j = (await res.json().catch(() => null)) as (Tokens & { error?: string; error_description?: string }) | null;
  if (!res.ok || !j?.access_token) throw new ServiceError(res.status === 400 || res.status === 401 ? 401 : 502, j?.error === "invalid_grant" ? "ms_reauth" : "microsoft_refused", j?.error_description?.slice(0, 200));
  return j;
}

/** Finishes the sign-in: trades the code for tokens, reads the person's address, keeps the refresh token. */
export async function completeSignIn(userId: string, code: string): Promise<string> {
  const app = await msApp();
  if (!app) throw new ServiceError(409, "microsoft_not_configured");
  const t = await tokenCall(app, { grant_type: "authorization_code", code, redirect_uri: redirectUri(MS_CALLBACK) });
  if (!t.refresh_token) throw new ServiceError(502, "microsoft_no_refresh_token");
  const me = await http(`${URLS.graph()}/me?$select=mail,userPrincipalName,displayName`, { headers: { authorization: `Bearer ${t.access_token}` } });
  const mj = (await me.json().catch(() => ({}))) as { mail?: string; userPrincipalName?: string };
  const email = mj.mail ?? mj.userPrincipalName ?? "";
  await pool.query(
    `insert into ms_connections (user_id, email, refresh_enc, access_enc, expires_at, needs_reauth, connected_at) values ($1,$2,$3,$4, now() + ($5 || ' seconds')::interval, false, now())
     on conflict (user_id) do update set email = excluded.email, refresh_enc = excluded.refresh_enc, access_enc = excluded.access_enc, expires_at = excluded.expires_at, needs_reauth = false, connected_at = now()`,
    [userId, email, seal(t.refresh_token, config.appSecret), seal(t.access_token, config.appSecret), String(t.expires_in)]);
  return email;
}

export async function connectionOf(userId: string) {
  const r = (await pool.query("select email, needs_reauth, connected_at from ms_connections where user_id = $1", [userId])).rows[0];
  return r ? { email: r.email as string, needsReauth: Boolean(r.needs_reauth), connectedAt: r.connected_at as string } : null;
}

async function accessFor(userId: string, force = false): Promise<string> {
  const r = (await pool.query("select refresh_enc, access_enc, expires_at, needs_reauth from ms_connections where user_id = $1", [userId])).rows[0];
  if (!r) throw new ServiceError(409, "ms_not_connected");
  if (r.needs_reauth) throw new ServiceError(401, "ms_reauth");
  if (!force && r.access_enc && r.expires_at && new Date(r.expires_at).getTime() > Date.now() + 60_000) { try { return unseal(r.access_enc, config.appSecret); } catch { /* refresh below */ } }
  const app = await msApp();
  if (!app) throw new ServiceError(409, "microsoft_not_configured");
  try {
    const t = await tokenCall(app, { grant_type: "refresh_token", refresh_token: unseal(r.refresh_enc, config.appSecret) });
    await pool.query("update ms_connections set access_enc = $2, expires_at = now() + ($3 || ' seconds')::interval, refresh_enc = coalesce($4, refresh_enc) where user_id = $1",
      [userId, seal(t.access_token, config.appSecret), String(t.expires_in), t.refresh_token ? seal(t.refresh_token, config.appSecret) : null]);
    return t.access_token;
  } catch (e) {
    // A refused refresh token means the person has to sign in again (password change, access removed...).
    if (e instanceof ServiceError && e.code === "ms_reauth") await pool.query("update ms_connections set needs_reauth = true where user_id = $1", [userId]);
    throw e;
  }
}

/** One read from Graph. A 401 first gets a fresh token (the stored one may have been revoked early); only a refusal of that asks for a new sign-in. */
export async function graphGet(userId: string, path: string, headers: Record<string, string> = {}): Promise<unknown> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await http(`${URLS.graph()}${path}`, { headers: { authorization: `Bearer ${await accessFor(userId, attempt > 0)}`, accept: "application/json", ...headers } });
    if (res.status === 401 && attempt === 0) continue;
    if (res.status === 401) { await pool.query("update ms_connections set needs_reauth = true where user_id = $1", [userId]); throw new ServiceError(401, "ms_reauth"); }
    if (res.status === 404) throw new ServiceError(404, "not_found");
    if (!res.ok) throw new ServiceError(502, "microsoft_error", `HTTP ${res.status}`);
    return res.json();
  }
  throw new ServiceError(401, "ms_reauth");
}

export interface CalEvent { id: string; subject: string; start: string; end: string; allDay: boolean; location: string; showAs: string; isPrivate: boolean; webLink: string | null }

/** Events of a period, in Quebec time. A private event is only "Busy". */
export async function calendarEvents(userId: string, fromDay: string, toDay: string): Promise<CalEvent[]> {
  const q = new URLSearchParams({ startDateTime: `${fromDay}T00:00:00`, endDateTime: `${toDay}T23:59:59`, $orderby: "start/dateTime", $top: "200", $select: "id,subject,start,end,isAllDay,location,showAs,sensitivity,webLink" });
  const j = (await graphGet(userId, `/me/calendarView?${q}`, { Prefer: 'outlook.timezone="America/Toronto"' })) as { value?: Record<string, any>[] };
  return (j.value ?? []).map((e) => {
    const priv = e.sensitivity === "private" || e.sensitivity === "confidential";
    return { id: e.id, subject: priv ? "" : e.subject ?? "", start: String(e.start?.dateTime ?? "").slice(0, 19), end: String(e.end?.dateTime ?? "").slice(0, 19), allDay: Boolean(e.isAllDay), location: priv ? "" : e.location?.displayName ?? "", showAs: e.showAs ?? "busy", isPrivate: priv, webLink: priv ? null : e.webLink ?? null };
  });
}

const busyCache = new Map<string, { at: number; rows: { title: string; start: string; end: string }[] }>();
/** The busy blocks of a day for the day plan; never throws (a failure just means no Outlook events). */
export async function busyBlocks(userId: string, day: string): Promise<{ title: string; start: string; end: string }[]> {
  const key = `${userId}:${day}`;
  const hit = busyCache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.rows;
  try {
    if (!(await connectionOf(userId))) return [];
    const rows = (await calendarEvents(userId, day, day)).filter((e) => !e.allDay && e.showAs !== "free" && e.showAs !== "workingElsewhere" && e.start.startsWith(day) && e.end.startsWith(day))
      .map((e) => ({ title: e.isPrivate || !e.subject ? "Occupé" : e.subject, start: e.start.slice(11, 16), end: e.end.slice(11, 16) }));
    busyCache.set(key, { at: Date.now(), rows });
    return rows;
  } catch { return []; }
}
