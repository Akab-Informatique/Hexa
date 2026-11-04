import { LicenseCheckResponseSchema, type LicenseCheckResponse } from "@nexo/shared";
import { config } from "./config.ts";
import { getSetting, setSetting } from "./db.ts";

interface Cache {
  response: LicenseCheckResponse;
  lastOkAt: number;
}

let cache: Cache | undefined;
let lastError: string | undefined;

const licensingEnabled = () => Boolean(config.consoleUrl && config.clientId && config.licenseKey);

/** Cached answer from the console (or a permissive default in local dev). */
export function current(): LicenseCheckResponse {
  if (cache) return cache.response;
  return LicenseCheckResponseSchema.parse({ valid: !licensingEnabled(), branding: config.fallbackBranding });
}

/**
 * The app is usable when the console last said "valid" and that answer is fresher than the
 * grace period. A console outage therefore never locks clients out immediately, but an
 * explicit "invalid" (unpaid, revoked, expired) locks at once.
 */
export function status(): { usable: boolean; reason?: string; lastOkAt?: string; lastError?: string } {
  if (!licensingEnabled()) return { usable: true, reason: "unlicensed (dev mode)" };
  if (!cache) return { usable: false, reason: "license not yet verified", lastError };
  const base = { lastOkAt: new Date(cache.lastOkAt).toISOString(), lastError };
  if (!cache.response.valid) return { usable: false, reason: cache.response.reason ?? "license invalid", ...base };
  if (Date.now() - cache.lastOkAt > config.graceHours * 3_600_000) {
    return { usable: false, reason: "license server unreachable beyond grace period", ...base };
  }
  return { usable: true, ...base };
}

export async function loadCached(): Promise<void> {
  const stored = await getSetting<{ response: unknown; lastOkAt: number }>("license_cache");
  if (!stored) return;
  const parsed = LicenseCheckResponseSchema.safeParse(stored.response);
  if (parsed.success) cache = { response: parsed.data, lastOkAt: stored.lastOkAt };
}

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
    if (res.status >= 500) throw new Error(`console responded ${res.status}`);
    const parsed = LicenseCheckResponseSchema.parse(await res.json());
    cache = { response: parsed, lastOkAt: Date.now() };
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
