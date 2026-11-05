import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { FolderOpen, Home, LogOut, Menu, Receipt, ScrollText, Settings, X } from "lucide-react";
import { useAuth } from "../lib/auth";
import { api } from "../lib/api";
import { useL } from "../lib/l";
import { useBranding } from "../lib/theme";
import { BrandMark, LanguageToggle } from "../components/ui";

/** What a client user sees: the firm's branding, a short menu, only the pages their rights allow. */
export const CLIENT_NAV = [
  { path: "/", right: "clientportal.view", icon: Home, fr: "Accueil", en: "Home" },
  { path: "/invoices", right: "clientportal.invoices.view", icon: Receipt, fr: "Factures", en: "Invoices" },
  { path: "/contracts", right: "clientportal.contracts.view", icon: ScrollText, fr: "Contrats", en: "Contracts" },
  { path: "/documents", right: "clientportal.docs.view", icon: FolderOpen, fr: "Documents", en: "Documents" },
  { path: "/settings", right: "clientportal.view", icon: Settings, fr: "Mon compte", en: "My account" },
] as const;

export default function ClientShell() {
  const { t } = useTranslation();
  const l = useL();
  const { me, can, logout } = useAuth();
  const brand = useBranding();
  const { pathname } = useLocation();
  const [drawer, setDrawer] = useState(false);
  useEffect(() => setDrawer(false), [pathname]);
  const items = CLIENT_NAV.filter((i) => can(i.right));

  const sidebar = (
    <aside className="glass flex h-full w-64 flex-col p-4" aria-label="Navigation">
      <div className="mb-5 flex items-center gap-3 px-1">
        <BrandMark name={brand.appName} logoUrl={brand.logoUrl} />
        <div className="min-w-0"><div className="truncate text-base font-semibold tracking-tight">{brand.appName}</div><div className="text-xs text-muted">{l("Portail client", "Client portal")}</div></div>
      </div>
      <nav className="flex-1 space-y-1">
        {items.map((i) => (
          <NavLink key={i.path} to={i.path} end={i.path === "/"} className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}>
            <i.icon size={16} /><span>{l(i.fr, i.en)}</span>
          </NavLink>
        ))}
      </nav>
      <div className="mt-3 space-y-2 border-t border-white/10 pt-3">
        <div className="flex items-center gap-2 px-1">
          <div className="grid h-8 w-8 place-items-center rounded-full text-xs font-semibold text-white" style={{ background: "linear-gradient(135deg, var(--brand), var(--brand-2))" }}>{(me.user?.name ?? "?").slice(0, 1).toUpperCase()}</div>
          <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{me.user?.name}</div><div className="truncate text-xs text-muted">{me.user?.email}</div></div>
          <button className="btn !p-2" onClick={() => void logout()} title={t("common.logout")} aria-label={t("common.logout")}><LogOut size={15} /></button>
        </div>
        <div className="px-1"><LanguageToggle onChange={(x) => void api("/api/auth/locale", { body: { locale: x } })} /></div>
      </div>
    </aside>
  );

  return (
    <div className="relative flex h-full">
      <div className="canvas" />
      <div className="relative z-10 hidden p-3 lg:block">{sidebar}</div>
      {drawer && <div className="fixed inset-0 z-40 lg:hidden" onMouseDown={(e) => e.target === e.currentTarget && setDrawer(false)} style={{ background: "rgb(0 0 0 / .5)" }}><div className="h-full p-3">{sidebar}</div></div>}
      <main className="relative z-10 min-w-0 flex-1 overflow-auto">
        <div className="sticky top-0 z-20 flex items-center gap-3 p-3 lg:hidden">
          <button className="btn !p-2" onClick={() => setDrawer((d) => !d)} aria-label="Menu">{drawer ? <X size={18} /> : <Menu size={18} />}</button>
          <BrandMark name={brand.appName} logoUrl={brand.logoUrl} size={28} /><span className="font-semibold">{brand.appName}</span>
        </div>
        <div className="mx-auto max-w-5xl p-4 lg:p-8"><Outlet /></div>
      </main>
    </div>
  );
}
