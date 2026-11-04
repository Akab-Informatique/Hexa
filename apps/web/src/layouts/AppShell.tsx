import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ChevronDown, LogOut, Menu, Settings, X } from "lucide-react";
import { useAuth } from "../lib/auth";
import { api } from "../lib/api";
import { useBranding } from "../lib/theme";
import { visibleNav } from "../modules/registry";
import { BrandMark, LanguageToggle } from "../components/ui";

const OPEN_KEY = "nexo.nav.open";
const readOpen = (): string[] | null => { try { return JSON.parse(localStorage.getItem(OPEN_KEY) ?? "null"); } catch { return null; } };

export default function AppShell() {
  const { t } = useTranslation();
  const { me, can, logout } = useAuth();
  const brand = useBranding();
  const nav = visibleNav(can);
  const { pathname } = useLocation();
  const [drawer, setDrawer] = useState(false);
  const [open, setOpen] = useState<string[]>(() => readOpen() ?? ["team"]);

  useEffect(() => setDrawer(false), [pathname]);
  // Keep the module that holds the current page expanded.
  useEffect(() => {
    const m = nav.find((x) => x.items.some((i) => pathname === i.path || pathname.startsWith(i.path + "/")));
    if (m && !open.includes(m.key)) setOpen((o) => [...o, m.key]);
  }, [pathname]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { try { localStorage.setItem(OPEN_KEY, JSON.stringify(open)); } catch { /* ignore */ } }, [open]);

  const toggle = (k: string) => setOpen((o) => (o.includes(k) ? o.filter((x) => x !== k) : [...o, k]));
  const isAdmin = can("admin.users.view", "admin.groups.manage", "admin.integrations.view", "admin.branding.view", "admin.audit.view");

  const sidebar = (
    <aside className="glass flex h-full w-72 flex-col p-4" aria-label="Navigation">
      <div className="mb-5 flex items-center gap-3 px-1">
        <BrandMark name={brand.appName} logoUrl={brand.logoUrl} />
        <div className="truncate text-base font-semibold tracking-tight">{brand.appName}</div>
      </div>
      <nav className="-mr-2 flex-1 space-y-1 overflow-auto pr-2">
        {nav.map((m) => {
          const expanded = open.includes(m.key);
          return (
            <div key={m.key}>
              <button className="nav-item w-full" onClick={() => toggle(m.key)} aria-expanded={expanded}>
                <m.icon size={17} />
                <span className="flex-1 text-left font-medium">{t(m.labelKey)}</span>
                <ChevronDown size={15} style={{ transform: expanded ? "rotate(180deg)" : undefined, transition: "transform .2s" }} />
              </button>
              {expanded && (
                <div className="ml-4 mt-1 space-y-0.5 border-l border-white/10 pl-2">
                  {m.items.map((i) => (
                    <NavLink key={i.path} to={i.path} end className={({ isActive }) => `nav-item ${isActive ? "active" : ""} ${i.upcoming ? "upcoming" : ""}`}>
                      <i.icon size={15} />
                      <span className="flex-1">{t(i.labelKey)}</span>
                      {i.upcoming && <span className="text-[10px] uppercase tracking-wide text-muted">{t("common.soon")}</span>}
                    </NavLink>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </nav>
      <div className="mt-3 space-y-2 border-t border-white/10 pt-3">
        {isAdmin && (
          <NavLink to="/admin" className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}>
            <Settings size={16} /> <span>{t("common.admin")}</span>
          </NavLink>
        )}
        <div className="flex items-center gap-2 px-1">
          <div className="grid h-8 w-8 place-items-center rounded-full text-xs font-semibold text-white" style={{ background: "linear-gradient(135deg, var(--brand), var(--brand-2))" }}>
            {(me.user?.name ?? "?").slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{me.user?.name}</div>
            <div className="truncate text-xs text-muted">{me.user?.email}</div>
          </div>
          <button className="btn !p-2" onClick={() => void logout()} title={t("common.logout")} aria-label={t("common.logout")}><LogOut size={15} /></button>
        </div>
        <div className="px-1"><LanguageToggle onChange={(l) => void api("/api/auth/locale", { body: { locale: l } })} /></div>
      </div>
    </aside>
  );

  return (
    <div className="relative flex h-full">
      <div className="canvas" />
      <div className="relative z-10 hidden p-3 lg:block">{sidebar}</div>
      {drawer && (
        <div className="fixed inset-0 z-40 lg:hidden" onMouseDown={(e) => e.target === e.currentTarget && setDrawer(false)} style={{ background: "rgb(0 0 0 / .5)" }}>
          <div className="h-full p-3">{sidebar}</div>
        </div>
      )}
      <main className="relative z-10 min-w-0 flex-1 overflow-auto">
        <div className="sticky top-0 z-20 flex items-center gap-3 p-3 lg:hidden">
          <button className="btn !p-2" onClick={() => setDrawer((d) => !d)} aria-label="Menu">{drawer ? <X size={18} /> : <Menu size={18} />}</button>
          <BrandMark name={brand.appName} logoUrl={brand.logoUrl} size={28} />
          <span className="font-semibold">{brand.appName}</span>
        </div>
        <div className="mx-auto max-w-6xl p-4 lg:p-8"><Outlet /></div>
      </main>
    </div>
  );
}
