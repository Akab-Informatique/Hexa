import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Plus, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { addDays, fmtDate, mondayOf, todayISO, useL, useLocale } from "../../lib/l";
import { Chip, errMsg, Stat } from "../../components/kit";
import { PageHeader } from "../../components/ui";
import { priorityLabel, priorityTone } from "../tasks/TasksPage";

interface Point { id: string; kind: "point" | "hot" | "issue"; title: string; body: string; done: boolean; authorId: string | null; authorName: string | null }
interface Meeting {
  week: string; weekEnd: string; points: Point[];
  hot: { id: string; title: string; status: string; priority: string; dueDate: string | null; assigneeName: string | null }[];
  absences: { id: string; userName: string; kind: string; startsOn: string; endsOn: string }[];
  stats: { overdue: number; dueThisWeek: number; unassigned: number; blocked: number };
  review: { weekStart: string; opened: number; closed: number; stillOpen: { id: string; title: string; priority: string; dueDate: string | null; assigneeName: string | null }[] }[];
}

/** Weekly team meeting: points to discuss, issues, this week's hot tasks, and a review of past weeks. */
export default function MeetingPage() {
  const l = useL();
  const loc = useLocale();
  const { can, me } = useAuth();
  const qc = useQueryClient();
  const [week, setWeek] = useState(mondayOf(todayISO()));
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<"point" | "issue">("point");
  const [error, setError] = useState("");
  const q = useQuery({ queryKey: ["meeting", week], queryFn: () => api<Meeting>(`/api/team/meeting?week=${week}`), refetchInterval: 15_000 });
  const m = q.data;
  const edit = can("team.meeting.edit", "team.meeting.manage");
  const refresh = () => qc.invalidateQueries({ queryKey: ["meeting"] });
  const run = async (fn: () => Promise<unknown>) => { try { setError(""); await fn(); await refresh(); } catch (e) { setError(errMsg(e, "Error")); } };
  if (!m) return null;

  const PointList = ({ items, empty }: { items: Point[]; empty: string }) => (
    items.length === 0 ? <p className="text-sm text-muted">{empty}</p> : (
      <ul className="space-y-1.5">{items.map((p) => (
        <li key={p.id} className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1 h-4 w-4 accent-[var(--brand)]" checked={p.done} disabled={!edit} onChange={(e) => void run(() => api(`/api/team/meeting/points/${p.id}`, { method: "PATCH", body: { done: e.target.checked } }))} aria-label={p.title} />
          <div className="min-w-0 flex-1"><span className={p.done ? "text-muted line-through" : ""}>{p.title}</span><span className="ml-2 text-xs text-muted">{p.authorName}</span></div>
          {edit && (p.authorId === me.user?.id || can("team.meeting.manage")) && <button className="text-muted hover:text-danger" onClick={() => void run(() => api(`/api/team/meeting/points/${p.id}`, { method: "DELETE" }))} aria-label="delete"><Trash2 size={13} /></button>}
        </li>))}</ul>)
  );

  return (
    <>
      <PageHeader title={l("Rencontre d'équipe", "Team meeting")} subtitle={`${fmtDate(m.week, loc)} → ${fmtDate(m.weekEnd, loc)}`}
        actions={<div className="flex items-center gap-2"><button className="btn !p-2" onClick={() => setWeek(addDays(week, -7))} aria-label="previous"><ChevronLeft size={16} /></button><button className="btn" onClick={() => setWeek(mondayOf(todayISO()))}>{l("Cette semaine", "This week")}</button><button className="btn !p-2" onClick={() => setWeek(addDays(week, 7))} aria-label="next"><ChevronRight size={16} /></button></div>} />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label={l("En retard", "Overdue")} value={m.stats.overdue} tone={m.stats.overdue ? "danger" : undefined} />
        <Stat label={l("À échéance cette semaine", "Due this week")} value={m.stats.dueThisWeek} />
        <Stat label={l("Non assignées", "Unassigned")} value={m.stats.unassigned} tone={m.stats.unassigned ? "warn" : undefined} />
        <Stat label={l("Bloquées", "Blocked")} value={m.stats.blocked} tone={m.stats.blocked ? "warn" : undefined} />
      </div>
      {error && <p role="alert" className="mb-3 text-sm text-danger">{error}</p>}

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="glass p-5">
          <h2 className="mb-3 font-semibold">{l("Points à discuter", "Points to discuss")}</h2>
          <PointList items={m.points.filter((p) => p.kind !== "issue")} empty={l("Aucun point pour cette semaine.", "No points for this week.")} />
          <h2 className="mb-3 mt-6 font-semibold">{l("Problèmes à régler", "Issues to solve")}</h2>
          <PointList items={m.points.filter((p) => p.kind === "issue")} empty={l("Aucun problème signalé.", "No issues raised.")} />
          {edit && (
            <form className="mt-5 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (title.trim()) void run(async () => { await api("/api/team/meeting/points", { body: { weekStart: week, kind, title: title.trim() } }); setTitle(""); }); }}>
              <select className="input !w-auto" value={kind} onChange={(e) => setKind(e.target.value as "point" | "issue")} aria-label="kind"><option value="point">{l("Point", "Point")}</option><option value="issue">{l("Problème", "Issue")}</option></select>
              <input className="input" placeholder={l("Ajouter à l'ordre du jour…", "Add to the agenda…")} value={title} onChange={(e) => setTitle(e.target.value)} />
              <button className="btn btn-primary" aria-label="add"><Plus size={16} /></button>
            </form>
          )}
        </section>

        <section className="glass p-5">
          <h2 className="mb-3 font-semibold">🔥 {l("Tâches chaudes de la semaine", "Hot tasks this week")}</h2>
          {m.hot.length === 0 ? <p className="text-sm text-muted">{l("Aucune tâche urgente ou prioritaire.", "No urgent or high-priority tasks.")}</p> : (
            <ul className="space-y-2 text-sm">{m.hot.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-2"><span className={t.status === "done" ? "text-muted line-through" : ""}>{t.title}<span className="ml-2 text-xs text-muted">{t.assigneeName}</span></span><Chip tone={priorityTone(t.priority)}>{priorityLabel(l, t.priority)}</Chip></li>))}</ul>)}
          <h2 className="mb-3 mt-6 font-semibold">🏖 {l("Absences", "Absences")}</h2>
          {m.absences.length === 0 ? <p className="text-sm text-muted">—</p> : <ul className="space-y-1 text-sm">{m.absences.map((a) => <li key={a.id}>{a.userName} <span className="text-xs text-muted">· {a.kind} · {fmtDate(a.startsOn, loc)} → {fmtDate(a.endsOn, loc)}</span></li>)}</ul>}
        </section>
      </div>

      <section className="glass mt-4 p-5">
        <h2 className="mb-1 font-semibold">{l("Revue des semaines passées", "Review of past weeks")}</h2>
        <p className="mb-4 text-sm text-muted">{l("Tâches ouvertes et fermées, et ce qui reste ouvert.", "Tasks opened and closed, and what is still open.")}</p>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {m.review.map((w) => (
            <div key={w.weekStart} className="glass-flat p-3">
              <div className="mb-2 text-xs text-muted">{l("Semaine du", "Week of")} {fmtDate(w.weekStart, loc)}</div>
              <div className="mb-2 flex gap-4 text-sm"><span>＋ {w.opened} <span className="text-xs text-muted">{l("ouvertes", "opened")}</span></span><span className="text-ok">✓ {w.closed} <span className="text-xs text-muted">{l("fermées", "closed")}</span></span></div>
              {w.stillOpen.length > 0 && <ul className="space-y-1 text-xs">{w.stillOpen.slice(0, 5).map((t) => <li key={t.id} className="text-warn">○ {t.title}</li>)}{w.stillOpen.length > 5 && <li className="text-muted">+{w.stillOpen.length - 5}</li>}</ul>}
            </div>))}
        </div>
      </section>
    </>
  );
}
