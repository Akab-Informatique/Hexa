import { LicenseCheckResponseSchema, type LicenseCheckResponse } from "@hexa/shared";
import { config } from "./config.ts";
import { getSetting, setSetting } from "./db.ts";

interface Cache {
  response: LicenseCheckResponse;
  lastOkAt: number;
}

/** Stable codes the UI and the API clients can rely on. */
export type LicenseReason = "suspended" | "expired" | "unknown_key" | "unreachable" | "not_verified" | "invalid";

let cache: Cache | undefined;
let lastError: string | undefined;

const licensingEnabled = () => Boolean(config.consoleUrl && config.clientId && config.licenseKey);

/** Cached answer from the console (or a permissive default in local dev). */
export function current(): LicenseCheckResponse {
  if (cache) return cache.response;
  return LicenseCheckResponseSchema.parse({ valid: !licensingEnabled(), branding: config.fallbackBranding });
}

/** Maps the console's free-text refusal (see apps/console /api/license/check) to a stable code. */
function consoleReason(raw: string | undefined): LicenseReason {
  if (!raw) return "invalid";
  if (/suspend/i.test(raw)) return "suspended";
  if (/expir/i.test(raw)) return "expired";
  if (/unknown client|key/i.test(raw)) return "unknown_key";
  return "invalid";
}

/**
 * The app is usable when the console last said "valid" and that answer is fresher than the
 * grace period. A console outage therefore never locks clients out immediately, but an
 * explicit "invalid" (unpaid, revoked, expired) locks at once.
 */
export function status(): { usable: boolean; reason?: LicenseReason; lastOkAt?: string; lastError?: string } {
  if (!licensingEnabled()) return { usable: true };
  if (!cache) return { usable: false, reason: "not_verified", lastError };
  const base = { lastOkAt: new Date(cache.lastOkAt).toISOString(), lastError };
  if (!cache.response.valid) return { usable: false, reason: consoleReason(cache.response.reason), ...base };
  if (Date.now() - cache.lastOkAt > config.graceHours * 3_600_000) {
    return { usable: false, reason: "unreachable", ...base };
  }
  return { usable: true, ...base };
}

/** Public, non-sensitive license state for /api/config (no keys, no timestamps). */
export function publicLicense(): { usable: boolean; reason?: LicenseReason } {
  const s = status();
  return s.usable ? { usable: true } : { usable: false, reason: s.reason };
}

export async function loadCached(): Promise<void> {
  const stored = await getSetting<{ response: unknown; lastOkAt: number }>("license_cache");
  if (!stored) return;
  const parsed = LicenseCheckResponseSchema.safeParse(stored.response);
  if (parsed.success) cache = { response: parsed.data, lastOkAt: stored.lastOkAt };
}

/**
 * Only an HTTP 200 answer changes the cached license. Anything else (4xx, 5xx, network error,
 * bad body) is "console unreachable": the last good answer keeps working for the grace period.
 */
export async function check(health: "ok" | "degraded" = "ok"): Promise<void> {
  if (!licensingEnabled()) return;
  try {
    const res = await fetch(`${config.consoleUrl}/api/license/check`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientId: config.clientId,
        licenseKey: config.licenseKey,
        version: config.version,
        health,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status !== 200) throw new Error(`console responded ${res.status}`);
    const parsed = LicenseCheckResponseSchema.parse(await res.json());
    // A refusal carries no branding of its own: keep the firm's last look so the suspended screen is still theirs.
    const kept = !parsed.valid && cache?.response.valid ? { ...parsed, branding: cache.response.branding } : parsed;
    cache = { response: kept, lastOkAt: Date.now() };
    lastError = undefined;
    await setSetting("license_cache", cache);
  } catch (err) {
    lastError = (err as Error).message;
    console.warn(`[license] check failed: ${lastError}`);
  }
}

export function startPeriodicCheck(): void {
  if (!licensingEnabled()) return;
  setInterval(() => void check(), config.checkIntervalMinutes * 60_000).unref();
}
