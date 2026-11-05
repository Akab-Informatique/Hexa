import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.ts";

// The "state" of an OAuth sign-in: signed with APP_SECRET, tied to one person and one provider, valid ten minutes.
// It is what stops a stranger from finishing someone else's sign-in with their own account.
const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const sig = (purpose: string, data: string) => createHmac("sha256", config.appSecret).update(`${purpose}-state:${data}`).digest("base64url");

export function signState(purpose: string, userId: string, now = Date.now()): string {
  const p = b64u(JSON.stringify({ u: userId, exp: now + 10 * 60_000 }));
  return `${p}.${sig(purpose, p)}`;
}

export function readState(purpose: string, state: string, now = Date.now()): string | null {
  const [p, s] = state.split(".");
  if (!p || !s) return null;
  const a = Buffer.from(sig(purpose, p)), b = Buffer.from(s);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try { const v = JSON.parse(Buffer.from(p, "base64url").toString()) as { u: string; exp: number }; return v.exp > now ? v.u : null; } catch { return null; }
}
