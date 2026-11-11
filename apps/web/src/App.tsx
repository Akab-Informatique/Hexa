import { lazy, Suspense, useEffect, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AuthProvider } from "./lib/auth";
import { useBranding } from "./lib/theme";
import { setLanguage } from "./i18n";
import { NAV } from "./modules/registry";
import Login from "./pages/Login";
import AppShell from "./layouts/AppShell";
import AdminLayout from "./admin/AdminLayout";
import ClientShell from "./portal/ClientShell";
import SetPassword from "./portal/SetPassword";

// Every page is its own chunk. Access is still checked by the route guards below and by the server; a chunk is just code.
const UsersPage = lazy(() => import("./admin/UsersPage"));
const GroupsPage = lazy(() => import("./admin/GroupsPage"));
const AuditPage = lazy(() => import("./admin/InfoPages").then((m) => ({ default: m.AuditPage })));
const IntegrationPage = lazy(() => import("./admin/InfoPages").then((m) => ({ default: m.IntegrationPage })));
const TenantPage = lazy(() => import("./admin/InfoPages").then((m) => ({ default: m.TenantPage })));
const DashboardsPage = lazy(() => import("./modules/team/DashboardsPage"));
const MeetingPage = lazy(() => import("./modules/team/MeetingPage"));
const ConnectPage = lazy(() => import("./modules/mytools/ConnectPage"));
const TimesheetPage = lazy(() => import("./modules/mytools/TimesheetPage"));
const ExpensesPage = lazy(() => import("./modules/mytools/ExpensesPage"));
const TimeTypesPage = lazy(() => import("./admin/TimeTypesPage"));
const ClassesPage = lazy(() => import("./admin/ClassesPage"));
const ContractsPage = lazy(() => import("./modules/accounting/ContractsPage"));
const ServicesPage = lazy(() => import("./modules/accounting/ServicesPage"));
const KbPage = lazy(() => import("./modules/mytools/KnowledgePages").then((m) => ({ default: m.KbPage })));
const ProceduresPage = lazy(() => import("./modules/mytools/KnowledgePages").then((m) => ({ default: m.ProceduresPage })));
const BoardPage = lazy(() => import("./modules/command/BoardPage"));
const DocsPage = lazy(() => import("./modules/command/DocsPage"));
const PipelinePage = lazy(() => import("./modules/tasks/PipelinePage"));
const TasksPage = lazy(() => import("./modules/tasks/TasksPage"));
const ClientsPage = lazy(() => import("./modules/clients/ClientsPage"));
const TrackingPage = lazy(() => import("./modules/clients/TrackingPage"));
const ClientDetail = lazy(() => import("./modules/clients/ClientDetail"));
const InvoicesPage = lazy(() => import("./modules/accounting/InvoicesPage"));
const ApprovalsPage = lazy(() => import("./modules/accounting/ApprovalsPage"));
const VendorsPage = lazy(() => import("./modules/accounting/VendorsPage"));
const HrPage = lazy(() => import("./modules/hr/HrPage"));
const ClientHome = lazy(() => import("./portal/ClientHome"));
const ClientInvoices = lazy(() => import("./portal/ClientInvoices"));
const ClientContracts = lazy(() => import("./portal/ClientContracts"));
const ClientSettings = lazy(() => import("./portal/ClientSettings"));

/** Small accessible fallback; sits inside the shell so the menu stays put while a page loads. */
function Wait({ children }: { children: ReactNode }) {
  return <Suspense fallback={<div role="status" aria-live="polite" className="glass p-8 text-center text-sm text-muted">…</div>}>{children}</Suspense>;
}

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
  "/team": <Wait><DashboardsPage /></Wait>, "/team/meeting": <Wait><MeetingPage /></Wait>,
  "/my/calendar": <Wait><ConnectPage kind="calendar" /></Wait>, "/my/mail": <Wait><ConnectPage kind="mail" /></Wait>, "/my/timesheet": <Wait><TimesheetPage /></Wait>, "/my/expenses": <Wait><ExpensesPage /></Wait>, "/my/kb": <Wait><KbPage /></Wait>, "/my/procedures": <Wait><ProceduresPage /></Wait>,
  "/command/board": <Wait><BoardPage /></Wait>, "/command/pipeline": <Wait><PipelinePage /></Wait>,
  "/clients": <Wait><ClientsPage /></Wait>, "/tracking": <Wait><TrackingPage /></Wait>, "/tasks": <Wait><TasksPage /></Wait>, "/docs": <Wait><DocsPage /></Wait>,
  "/accounting/invoices": <Wait><InvoicesPage /></Wait>, "/accounting/contracts": <Wait><ContractsPage /></Wait>, "/services": <Wait><ServicesPage /></Wait>, "/accounting/approvals": <Wait><ApprovalsPage /></Wait>, "/accounting/vendors": <Wait><VendorsPage /></Wait>, "/hr": <Wait><HrPage /></Wait>,
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
        <Route path="/clients/:id" element={can("clients.view") ? <Wait><ClientDetail /></Wait> : denied} />
      </Route>
      <Route path="/admin" element={<AdminLayout />}>
        <Route index element={<Navigate to={adminHome} replace />} />
        <Route path="users" element={can("admin.users.view") ? <Wait><UsersPage /></Wait> : denied} />
        <Route path="groups" element={can("admin.users.view") ? <Wait><GroupsPage /></Wait> : denied} />
        <Route path="integrations/:provider" element={can("admin.integrations.view") ? <Wait><IntegrationPage /></Wait> : denied} />
        <Route path="tenant" element={can("admin.branding.view") ? <Wait><TenantPage /></Wait> : denied} />
        <Route path="time" element={can("admin.time.manage") ? <Wait><TimeTypesPage /></Wait> : denied} />
        <Route path="classes" element={can("admin.classes.manage") ? <Wait><ClassesPage /></Wait> : denied} />
        <Route path="audit" element={can("admin.audit.view") ? <Wait><AuditPage /></Wait> : denied} />
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
        <Route index element={can("clientportal.view") ? <Wait><ClientHome /></Wait> : denied} />
        <Route path="/invoices" element={can("clientportal.invoices.view") ? <Wait><ClientInvoices /></Wait> : denied} />
        <Route path="/contracts" element={can("clientportal.contracts.view") ? <Wait><ClientContracts /></Wait> : denied} />
        <Route path="/documents" element={can("clientportal.docs.view") ? <Wait><DocsPage /></Wait> : denied} />
        <Route path="/settings" element={<Wait><ClientSettings /></Wait>} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
