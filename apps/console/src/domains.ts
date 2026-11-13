import { z } from "zod";

/**
 * Client addresses. Every client has a default address `<id>.<CLIENT_BASE_DOMAIN>` (when the base domain is set)
 * and may add one custom host name, which becomes the primary address the portal is reached at.
 */

/** Lowercase host name: labels of letters/digits/hyphens, at least two labels, last label starts with a letter, max 253. */
export const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Trims and lowercases, then requires a bare host name (no scheme, port, path or spaces). Empty or null means "none". */
export const OptionalHost = z.preprocess(
  (v) => (typeof v === "string" ? (v.trim() === "" ? null : v.trim().toLowerCase()) : v),
  z.string().regex(HOST_RE, "must be a bare host name such as portal.client.com (no http://, no path, lowercase letters, digits, dots and hyphens)").nullable(),
);

export interface DomainRow {
  id: string;
  domain: string;
  customDomain: string | null;
}

/** Default address of a client: `<id>.<base>` when the base is set, else the address the client was created with. */
export function defaultDomainOf(row: { id: string; domain: string; customDomain?: string | null }, base: string): string {
  return base ? `${row.id}.${base}` : row.domain;
}

/** Address the portal is reached at: the custom host name when set, else the default address. */
export function primaryDomainOf(row: { id: string; domain: string; customDomain: string | null }, base: string): string {
  return row.customDomain || defaultDomainOf(row, base);
}

/**
 * Checks a candidate address against the other clients. Returns a machine-readable code and a message, or null.
 * kind "default": the candidate is a client's default address (or the plain domain when no base is set).
 * kind "custom": the candidate is a client's custom host name.
 */
export function domainConflict(
  candidate: string,
  kind: "default" | "custom",
  others: DomainRow[],
  base: string,
): { code: string; message: string } | null {
  if (kind === "custom" && base && candidate.endsWith(`.${base}`))
    return { code: "domain_reserved", message: `names ending in .${base} are reserved for default client addresses` };
  const taken = others.some((o) => defaultDomainOf(o, base) === candidate || o.customDomain === candidate);
  if (taken) return { code: kind === "custom" ? "custom_domain_taken" : "domain_taken", message: `${candidate} is already used by another client` };
  return null;
}

/** Throws when CLIENT_BASE_DOMAIN is set but is not a valid host name. */
export function checkBaseDomain(base: string): string {
  if (base && !HOST_RE.test(base)) throw new Error(`CLIENT_BASE_DOMAIN "${base}" is not a valid host name (e.g. hexa.akab.ca)`);
  return base;
}
