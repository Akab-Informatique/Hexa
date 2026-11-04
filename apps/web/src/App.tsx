import { useEffect } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AuthProvider } from "./lib/auth";
import { useBranding } from "./lib/theme";
import { setLanguage } from "./i18n";
import { NAV } from "./modules/registry";
import Login from "./pages/Login";
import AppShell from "./layouts/AppShell";
import Dashboard from "./pages/Dashboard";
import Upcoming from "./pages/Upcoming";
import AdminLayout from "./admin/AdminLayout";
import UsersPage from "./admin/UsersPage";
import GroupsPage from "./admin/GroupsPage";
import { AuditPage, IntegrationPage, TenantPage } from "./admin/InfoPages";

export default function App() {
  useBranding(); // applies the tenant's colors to the whole app, including the login screen
  return (
    <AuthProvider>
      {({ me, can }) => {
        if (me.stage !== "ready") return <Login />;
        return <Signed userLocale={me.user?.locale} can={can} />;
      }}
    </AuthProvider>
  );
}

function Signed({ userLocale, can }: { userLocale?: "fr" | "en"; can: (...k: string[]) => boolean }) {
  const { t } = useTranslation();
  // The saved per-user language wins once, right after sign-in, unless the user already picked one on this device.
  useEffect(() => {
    try { if (userLocale && !localStorage.getItem("nexo.lang")) setLanguage(userLocale); } catch { /* ignore */ }
  }, [userLocale]);

  const upcoming = NAV.flatMap((m) => m.items).filter((i) => i.upcoming);
  const denied = <div className="glass p-8 text-center text-sm text-muted">{t("errors.forbidden")}</div>;
  const adminHome = can("admin.users.view") ? "users" : can("admin.integrations.view") ? "integrations/o365" : can("admin.branding.view") ? "tenant" : "audit";

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/team" element={can("team.dashboard.view") ? <Dashboard /> : denied} />
        {upcoming.map((i) => <Route key={i.path} path={i.path} element={can(i.permission) ? <Upcoming /> : denied} />)}
      </Route>
      <Route path="/admin" element={<AdminLayout />}>
        <Route index element={<Navigate to={adminHome} replace />} />
        <Route path="users" element={can("admin.users.view") ? <UsersPage /> : denied} />
        <Route path="groups" element={can("admin.users.view") ? <GroupsPage /> : denied} />
        <Route path="integrations/:provider" element={can("admin.integrations.view") ? <IntegrationPage /> : denied} />
        <Route path="tenant" element={can("admin.branding.view") ? <TenantPage /> : denied} />
        <Route path="audit" element={can("admin.audit.view") ? <AuditPage /> : denied} />
      </Route>
      <Route path="*" element={<Navigate to="/team" replace />} />
    </Routes>
  );
}
