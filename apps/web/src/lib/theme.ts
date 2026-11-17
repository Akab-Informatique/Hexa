import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { isSafeIconUrl } from "@hexa/shared";
import { api } from "./api";

export interface Branding {
  appName: string;
  logoUrl?: string;
  faviconUrl?: string;
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
  setTabIcon(b.faviconUrl, b.logoUrl);
}

/** Tab icon: the firm's icon, else its logo, else the page's own default. Only the href is set, and only for https or same-origin paths. */
export function setTabIcon(favicon?: string, logo?: string) {
  const head = document.head;
  const pick = [favicon, logo].find((u) => u && isSafeIconUrl(u));
  head.querySelectorAll('link[data-brand-icon]').forEach((l) => l.remove());
  head.querySelectorAll('link[rel~="icon"]:not([data-brand-icon]), link[rel="apple-touch-icon"]:not([data-brand-icon])').forEach((l) => ((l as HTMLLinkElement).disabled = Boolean(pick)));
  if (!pick) return;
  for (const rel of ["icon", "apple-touch-icon"]) {
    const l = document.createElement("link");
    l.rel = rel; l.setAttribute("data-brand-icon", "1"); l.setAttribute("href", pick);
    head.appendChild(l);
  }
}

export function useBranding(): Branding {
  const q = useQuery({
    queryKey: ["config"],
    queryFn: () => api<{ branding: Branding; version: string }>("/api/config"),
    staleTime: 5 * 60_000,
  });
  const b = q.data?.branding ?? DEFAULT;
  useEffect(() => applyBranding(b), [b.primaryColor, b.accentColor, b.appName, b.faviconUrl, b.logoUrl]);
  return b;
}
