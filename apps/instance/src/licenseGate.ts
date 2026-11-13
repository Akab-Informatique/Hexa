import type { MiddlewareHandler } from "hono";
import * as license from "./license.ts";

/**
 * API paths that stay reachable while the license is unusable, so the client can see why.
 * Everything else under /api/ is refused, sign-in (/api/auth/login) included.
 */
export const LICENSE_ALLOW_LIST = new Set([
  "/api/health",
  "/api/config",
  "/api/auth/me",
  "/api/auth/logout",
  "/api/ping",
]);

export const LICENSE_MESSAGE = "Service suspendu. Contactez votre fournisseur.";

/** True when the path is an /api/ route that a suspended license must refuse. */
export function isGatedPath(path: string): boolean {
  const p = path.length > 1 ? path.replace(/\/+$/, "") : path;
  return p.startsWith("/api/") && !LICENSE_ALLOW_LIST.has(p);
}

/** Refuses gated /api/* requests with 402 while the license is not usable. */
export const licenseGate: MiddlewareHandler = async (c, next) => {
  if (!isGatedPath(c.req.path)) return next();
  const s = license.status();
  if (s.usable) return next();
  return c.json({ error: "license", reason: s.reason ?? "invalid", message: LICENSE_MESSAGE }, 402);
};
