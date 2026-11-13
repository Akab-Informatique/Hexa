import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

export type LicenseReason = "suspended" | "expired" | "unknown_key" | "unreachable" | "not_verified" | "invalid";

export interface License {
  usable: boolean;
  reason?: LicenseReason;
}

/** Reads the license state from /api/config (same query as useBranding, so no extra request). */
export function useLicense(): License {
  const q = useQuery({
    queryKey: ["config"],
    queryFn: () => api<{ branding: unknown; version: string; license?: License }>("/api/config"),
    staleTime: 5 * 60_000,
  });
  // Until the config arrives we assume usable, so the login screen never flashes the suspended notice.
  return q.data?.license ?? { usable: true };
}
