/** Control characters (C0 + DEL) never allowed in a client name. */
// eslint-disable-next-line no-control-regex
export const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

/** Render-time cleanup for names already stored: drop control chars, collapse whitespace. */
export function sanitizeName(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x1f\x7f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
}

const hostOf = (v: string | undefined | null): string | null => {
  if (!v) return null;
  try { return new URL(v).host.toLowerCase(); } catch { return null; }
};

/**
 * Cross-site check for state-changing requests. Returns an error string, or null when allowed.
 * No Origin (curl, CI) is allowed; a present Origin must match this host.
 */
export function csrfViolation(
  method: string,
  h: (name: string) => string | undefined,
  publicUrl: string,
): string | null {
  if (["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())) return null;
  if ((h("sec-fetch-site") ?? "").toLowerCase() === "cross-site") return "cross-site request refused";
  const origin = h("origin");
  if (origin !== undefined) {
    const allowed = new Set<string>();
    for (const v of [h("host"), h("x-forwarded-host")?.split(",")[0]?.trim()]) if (v) allowed.add(v.toLowerCase());
    const pub = hostOf(publicUrl);
    if (pub) allowed.add(pub);
    if (origin === "null" || !allowed.has(hostOf(origin) ?? "\0")) return "cross-origin request refused";
  }
  const hasBody = (h("content-length") ?? "0") !== "0" || h("transfer-encoding") !== undefined;
  if (hasBody && !/^application\/json\s*(;|$)/i.test(h("content-type") ?? "")) return "content-type must be application/json";
  return null;
}

/** Email written unquoted into a sourced .env: no shell metacharacters allowed. */
export const SAFE_EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
