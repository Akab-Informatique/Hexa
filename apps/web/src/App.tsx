import { useEffect, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AuthProvider } from "./lib/auth";
import { useBranding } from "./lib/theme";
import { setLanguage } from "./i18n";
import { NAV } from "./modules/registry";
import Login from "./pages/Login";
import AppShell from "./layouts/AppShell";
import AdminLayout from "./admin/AdminLayout";
import UsersPage from "./admin/UsersPage";
import GroupsPage from "./admin/GroupsPage";
import { AuditPage, IntegrationPage, TenantPage } from "./admin/InfoPages";
import DashboardsPage from "./modules/team/DashboardsPage";
import MeetingPage from "./modules/team/MeetingPage";
import ConnectPage from "./modules/mytools/ConnectPage";
import TimesheetPage from "./modules/mytools/TimesheetPage";
import ExpensesPage from "./modules/mytools/ExpensesPage";
import TimeTypesPage from "./admin/TimeTypesPage";
import ClassesPage from "./admin/ClassesPage";
import ContractsPage from "./modules/accounting/ContractsPage";
import ServicesPage from "./modules/accounting/ServicesPage";
import { KbPage, ProceduresPage } from "./modules/mytools/KnowledgePages";
import BoardPage from "./modules/command/BoardPage";
import DocsPage from "./modules/command/DocsPage";
import PipelinePage from "./modules/tasks/PipelinePage";
import TasksPage from "./modules/tasks/TasksPage";
import ClientsPage from "./modules/clients/ClientsPage";
import ClientDetail from "./modules/clients/ClientDetail";
import InvoicesPage from "./modules/accounting/InvoicesPage";
import ApprovalsPage from "./modules/accounting/ApprovalsPage";
import VendorsPage from "./modules/accounting/VendorsPage";
import HrPage from "./modules/hr/HrPage";
import ClientShell from "./portal/ClientShell";
import ClientHome from "./portal/ClientHome";
import ClientInvoices from "./portal/ClientInvoices";
import ClientContracts from "./portal/ClientContracts";
import ClientSettings from "./portal/ClientSettings";
import SetPassword from "./portal/SetPassword";

export default function App() {
  useBranding(); // applies the tenant's colors to the whole app, including the login screen
  const { pathname } = useLocation();
  if (pathname === "/set-password") return <SetPassword />; // opened from the welcome email, before any sign-in
  return (
    <AuthProvider>
      {({ me, can }) => (me.stage !== "ready" ? <Login /> : me.user?.kind === "client" ? <ClientSigned userLocale={me.user.locale} can={can} /> : <Signed userLocale={me.user?.locale} can={can} />)}
    </AuthProvider>
  );
}

/** Page for each sidebar path. The right check is repeated here so a typed URL is refused too. */
const PAGES: Record<string, ReactNode> = {
  "/team": <DashboardsPage />, "/team/meeting": <MeetingPage />,
  "/my/calendar": <ConnectPage kind="calendar" />, "/my/mail": <ConnectPage kind="mail" />, "/my/timesheet": <TimesheetPage />, "/my/expenses": <ExpensesPage />, "/my/kb": <KbPage />, "/my/procedures": <ProceduresPage />,
  "/command/board": <BoardPage />, "/command/pipeline": <PipelinePage />,
  "/clients": <ClientsPage />, "/tasks": <TasksPage />, "/docs": <DocsPage />,
  "/accounting/invoices": <InvoicesPage />, "/accounting/contracts": <ContractsPage />, "/services": <ServicesPage />, "/accounting/approvals": <ApprovalsPage />, "/accounting/vendors": <VendorsPage />, "/hr": <HrPage />,
};

function Signed({ userLocale, can }: { userLocale?: "fr" | "en"; can: (...k: string[]) => boolean }) {
  const { t } = useTranslation();
  // The saved per-user language applies once after sign-in, unless the user already picked one on this device.
  useEffect(() => {
    try { if (userLocale && !localStorage.getItem("hexa.lang")) setLanguage(userLocale); } catch { /* ignore */ }
  }, [userLocale]);

  const denied = <div className="glass p-8 text-center text-sm text-muted">{t("errors.forbidden")}</div>;
  const adminHome = can("admin.users.view") ? "users" : can("admin.integrations.view") ? "integrations/o365" : can("admin.branding.view") ? "tenant" : "audit";
  const items = NAV.flatMap((s) => s.items);
  const first = items.find((i) => can(...(Array.isArray(i.permission) ? i.permission : [i.permission])));

  return (
    <Routes>
      <Route element={<AppShell />}>
        {items.map((i) => <Route key={i.path} path={i.path} element={can(...(Array.isArray(i.permission) ? i.permission : [i.permission])) ? PAGES[i.path] : denied} />)}
        <Route path="/clients/:id" element={can("clients.view") ? <ClientDetail /> : denied} />
      </Route>
      <Route path="/admin" element={<AdminLayout />}>
        <Route index element={<Navigate to={adminHome} replace />} />
        <Route path="users" element={can("admin.users.view") ? <UsersPage /> : denied} />
        <Route path="groups" element={can("admin.users.view") ? <GroupsPage /> : denied} />
        <Route path="integrations/:provider" element={can("admin.integrations.view") ? <IntegrationPage /> : denied} />
        <Route path="tenant" element={can("admin.branding.view") ? <TenantPage /> : denied} />
        <Route path="time" element={can("admin.time.manage") ? <TimeTypesPage /> : denied} />
        <Route path="classes" element={can("admin.classes.manage") ? <ClassesPage /> : denied} />
        <Route path="audit" element={can("admin.audit.view") ? <AuditPage /> : denied} />
      </Route>
      <Route path="*" element={<Navigate to={first?.path ?? "/admin"} replace />} />
    </Routes>
  );
}

/** Client portal users: their own shell and pages; anything else goes back to the home page. */
function ClientSigned({ userLocale, can }: { userLocale?: "fr" | "en"; can: (...k: string[]) => boolean }) {
  const { t } = useTranslation();
  useEffect(() => {
    try { if (userLocale && !localStorage.getItem("hexa.lang")) setLanguage(userLocale); } catch { /* ignore */ }
  }, [userLocale]);
  const denied = <div className="glass p-8 text-center text-sm text-muted">{t("errors.forbidden")}</div>;
  return (
    <Routes>
      <Route element={<ClientShell />}>
        <Route index element={can("clientportal.view") ? <ClientHome /> : denied} />
        <Route path="/invoices" element={can("clientportal.invoices.view") ? <ClientInvoices /> : denied} />
        <Route path="/contracts" element={can("clientportal.contracts.view") ? <ClientContracts /> : denied} />
        <Route path="/documents" element={can("clientportal.docs.view") ? <DocsPage /> : denied} />
        <Route path="/settings" element={<ClientSettings />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
