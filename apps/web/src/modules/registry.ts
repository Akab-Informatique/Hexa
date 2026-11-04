import { CalendarDays, CheckSquare, Clock, FileText, FolderOpen, Inbox, LayoutDashboard, Megaphone, Users, Receipt, BookOpen, ListChecks, Workflow, UserCog, Briefcase, Wrench, type LucideIcon } from "lucide-react";

export interface NavItem {
  /** Route path. */
  path: string;
  labelKey: string;
  icon: LucideIcon;
  /** Right needed to see the page. */
  permission: string;
  /** Planned but not built yet: shown greyed out and routed to the "coming soon" page. */
  upcoming?: boolean;
}
export interface NavModule { key: string; labelKey: string; icon: LucideIcon; items: NavItem[] }

/**
 * The sidebar. Adding a module = add an entry here, its permissions in packages/shared/src/permissions.ts,
 * its strings in i18n/fr.ts + en.ts, and its route in App.tsx.
 */
export const NAV: NavModule[] = [
  { key: "team", labelKey: "nav.team", icon: Users, items: [
    { path: "/team", labelKey: "nav.team_dashboard", icon: LayoutDashboard, permission: "team.dashboard.view" },
    { path: "/team/meeting", labelKey: "nav.team_meeting", icon: ListChecks, permission: "team.meeting.view", upcoming: true },
  ] },
  { key: "mytools", labelKey: "nav.mytools", icon: Wrench, items: [
    { path: "/my/calendar", labelKey: "nav.mytools_calendar", icon: CalendarDays, permission: "mytools.calendar.use", upcoming: true },
    { path: "/my/mail", labelKey: "nav.mytools_mail", icon: Inbox, permission: "mytools.mail.use", upcoming: true },
    { path: "/my/timesheet", labelKey: "nav.mytools_timesheet", icon: Clock, permission: "mytools.timesheet.use", upcoming: true },
    { path: "/my/kb", labelKey: "nav.mytools_kb", icon: BookOpen, permission: "mytools.kb.view", upcoming: true },
    { path: "/my/procedures", labelKey: "nav.mytools_procedures", icon: FileText, permission: "mytools.procedures.view", upcoming: true },
  ] },
  { key: "command", labelKey: "nav.command", icon: Workflow, items: [
    { path: "/command/board", labelKey: "nav.command_board", icon: Megaphone, permission: "command.board.view", upcoming: true },
    { path: "/command/pipeline", labelKey: "nav.command_pipeline", icon: Workflow, permission: "command.pipeline.view", upcoming: true },
  ] },
  { key: "tasks", labelKey: "nav.tasks", icon: CheckSquare, items: [
    { path: "/tasks", labelKey: "nav.tasks_all", icon: CheckSquare, permission: "tasks.view", upcoming: true },
  ] },
  { key: "docs", labelKey: "nav.docs", icon: FolderOpen, items: [
    { path: "/docs", labelKey: "nav.docs_sharepoint", icon: FolderOpen, permission: "docs.view", upcoming: true },
  ] },
  { key: "clients", labelKey: "nav.clients", icon: Briefcase, items: [
    { path: "/clients", labelKey: "nav.clients_all", icon: Briefcase, permission: "clients.view", upcoming: true },
  ] },
  { key: "accounting", labelKey: "nav.accounting", icon: Receipt, items: [
    { path: "/accounting/invoices", labelKey: "nav.accounting_invoices", icon: Receipt, permission: "accounting.invoices.view", upcoming: true },
    { path: "/accounting/approvals", labelKey: "nav.accounting_approvals", icon: CheckSquare, permission: "accounting.approvals.view", upcoming: true },
    { path: "/accounting/vendors", labelKey: "nav.accounting_vendors", icon: Briefcase, permission: "accounting.vendors.view", upcoming: true },
  ] },
  { key: "hr", labelKey: "nav.hr", icon: UserCog, items: [
    { path: "/hr", labelKey: "nav.hr_staff", icon: UserCog, permission: "hr.view", upcoming: true },
  ] },
];

/** Modules the user may see: only items they hold the right for; a module with no visible item disappears. */
export function visibleNav(can: (...k: string[]) => boolean): NavModule[] {
  return NAV.map((m) => ({ ...m, items: m.items.filter((i) => can(i.permission)) })).filter((m) => m.items.length);
}
