import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

export interface Branding {
  appName: string;
  logoUrl?: string;
  primaryColor: string;
  accentColor: string;
  supportEmail?: string;
}

const DEFAULT: Branding = { appName: "Hexa", primaryColor: "#7c3aed", accentColor: "#2563eb" };

/** The tenant's branding drives two CSS variables; the stylesheet derives every glow and tint from them. */
export function applyBranding(b: Branding) {
  const root = document.documentElement;
  root.style.setProperty("--brand", b.primaryColor);
  root.style.setProperty("--brand-2", b.accentColor);
  document.title = b.appName;
}

export function useBranding(): Branding {
  const q = useQuery({
    queryKey: ["config"],
    queryFn: () => api<{ branding: Branding; version: string }>("/api/config"),
    staleTime: 5 * 60_000,
  });
  const b = q.data?.branding ?? DEFAULT;
  useEffect(() => applyBranding(b), [b.primaryColor, b.accentColor, b.appName]);
  return b;
}
