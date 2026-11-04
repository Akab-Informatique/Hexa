import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { fmtDate, hours, mondayOf, money, todayISO, useL, useLocale } from "../../lib/l";

/** Dashboard widgets. Modules contribute widgets here; a widget only appears for users who hold its right. */
export interface WidgetDef { label: [string, string]; permission?: string[]; render: () => ReactNode }

const Card = ({ title, children, to }: { title: string; children: ReactNode; to?: string }) => (
  <div className="glass h-full p-5">
    <div className="mb-3 flex items-center justify-between"><h3 className="text-sm font-semibold text-muted">{title}</h3>{to && <Link to={to} className="text-xs no-underline">→</Link>}</div>
    {children}
  </div>
);
const Big = ({ n, label, tone }: { n: ReactNode; label: string; tone?: string }) => (
  <div><div className="text-3xl font-semibold" style={{ color: tone }}>{n}</div><div className="text-xs text-muted">{label}</div></div>
);

function Welcome() {
  const l = useL(); const loc = useLocale(); const { me } = useAuth();
  return <Card title={l("Bienvenue", "Welcome")}><div className="text-2xl font-semibold">{l("Bonjour", "Hello")}, {me.user?.name.split(" ")[0]}</div><div className="mt-1 text-sm text-muted">{new Date().toLocaleDateString(loc, { weekday: "long", day: "numeric", month: "long" })}</div></Card>;
}

function MyTasks() {
  const l = useL(); const loc = useLocale();
  const q = useQuery({ queryKey: ["w-my-tasks"], queryFn: () => api<{ id: string; title: string; dueDate: string | null; priority: string }[]>("/api/tasks?assignee=me&status=open") });
  const today = todayISO();
  return (
    <Card title={l("Mes tâches", "My tasks")} to="/command/pipeline">
      {!q.data?.length ? <p className="text-sm text-muted">{l("Aucune tâche ouverte.", "No open tasks.")}</p> : (
        <ul className="space-y-1.5 text-sm">{q.data.slice(0, 6).map((t) => (
          <li key={t.id} className="flex justify-between gap-2"><Link to={`/tasks?open=${t.id}`} className="truncate no-underline text-[var(--fg)]">{t.title}</Link>
            <span className="shrink-0 text-xs" style={{ color: t.dueDate && t.dueDate < today ? "var(--danger)" : "var(--muted)" }}>{fmtDate(t.dueDate, loc)}</span></li>))}</ul>
      )}
    </Card>
  );
}

function WeekStatus() {
  const l = useL();
  const q = useQuery({ queryKey: ["w-week"], queryFn: () => api<{ status: string; dueDate: string | null; assigneeId: string | null }[]>("/api/tasks?status=open") });
  const today = todayISO(); const mon = mondayOf(today);
  const rows = q.data ?? [];
  const overdue = rows.filter((t) => t.dueDate && t.dueDate < today).length;
  const week = rows.filter((t) => t.dueDate && t.dueDate >= mon && t.dueDate <= today.replace(/\d+$/, (d) => String(Number(d) + 6).padStart(2, "0"))).length;
  return <Card title={l("État de la semaine", "Week status")} to="/tasks"><div className="grid grid-cols-3 gap-2"><Big n={overdue} label={l("En retard", "Overdue")} tone={overdue ? "var(--danger)" : undefined} /><Big n={rows.length} label={l("Ouvertes", "Open")} /><Big n={rows.filter((t) => !t.assigneeId).length} label={l("Non assignées", "Unassigned")} /></div><div className="mt-3 text-xs text-muted">{week} {l("à échéance cette semaine", "due this week")}</div></Card>;
}

function MeetingPoints() {
  const l = useL();
  const q = useQuery({ queryKey: ["w-meeting"], queryFn: () => api<{ points: { id: string; title: string; done: boolean }[] }>("/api/team/meeting") });
  return (
    <Card title={l("Rencontre d'équipe", "Team meeting")} to="/team/meeting">
      {!q.data?.points.length ? <p className="text-sm text-muted">{l("Aucun point cette semaine.", "No points this week.")}</p> : (
        <ul className="space-y-1 text-sm">{q.data.points.slice(0, 6).map((p) => <li key={p.id} className={p.done ? "text-muted line-through" : ""}>• {p.title}</li>)}</ul>)}
    </Card>
  );
}

function BoardLatest() {
  const l = useL(); const loc = useLocale();
  const q = useQuery({ queryKey: ["w-board"], queryFn: () => api<{ id: string; title: string; createdAt: string; pinned: boolean }[]>("/api/command/board") });
  return (
    <Card title={l("Babillard", "Message board")} to="/command/board">
      {!q.data?.length ? <p className="text-sm text-muted">—</p> : <ul className="space-y-1.5 text-sm">{q.data.slice(0, 4).map((m) => <li key={m.id} className="flex justify-between gap-2"><span className="truncate">{m.pinned ? "📌 " : ""}{m.title}</span><span className="shrink-0 text-xs text-muted">{fmtDate(m.createdAt, loc)}</span></li>)}</ul>}
    </Card>
  );
}

function TimesheetWeek() {
  const l = useL();
  const q = useQuery({ queryKey: ["w-ts"], queryFn: () => api<{ totalMinutes: number; hasDraft: boolean }>("/api/my/timesheet") });
  return <Card title={l("Ma feuille de temps", "My timesheet")} to="/my/timesheet"><Big n={hours(q.data?.totalMinutes ?? 0)} label={l("cette semaine", "this week")} />{q.data?.hasDraft && (q.data.totalMinutes > 0) && <p className="mt-2 text-xs text-warn">{l("À soumettre", "To submit")}</p>}</Card>;
}

function ClientsCount() {
  const l = useL();
  const q = useQuery({ queryKey: ["w-clients"], queryFn: () => api<{ status: string }[]>("/api/clients") });
  const rows = q.data ?? [];
  return <Card title={l("Clients", "Clients")} to="/clients"><div className="grid grid-cols-2 gap-2"><Big n={rows.filter((c) => c.status === "active").length} label={l("Actifs", "Active")} /><Big n={rows.filter((c) => c.status === "prospect").length} label="Prospects" /></div></Card>;
}

function BillsToPay() {
  const l = useL(); const loc = useLocale();
  const q = useQuery({ queryKey: ["w-bills"], queryFn: () => api<{ totals: { open: number; overdue: number; dueThisWeek: number } }>("/api/accounting/bills") });
  const t = q.data?.totals;
  return <Card title={l("Paiements à faire", "Payments to make")} to="/accounting/vendors"><div className="grid grid-cols-2 gap-2"><Big n={money(t?.dueThisWeek, loc)} label={l("Cette semaine", "This week")} /><Big n={money(t?.overdue, loc)} label={l("En retard", "Overdue")} tone={t?.overdue ? "var(--danger)" : undefined} /></div></Card>;
}

function QuickLinks() {
  const l = useL(); const { can } = useAuth();
  const links = [
    { to: "/command/pipeline", label: l("Ma journée", "My day"), ok: can("command.pipeline.view", "tasks.view") }, { to: "/tasks", label: l("Tâches", "Tasks"), ok: can("tasks.view") },
    { to: "/clients", label: "Clients", ok: can("clients.view") }, { to: "/my/timesheet", label: l("Temps", "Time"), ok: can("mytools.timesheet.use") }, { to: "/command/board", label: l("Babillard", "Board"), ok: can("command.board.view") },
  ].filter((x) => x.ok);
  return <Card title={l("Accès rapide", "Quick links")}><div className="flex flex-wrap gap-2">{links.map((x) => <Link key={x.to} to={x.to} className="chip no-underline">{x.label}</Link>)}</div></Card>;
}

export const WIDGETS: Record<string, WidgetDef> = {
  welcome: { label: ["Bienvenue", "Welcome"], render: () => <Welcome /> },
  "my-tasks": { label: ["Mes tâches", "My tasks"], permission: ["tasks.view", "command.pipeline.view"], render: () => <MyTasks /> },
  "week-status": { label: ["État de la semaine", "Week status"], permission: ["tasks.view", "command.pipeline.view"], render: () => <WeekStatus /> },
  "meeting-points": { label: ["Rencontre d'équipe", "Team meeting"], permission: ["team.meeting.view"], render: () => <MeetingPoints /> },
  "board-latest": { label: ["Babillard", "Message board"], permission: ["command.board.view"], render: () => <BoardLatest /> },
  "timesheet-week": { label: ["Feuille de temps", "Timesheet"], permission: ["mytools.timesheet.use"], render: () => <TimesheetWeek /> },
  "clients-count": { label: ["Clients", "Clients"], permission: ["clients.view"], render: () => <ClientsCount /> },
  "bills-to-pay": { label: ["Paiements à faire", "Payments to make"], permission: ["accounting.vendors.view", "accounting.vendors.manage"], render: () => <BillsToPay /> },
  "quick-links": { label: ["Accès rapide", "Quick links"], render: () => <QuickLinks /> },
};
