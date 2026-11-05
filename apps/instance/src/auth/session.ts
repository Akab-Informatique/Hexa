import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { hasPermission, type Audience } from "@nexo/shared/permissions";
import { config } from "../config.ts";
import { pool } from "../db.ts";
import { randomToken, sha256 } from "./crypto.ts";
import { rightsOf } from "./access.ts";

const COOKIE = "nexo_session";
const ABSOLUTE_MS = 12 * 3_600_000;
const IDLE_MS = 4 * 3_600_000;

export interface AuthUser {
  id: string; email: string; name: string; kind: Audience; clientId: string | null;
  locale: string; isMaster: boolean; mustChangePassword: boolean; totpEnabled: boolean;
}
export type Stage = "anonymous" | "mfa" | "mfa-setup" | "password" | "ready";
export interface AuthCtx { stage: Stage; sessionId: string; user: AuthUser; rights: string[] }
export type Env = { Variables: { auth?: AuthCtx } };

export async function createSession(c: Context, userId: string, mfaVerified: boolean): Promise<void> {
  const token = randomToken(32);
  await pool.query(
    `insert into sessions (user_id, token_hash, mfa_verified, ip, user_agent, expires_at)
     values ($1, $2, $3, $4, $5, now() + ($6 || ' milliseconds')::interval)`,
    [userId, sha256(token), mfaVerified, clientIp(c), (c.req.header("user-agent") ?? "").slice(0, 200), String(ABSOLUTE_MS)],
  );
  setCookie(c, COOKIE, token, { httpOnly: true, sameSite: "Lax", secure: config.isProd, path: "/", maxAge: ABSOLUTE_MS / 1000 });
}

export async function destroySession(c: Context): Promise<void> {
  const token = getCookie(c, COOKIE);
  if (token) await pool.query("delete from sessions where token_hash = $1", [sha256(token)]);
  deleteCookie(c, COOKIE, { path: "/" });
}

export const clientIp = (c: Context) => (c.req.header("x-forwarded-for") ?? "").split(",")[0]?.trim() || "local";

function stageOf(user: AuthUser, mfaVerified: boolean): Stage {
  if (user.totpEnabled && !mfaVerified) return "mfa";
  if (!user.totpEnabled && config.requireMfa) return "mfa-setup";
  if (user.mustChangePassword) return "password";
  return "ready";
}

/** Loads the session (if any) into c.var.auth. Never rejects: routes decide what they require. */
export const loadAuth: MiddlewareHandler<Env> = async (c, next) => {
  const token = getCookie(c, COOKIE);
  if (token) {
    const r = await pool.query(
      `select s.id as sid, s.mfa_verified, s.last_seen_at, u.*
         from sessions s join users u on u.id = s.user_id
        where s.token_hash = $1 and s.expires_at > now() and u.active`,
      [sha256(token)],
    );
    const row = r.rows[0];
    if (row && Date.now() - new Date(row.last_seen_at).getTime() < IDLE_MS) {
      await pool.query("update sessions set last_seen_at = now() where id = $1", [row.sid]);
      const user: AuthUser = {
        id: row.id, email: row.email, name: row.name, kind: row.kind, clientId: row.client_id, locale: row.locale,
        isMaster: row.is_master, mustChangePassword: row.must_change_password, totpEnabled: row.totp_enabled,
      };
      const stage = stageOf(user, row.mfa_verified);
      c.set("auth", { stage, sessionId: row.sid, user, rights: stage === "ready" ? await rightsOf({ id: user.id, kind: user.kind, is_master: user.isMaster }) : [] });
    }
  }
  await next();
};

export const requireStage = (...stages: Stage[]): MiddlewareHandler<Env> => async (c, next) => {
  const a = c.get("auth");
  if (!a || !stages.includes(a.stage)) return c.json({ error: "unauthorized" }, 401);
  await next();
};

export const requireReady = requireStage("ready");

/** Staff-only area guard with OR semantics: any one of the listed rights is enough. */
export const requirePermission = (...keys: string[]): MiddlewareHandler<Env> => async (c, next) => {
  const a = c.get("auth");
  if (!a || a.stage !== "ready") return c.json({ error: "unauthorized" }, 401);
  if (a.user.kind !== "staff" || !keys.some((k) => hasPermission(a.rights, k))) return c.json({ error: "forbidden" }, 403);
  await next();
};

/** Cross-site request guard for state-changing calls (cookie auth + SameSite=Lax + origin check). */
export const sameOriginWrites: MiddlewareHandler = async (c, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    const origin = c.req.header("origin");
    const host = c.req.header("x-forwarded-host") ?? c.req.header("host");
    if (origin && host && new URL(origin).host !== host && !config.devOrigins.includes(new URL(origin).origin)) {
      return c.json({ error: "cross-origin request refused" }, 403);
    }
    // File uploads are raw bytes; the custom header cannot be sent cross-site without a CORS preflight, so it is as safe as JSON.
    const upload = c.req.header("x-nexo-upload") === "1" && (c.req.header("content-type") ?? "").startsWith("application/octet-stream");
    if (!upload && c.req.header("content-length") !== "0" && c.req.raw.body && !(c.req.header("content-type") ?? "").includes("json")) {
      return c.json({ error: "json required" }, 415);
    }
  }
  await next();
};
