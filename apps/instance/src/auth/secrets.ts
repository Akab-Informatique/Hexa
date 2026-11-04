import { config } from "../config.ts";
import { seal as sealWith, unseal } from "./crypto.ts";

/** Seals a JSON object of credentials with APP_SECRET. */
export const seal = (obj: Record<string, string>) => sealWith(JSON.stringify(obj), config.appSecret);
export const open = (payload: string | null | undefined): Record<string, string> => {
  if (!payload) return {};
  try { return JSON.parse(unseal(payload, config.appSecret)) as Record<string, string>; } catch { return {}; }
};
