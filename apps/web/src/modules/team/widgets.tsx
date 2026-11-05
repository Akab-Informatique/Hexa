import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { fmtDate, hours, mondayOf, money, todayISO, useL, useLocale } from "../../lib/l";

/**
 * Dashboard widgets. Modules contribute widgets here; a widget only appears for users who hold its right.
 * `size` is its default width on the grid (1 small, 2 medium, 3 large); `desc` is shown in the gallery.
 */
export interface WidgetDef { label: [string, string]; desc: [string, string]; size: 1 | 2 | 3; permission?: string[]; render: () => ReactNode }

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

function Clock() {
  const l = useL(); const loc = useLocale();
  const [now, setNow] = useState(new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);
  return <Card title={l("Heure", "Clock")}><div className="text-4xl font-semibold tabular-nums">{now.toLocaleTimeString(loc, { hour: "2-digit", minute: "2-digit" })}</div><div className="mt-1 text-sm text-muted">{now.toLocaleDateString(loc, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</div></Card>;
}

interface TRow { id: string; title: string; dueDate: string | null; assigneeId: string | null; assigneeName: string | null; clientName?: string | null; priority: string }
const useOpenTasks = () => useQuery({ queryKey: ["w-open-tasks"], queryFn: () => api<TRow[]>("/api/tasks?status=open"), staleTime: 30_000 });

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
  const rows = useOpenTasks().data ?? [];
  const today = todayISO(); const mon = mondayOf(today);
  const sunday = (() => { const d = new Date(`${mon}T12:00:00`); d.setDate(d.getDate() + 6); return d.toISOString().slice(0, 10); })();
  const overdue = rows.filter((t) => t.dueDate && t.dueDate < today).length;
  const week = rows.filter((t) => t.dueDate && t.dueDate >= mon && t.dueDate <= sunday).length;
  return <Card title={l("État de la semaine", "Week status")} to="/tasks"><div className="grid grid-cols-3 gap-2"><Big n={overdue} label={l("En retard", "Overdue")} tone={overdue ? "var(--danger)" : undefined} /><Big n={rows.length} label={l("Ouvertes", "Open")} /><Big n={rows.filter((t) => !t.assigneeId).length} label={l("Non assignées", "Unassigned")} /></div><div className="mt-3 text-xs text-muted">{week} {l("à échéance cette semaine", "due this week")}</div></Card>;
}

function OverdueTasks() {
  const l = useL(); const loc = useLocale();
  const today = todayISO();
  const rows = (useOpenTasks().data ?? []).filter((t) => t.dueDate && t.dueDate < today).sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)));
  return (
    <Card title={l("Tâches en retard", "Late tasks")} to="/tasks">
      {!rows.length ? <p className="text-sm text-muted">{l("Rien en retard.", "Nothing late.")}</p> : (
        <ul className="space-y-1.5 text-sm">{rows.slice(0, 7).map((t) => <li key={t.id} className="flex justify-between gap-2"><Link to={`/tasks?open=${t.id}`} className="truncate no-underline text-[var(--fg)]">{t.title}</Link><span className="shrink-0 text-xs" style={{ color: "var(--danger)" }}>{fmtDate(t.dueDate, loc)}</span></li>)}</ul>)}
      {rows.length > 7 && <p className="mt-2 text-xs text-muted">+ {rows.length - 7}</p>}
    </Card>
  );
}

function UpcomingDeadlines() {
  const l = useL(); const loc = useLocale();
  const today = todayISO();
  const end = new Date(`${today}T12:00:00`); end.setDate(end.getDate() + 14);
  const limit = end.toISOString().slice(0, 10);
  const rows = (useOpenTasks().data ?? []).filter((t) => t.dueDate && t.dueDate >= today && t.dueDate <= limit).sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)));
  return (
    <Card title={l("Échéances des 14 prochains jours", "Deadlines, next 14 days")} to="/tasks">
      {!rows.length ? <p className="text-sm text-muted">{l("Aucune échéance.", "No deadlines.")}</p> : (
        <ul className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">{rows.slice(0, 10).map((t) => <li key={t.id} className="flex justify-between gap-2"><Link to={`/tasks?open=${t.id}`} className="truncate no-underline text-[var(--fg)]">{t.title}{t.clientName ? <span className="text-xs text-muted"> · {t.clientName}</span> : null}</Link><span className="shrink-0 text-xs text-muted">{fmtDate(t.dueDate, loc)}</span></li>)}</ul>)}
    </Card>
  );
}

function TasksByPerson() {
  const l = useL();
  const rows = useOpenTasks().data ?? [];
  const names = [...new Set(rows.map((t) => t.assigneeName ?? ""))];
  const counts = names.map((n) => ({ n: n || l("Non assignées", "Unassigned"), c: rows.filter((t) => (t.assigneeName ?? "") === n).length })).sort((a, b) => b.c - a.c);
  const max = Math.max(1, ...counts.map((x) => x.c));
  return (
    <Card title={l("Tâches ouvertes par personne", "Open tasks by person")} to="/tasks">
      {!counts.length ? <p className="text-sm text-muted">—</p> : <ul className="space-y-2 text-sm">{counts.slice(0, 7).map((x) => <li key={x.n}><div className="flex justify-between"><span className="truncate">{x.n}</span><b>{x.c}</b></div><div className="mt-1 h-1.5 rounded-full bg-white/10"><div className="h-full rounded-full" style={{ width: `${(x.c / max) * 100}%`, background: "linear-gradient(90deg, var(--brand), var(--brand-2))" }} /></div></li>)}</ul>}
    </Card>
  );
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
  const q = useQuery({ queryKey: ["w-ts"], queryFn: () => api<{ totals: { paidMinutes: number }; status: string; entries: unknown[] }>("/api/time/week") });
  return <Card title={l("Ma feuille de temps", "My timesheet")} to="/my/timesheet"><Big n={hours(q.data?.totals.paidMinutes ?? 0)} label={l("payées cette semaine", "paid this week")} />{(q.data?.status === "draft" || q.data?.status === "rejected") && (q.data.entries.length > 0) && <p className="mt-2 text-xs text-warn">{l("À envoyer", "To send")}</p>}</Card>;
}

function ClientsCount() {
  const l = useL();
  const q = useQuery({ queryKey: ["w-clients"], queryFn: () => api<{ status: string }[]>("/api/clients") });
  const rows = q.data ?? [];
  return <Card title={l("Clients", "Clients")} to="/clients"><div className="grid grid-cols-2 gap-2"><Big n={rows.filter((c) => c.status === "active").length} label={l("Actifs", "Active")} /><Big n={rows.filter((c) => c.status === "prospect").length} label="Prospects" /></div></Card>;
}

function BillingSummary() {
  const l = useL(); const loc = useLocale();
  const items = useQuery({ queryKey: ["w-bill-sum"], queryFn: () => api<{ pending: { count: number; total: number }; approved: { count: number; total: number } }>("/api/accounting/billing-items/summary") });
  const inv = useQuery({ queryKey: ["w-inv-sum"], queryFn: () => api<{ totals: { balance: number } }>("/api/accounting/invoices?page=1&size=10&status=open") });
  return (
    <Card title={l("Facturation", "Billing")} to="/accounting/approvals">
      <div className="grid grid-cols-3 gap-2"><Big n={items.data?.pending.count ?? 0} label={l("À approuver", "To approve")} /><Big n={money(items.data?.approved.total, loc)} label={l("Prêt à facturer", "Ready to invoice")} /><Big n={money(inv.data?.totals.balance, loc)} label={l("À recevoir", "Receivable")} /></div>
    </Card>
  );
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
  welcome: { label: ["Bienvenue", "Welcome"], desc: ["Un mot de bienvenue et la date", "A welcome and the date"], size: 2, render: () => <Welcome /> },
  clock: { label: ["Heure", "Clock"], desc: ["L'heure et la date", "The time and date"], size: 1, render: () => <Clock /> },
  "my-tasks": { label: ["Mes tâches", "My tasks"], desc: ["Mes tâches ouvertes, par échéance", "My open tasks, by due date"], size: 2, permission: ["tasks.view", "command.pipeline.view"], render: () => <MyTasks /> },
  "week-status": { label: ["État de la semaine", "Week status"], desc: ["Tâches en retard, ouvertes et non assignées", "Late, open and unassigned tasks"], size: 1, permission: ["tasks.view", "command.pipeline.view"], render: () => <WeekStatus /> },
  "overdue-tasks": { label: ["Tâches en retard", "Late tasks"], desc: ["Ce qui a dépassé son échéance", "What is past its due date"], size: 1, permission: ["tasks.view", "command.pipeline.view"], render: () => <OverdueTasks /> },
  "upcoming-deadlines": { label: ["Échéances à venir", "Upcoming deadlines"], desc: ["Les 14 prochains jours", "The next 14 days"], size: 2, permission: ["tasks.view", "command.pipeline.view"], render: () => <UpcomingDeadlines /> },
  "tasks-by-person": { label: ["Tâches par personne", "Tasks by person"], desc: ["La charge de l'équipe", "The team's workload"], size: 1, permission: ["tasks.view", "command.pipeline.view"], render: () => <TasksByPerson /> },
  "meeting-points": { label: ["Rencontre d'équipe", "Team meeting"], desc: ["Les points de la semaine", "This week's points"], size: 1, permission: ["team.meeting.view"], render: () => <MeetingPoints /> },
  "board-latest": { label: ["Babillard", "Message board"], desc: ["Les derniers messages aux clients", "The latest messages to clients"], size: 2, permission: ["command.board.view"], render: () => <BoardLatest /> },
  "timesheet-week": { label: ["Feuille de temps", "Timesheet"], desc: ["Mes heures payées de la semaine", "My paid hours this week"], size: 1, permission: ["mytools.timesheet.use"], render: () => <TimesheetWeek /> },
  "clients-count": { label: ["Clients", "Clients"], desc: ["Clients actifs et prospects", "Active clients and prospects"], size: 1, permission: ["clients.view"], render: () => <ClientsCount /> },
  "billing-summary": { label: ["Facturation", "Billing"], desc: ["À approuver, prêt à facturer, à recevoir", "To approve, ready to invoice, receivable"], size: 2, permission: ["accounting.approvals.view", "accounting.invoices.view"], render: () => <BillingSummary /> },
  "bills-to-pay": { label: ["Paiements à faire", "Payments to make"], desc: ["Fournisseurs à payer", "Vendors to pay"], size: 1, permission: ["accounting.vendors.view", "accounting.vendors.manage"], render: () => <BillsToPay /> },
  "quick-links": { label: ["Accès rapide", "Quick links"], desc: ["Raccourcis vers vos pages", "Shortcuts to your pages"], size: 1, render: () => <QuickLinks /> },
};
