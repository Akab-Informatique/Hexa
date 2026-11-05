import { BookOpen, Briefcase, CalendarDays, CheckSquare, Clock, FileText, FolderOpen, Inbox, LayoutDashboard, ListChecks, Megaphone, Receipt, Truck, UserCog, Users, Workflow, Wrench, ClipboardCheck, Landmark, Wallet, type LucideIcon } from "lucide-react";

export interface NavItem {
  path: string;
  labelKey: string;
  icon: LucideIcon;
  /** Right needed to see the page (any one of these). */
  permission: string | string[];
  /** Planned but not built yet: shown greyed out and routed to the "coming soon" page. */
  upcoming?: boolean;
}
/** A sidebar section (collapsible) grouping related pages, as in the reference portal. */
export interface NavSection { key: string; labelKey: string; icon: LucideIcon; items: NavItem[] }

export const NAV: NavSection[] = [
  { key: "team", labelKey: "nav.team", icon: Users, items: [
    { path: "/team", labelKey: "nav.team_dashboard", icon: LayoutDashboard, permission: "team.dashboard.view" },
    { path: "/team/meeting", labelKey: "nav.team_meeting", icon: ListChecks, permission: "team.meeting.view" },
  ] },
  { key: "mytools", labelKey: "nav.mytools", icon: Wrench, items: [
    { path: "/my/calendar", labelKey: "nav.mytools_calendar", icon: CalendarDays, permission: "mytools.calendar.use" },
    { path: "/my/mail", labelKey: "nav.mytools_mail", icon: Inbox, permission: "mytools.mail.use" },
    { path: "/my/timesheet", labelKey: "nav.mytools_timesheet", icon: Clock, permission: ["mytools.timesheet.use", "mytools.timesheet.approve", "mytools.timesheet.manage"] },
    { path: "/my/expenses", labelKey: "nav.mytools_expenses", icon: Wallet, permission: ["mytools.expenses.use", "mytools.expenses.approve"] },
    { path: "/my/kb", labelKey: "nav.mytools_kb", icon: BookOpen, permission: ["mytools.kb.view", "mytools.kb.edit"] },
    { path: "/my/procedures", labelKey: "nav.mytools_procedures", icon: FileText, permission: ["mytools.procedures.view", "mytools.procedures.edit", "mytools.procedures.manage"] },
  ] },
  { key: "command", labelKey: "nav.command", icon: Workflow, items: [
    { path: "/command/board", labelKey: "nav.command_board", icon: Megaphone, permission: "command.board.view" },
    { path: "/command/pipeline", labelKey: "nav.command_pipeline", icon: Workflow, permission: ["command.pipeline.view", "tasks.view"] },
  ] },
  { key: "management", labelKey: "nav.management", icon: Briefcase, items: [
    { path: "/clients", labelKey: "nav.clients_all", icon: Briefcase, permission: "clients.view" },
    { path: "/tasks", labelKey: "nav.tasks_all", icon: CheckSquare, permission: ["tasks.view", "command.pipeline.view"] },
    { path: "/docs", labelKey: "nav.docs_sharepoint", icon: FolderOpen, permission: ["docs.view", "docs.edit", "docs.manage"] },
  ] },
  { key: "accounting", labelKey: "nav.accounting", icon: Landmark, items: [
    { path: "/accounting/invoices", labelKey: "nav.accounting_invoices", icon: Receipt, permission: ["accounting.invoices.view", "accounting.invoices.edit", "accounting.invoices.manage"] },
    { path: "/accounting/approvals", labelKey: "nav.accounting_approvals", icon: ClipboardCheck, permission: ["accounting.approvals.view", "accounting.approvals.manage"] },
    { path: "/accounting/vendors", labelKey: "nav.accounting_vendors", icon: Truck, permission: ["accounting.vendors.view", "accounting.vendors.manage"] },
    { path: "/hr", labelKey: "nav.hr_staff", icon: UserCog, permission: ["hr.view", "hr.manage"] },
  ] },
];

const arr = (p: string | string[]) => (Array.isArray(p) ? p : [p]);

/** Sections the user may see: only pages they hold a right for; a section with no visible page disappears. */
export function visibleNav(can: (...k: string[]) => boolean): NavSection[] {
  return NAV.map((s) => ({ ...s, items: s.items.filter((i) => can(...arr(i.permission))) })).filter((s) => s.items.length);
}
export const itemPermission = (i: NavItem) => arr(i.permission);
