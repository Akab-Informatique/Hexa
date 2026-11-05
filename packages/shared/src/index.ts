import { z } from "zod";

// ---------- Branding (white label) ----------
export const BrandingSchema = z.object({
  appName: z.string().default("Hexa"),
  logoUrl: z.string().optional(),
  // Hexa default: near-black canvas with purple and blue light. Tenants override both.
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#7c3aed"),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#2563eb"),
  supportEmail: z.string().optional(),
});
export type Branding = z.infer<typeof BrandingSchema>;

// ---------- License check (instance -> console) ----------
export const LicenseCheckRequestSchema = z.object({
  clientId: z.string().min(1),
  licenseKey: z.string().min(1),
  version: z.string().min(1),
  health: z.enum(["ok", "degraded"]).default("ok"),
  userCount: z.number().int().nonnegative().optional(),
});
export type LicenseCheckRequest = z.infer<typeof LicenseCheckRequestSchema>;

export const LicenseCheckResponseSchema = z.object({
  valid: z.boolean(),
  reason: z.string().optional(),
  plan: z.string().default("standard"),
  maxUsers: z.number().int().nullable().default(null),
  modules: z.array(z.string()).default([]),
  flags: z.record(z.boolean()).default({}),
  branding: BrandingSchema.default({}),
  pinnedVersion: z.string().default(""),
  channel: z.string().default("stable"),
  expiresAt: z.string().nullable().default(null),
});
export type LicenseCheckResponse = z.infer<typeof LicenseCheckResponseSchema>;

// ---------- Versions ----------
export const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;

/** Compare semver-ish strings. Returns <0, 0, >0. Pre-release sorts before release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = "", pre] = v.split("-", 2);
    return { nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d !== 0) return d;
  }
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

// ---------- Module contract ----------
export interface ModuleContext {
  /** Sub-app is mounted at /api/modules/<name>. */
  app: import("hono").Hono;
  db: import("pg").Pool;
  flags: Record<string, boolean>;
  log: (msg: string) => void;
}
export interface HexaModule {
  name: string;
  /** Optional folder of .sql files applied before register(). */
  migrationsDir?: string;
  register(ctx: ModuleContext): void | Promise<void>;
}

// ---------- Updater API ----------
export type UpdaterState = "idle" | "running" | "success" | "failed" | "rolled_back";
export interface UpdaterStatus {
  state: UpdaterState;
  from?: string;
  to?: string;
  step?: string;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}
