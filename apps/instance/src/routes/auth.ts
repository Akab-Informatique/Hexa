import { Hono } from "hono";
import * as OTPAuth from "otpauth";
import QRCode from "qrcode";
import { z } from "zod";
import { config } from "../config.ts";
import { pool } from "../db.ts";
import { audit } from "../auth/access.ts";
import { hashPassword, MIN_PASSWORD, seal, sha256, unseal, verifyPassword } from "../auth/crypto.ts";
import { clientIp, createSession, destroySession, requireStage, type Env } from "../auth/session.ts";
import * as license from "../license.ts";

const MAX_FAILS = 5;
const LOCK_MINUTES = 15;
const ipHits = new Map<string, number[]>();

/** Per-IP throttle on top of the per-account lockout: 20 attempts / 10 minutes. */
function throttled(ip: string): boolean {
  const now = Date.now();
  const hits = (ipHits.get(ip) ?? []).filter((t) => now - t < 600_000);
  hits.push(now);
  ipHits.set(ip, hits);
  return hits.length > 20;
}

const totp = (secretB32: string, email: string) =>
  new OTPAuth.TOTP({ issuer: license.current().branding.appName, label: email, secret: OTPAuth.Secret.fromBase32(secretB32) });

const toPublicUser = (a: { user: { id: string; email: string; name: string; kind: string; locale: string; isMaster: boolean; totpEnabled: boolean; clientId: string | null } }) => a.user;

export const authRoutes = new Hono<Env>();

authRoutes.get("/me", (c) => {
  const a = c.get("auth");
  if (!a) return c.json({ stage: "anonymous" });
  return c.json({ stage: a.stage, user: toPublicUser(a), rights: a.rights, mfaRequired: config.requireMfa });
});

authRoutes.post("/login", async (c) => {
  const ip = clientIp(c);
  if (throttled(ip)) return c.json({ error: "too many attempts" }, 429);
  const body = z.object({ email: z.string().email(), password: z.string().min(1) }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid credentials" }, 401);
  const r = await pool.query("select * from users where lower(email) = lower($1)", [body.data.email]);
  const u = r.rows[0];
  const fail = async () => {
    if (u) {
      const fails = u.failed_logins + 1;
      await pool.query("update users set failed_logins = $2, locked_until = $3 where id = $1", [
        u.id, fails, fails >= MAX_FAILS ? new Date(Date.now() + LOCK_MINUTES * 60_000) : u.locked_until,
      ]);
    }
    await audit("login.failed", { userId: u?.id, target: body.data.email, ip });
    return c.json({ error: "invalid credentials" }, 401);
  };
  // Same work and same answer whether the account exists, is locked or the password is wrong.
  const ok = u ? await verifyPassword(body.data.password, u.password_hash) : (await hashPassword("x"), false);
  if (!u || !ok || !u.active || (u.locked_until && new Date(u.locked_until) > new Date())) return fail();
  await pool.query("update users set failed_logins = 0, locked_until = null, last_login_at = now() where id = $1", [u.id]);
  await createSession(c, u.id, false);
  await audit("login.ok", { userId: u.id, ip });
  const stage = u.totp_enabled ? "mfa" : config.requireMfa ? "mfa-setup" : u.must_change_password ? "password" : "ready";
  return c.json({ stage });
});

authRoutes.post("/logout", async (c) => {
  await destroySession(c);
  return c.json({ ok: true });
});

// ---- Second factor ----
authRoutes.post("/mfa/verify", requireStage("mfa"), async (c) => {
  const a = c.get("auth")!;
  const { code } = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(await c.req.json().catch(() => ({})));
  const r = await pool.query("select totp_secret_enc from users where id = $1", [a.user.id]);
  const secret = unseal(r.rows[0].totp_secret_enc, config.appSecret);
  if (totp(secret, a.user.email).validate({ token: code, window: 1 }) === null) {
    await audit("mfa.failed", { userId: a.user.id, ip: clientIp(c) });
    return c.json({ error: "invalid code" }, 401);
  }
  await pool.query("update sessions set mfa_verified = true where id = $1", [a.sessionId]);
  return c.json({ stage: a.user.mustChangePassword ? "password" : "ready" });
});

authRoutes.post("/mfa/setup", requireStage("mfa-setup", "ready", "password"), async (c) => {
  const a = c.get("auth")!;
  if (a.user.totpEnabled) return c.json({ error: "already enabled" }, 409);
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  await pool.query("update users set totp_secret_enc = $2 where id = $1", [a.user.id, seal(secret, config.appSecret)]);
  const uri = totp(secret, a.user.email).toString();
  return c.json({ secret, uri, qr: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) });
});

authRoutes.post("/mfa/enable", requireStage("mfa-setup", "ready", "password"), async (c) => {
  const a = c.get("auth")!;
  const { code } = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(await c.req.json().catch(() => ({})));
  const r = await pool.query("select totp_secret_enc from users where id = $1", [a.user.id]);
  if (!r.rows[0]?.totp_secret_enc) return c.json({ error: "start setup first" }, 409);
  const secret = unseal(r.rows[0].totp_secret_enc, config.appSecret);
  if (totp(secret, a.user.email).validate({ token: code, window: 1 }) === null) return c.json({ error: "invalid code" }, 401);
  await pool.query("update users set totp_enabled = true where id = $1", [a.user.id]);
  await pool.query("update sessions set mfa_verified = true where id = $1", [a.sessionId]);
  await audit("mfa.enabled", { userId: a.user.id });
  return c.json({ stage: a.user.mustChangePassword ? "password" : "ready" });
});

// ---- Password ----
authRoutes.post("/password", requireStage("password", "ready"), async (c) => {
  const a = c.get("auth")!;
  const body = z.object({ current: z.string(), next: z.string().min(MIN_PASSWORD) }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: `password must be at least ${MIN_PASSWORD} characters` }, 400);
  const r = await pool.query("select password_hash from users where id = $1", [a.user.id]);
  if (!(await verifyPassword(body.data.current, r.rows[0].password_hash))) return c.json({ error: "current password is wrong" }, 401);
  if (body.data.current === body.data.next) return c.json({ error: "choose a different password" }, 400);
  await pool.query("update users set password_hash = $2, must_change_password = false where id = $1", [a.user.id, await hashPassword(body.data.next)]);
  // Drop every other session of this user.
  await pool.query("delete from sessions where user_id = $1 and id <> $2", [a.user.id, a.sessionId]);
  await audit("password.changed", { userId: a.user.id, ip: clientIp(c) });
  return c.json({ stage: "ready" });
});

authRoutes.post("/locale", requireStage("ready", "password", "mfa-setup"), async (c) => {
  const { locale } = z.object({ locale: z.enum(["fr", "en"]) }).parse(await c.req.json().catch(() => ({})));
  await pool.query("update users set locale = $2 where id = $1", [c.get("auth")!.user.id, locale]);
  return c.json({ ok: true });
});

// ---- One-time link (client portal welcome email): choose a password without knowing the current one ----
authRoutes.post("/set-password", async (c) => {
  const ip = clientIp(c);
  if (throttled(ip)) return c.json({ error: "too many attempts" }, 429);
  const b = z.object({ token: z.string().min(20).max(200), password: z.string().min(MIN_PASSWORD) }).safeParse(await c.req.json().catch(() => null));
  if (!b.success) return c.json({ error: `password must be at least ${MIN_PASSWORD} characters` }, 400);
  // Claimed atomically: one use only, and only while valid.
  const t = (await pool.query(
    "update password_tokens set used_at = now() where token_hash = $1 and used_at is null and expires_at > now() returning user_id", [sha256(b.data.token)])).rows[0];
  if (!t) return c.json({ error: "link invalid or expired" }, 410);
  const u = (await pool.query("update users set password_hash = $2, must_change_password = false, failed_logins = 0, locked_until = null where id = $1 and active returning id", [t.user_id, await hashPassword(b.data.password)])).rows[0];
  if (!u) return c.json({ error: "link invalid or expired" }, 410);
  await pool.query("delete from sessions where user_id = $1", [u.id]);
  await audit("password.set_by_link", { userId: u.id, ip });
  return c.json({ ok: true });
});
