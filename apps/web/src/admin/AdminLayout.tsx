import { NavLink, Outlet } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useTranslation } from "react-i18next";
import { ArrowLeft, LogOut, Cloud, History, Mail, Palette, ShieldCheck, Users, FolderSync, Receipt, Clock, Tags, RefreshCw } from "lucide-react";
import { useAuth } from "../lib/auth";
import { useBranding } from "../lib/theme";
import { BrandMark, LanguageToggle } from "../components/ui";

const GROUPS = [
  { key: "admin.groupAccess", items: [
    { to: "/admin/users", key: "admin.users", icon: Users, perm: "admin.users.view" },
    { to: "/admin/groups", key: "admin.groups", icon: ShieldCheck, perm: "admin.users.view" },
  ] },
  { key: "admin.groupIntegrations", items: [
    { to: "/admin/integrations/o365", key: "admin.o365", icon: Cloud, perm: "admin.integrations.view" },
    { to: "/admin/integrations/mailjet", key: "admin.mailjet", icon: Mail, perm: "admin.integrations.view" },
    { to: "/admin/integrations/quickbooks", key: "admin.quickbooks", icon: Receipt, perm: "admin.integrations.view" },
    { to: "/admin/integrations/sharepoint", key: "admin.sharepoint", icon: FolderSync, perm: "admin.integrations.view" },
  ] },
  { key: "admin.groupTenant", items: [
    { to: "/admin/tenant", key: "admin.tenant", icon: Palette, perm: "admin.branding.view" },
    { to: "/admin/classes", key: "admin.classes", icon: Tags, perm: "admin.classes.manage" },
    { to: "/admin/time", key: "admin.time", icon: Clock, perm: "admin.time.manage" },
    { to: "/admin/audit", key: "admin.audit", icon: History, perm: "admin.audit.view" },
    // Only the updates right opens this page (no groups.manage fallback).
    { to: "/admin/updates", key: "admin.updates", icon: RefreshCw, perm: "admin.updates.install", via: [] as string[] },
  ] },
];

export default function AdminLayout() {
  const { t } = useTranslation();
  const { can, logout } = useAuth();
  const brand = useBranding();
  // A dot on "Mises à jour" while a newer version is waiting (only for those who may install it).
  const badge = useQuery({
    queryKey: ["update-badge"], enabled: can("admin.updates.install"), staleTime: 60_000, retry: false,
    queryFn: () => api<{ updateAvailable: boolean; target: string | null }>("/api/update/status"),
  });
  return (
    <div className="relative flex h-full flex-col lg:flex-row">
      <div className="canvas" />
      <aside className="glass relative z-10 m-3 flex shrink-0 flex-col p-4 lg:w-72">
        <div className="mb-4 flex items-center gap-3 px-1">
          <BrandMark name={brand.appName} logoUrl={brand.logoUrl} size={30} />
          <div className="font-semibold">{t("admin.title")}</div>
        </div>
        <NavLink to="/team" className="nav-item mb-3"><ArrowLeft size={15} /> {t("admin.back")}</NavLink>
        <nav className="flex-1 space-y-4 overflow-auto">
          {GROUPS.map((g) => {
            const items = g.items.filter((i) => can(i.perm, ...i.via ?? ["admin.groups.manage"]));
            return items.length ? (
              <div key={g.key}>
                <div className="mb-1 px-3 text-[11px] font-medium uppercase tracking-wider text-muted">{t(g.key)}</div>
                {items.map((i) => (
                  <NavLink key={i.to} to={i.to} className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}>
                    <i.icon size={16} /> <span>{t(i.key)}</span>{i.to === "/admin/updates" && badge.data?.updateAvailable && <span className="ml-auto inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold" style={{ background: "var(--warn)", color: "#000" }} title={badge.data.target ?? ""}>{badge.data.target}</span>}
                  </NavLink>
                ))}
              </div>
            ) : null;
          })}
        </nav>
        <div className="mt-3 flex items-center justify-between gap-2 px-1"><LanguageToggle /><button className="btn !p-2" onClick={() => void logout()} title={t("common.logout")} aria-label={t("common.logout")}><LogOut size={15} /></button></div>
      </aside>
      <main className="relative z-10 min-w-0 flex-1 overflow-auto"><div className="w-full p-3 lg:p-5"><Outlet /></div></main>
    </div>
  );
}
