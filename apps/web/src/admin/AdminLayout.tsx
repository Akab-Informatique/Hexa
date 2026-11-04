import { NavLink, Outlet } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Cloud, History, Mail, Palette, ShieldCheck, Users, FolderSync, Receipt } from "lucide-react";
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
    { to: "/admin/audit", key: "admin.audit", icon: History, perm: "admin.audit.view" },
  ] },
];

export default function AdminLayout() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const brand = useBranding();
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
            const items = g.items.filter((i) => can(i.perm, "admin.groups.manage"));
            return items.length ? (
              <div key={g.key}>
                <div className="mb-1 px-3 text-[11px] font-medium uppercase tracking-wider text-muted">{t(g.key)}</div>
                {items.map((i) => (
                  <NavLink key={i.to} to={i.to} className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}>
                    <i.icon size={16} /> <span>{t(i.key)}</span>
                  </NavLink>
                ))}
              </div>
            ) : null;
          })}
        </nav>
        <div className="mt-3 px-1"><LanguageToggle /></div>
      </aside>
      <main className="relative z-10 min-w-0 flex-1 overflow-auto"><div className="mx-auto max-w-5xl p-4 lg:p-8"><Outlet /></div></main>
    </div>
  );
}
