import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, ChevronLeft, ChevronRight, Plus, Trash2 } from "lucide-react";
import { api } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { addDays, fmtDate, mondayOf, todayISO, useL, useLocale } from "../../../lib/l";
import { errMsg, FormDialog, type FieldDef } from "../../../components/kit";

interface Day {
  date: string; holiday: { fr: string; en: string } | null;
  events: { id: string; title: string; note: string; startTime: string | null; endTime: string | null; userName: string | null; userId: string | null; eventDate: string }[];
  absences: { id: string; userName: string; kind: string }[];
  tasks: { id: string; title: string; assigneeName: string | null; clientName: string | null }[];
  projects: { id: string; name: string }[];
}

const KINDS = [{ value: "vacation", label: ["Vacances", "Vacation"] }, { value: "sick", label: ["Maladie", "Sick"] }, { value: "training", label: ["Formation", "Training"] }, { value: "personal", label: ["Personnel", "Personal"] }, { value: "other", label: ["Autre", "Other"] }] as { value: string; label: [string, string] }[];

/** La semaine: Monday to Sunday with the team's events, absences, holidays, and what is due each day. */
export function WeekPlanner() {
  const l = useL();
  const loc = useLocale();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [from, setFrom] = useState(mondayOf(todayISO()));
  const [sel, setSel] = useState(todayISO());
  const [dlg, setDlg] = useState<null | { kind: "event"; ev?: Day["events"][number] } | { kind: "absence" }>(null);
  const [error, setError] = useState("");
  const q = useQuery({ queryKey: ["meeting-week", from], queryFn: () => api<{ days: Day[]; today: string }>(`/api/team/meeting/week?from=${from}`), refetchInterval: 30_000 });
  const manage = can("team.meeting.manage");
  const refresh = async () => { await qc.invalidateQueries({ queryKey: ["meeting-week"] }); };
  const days = q.data?.days ?? [];
  const today = todayISO();
  const cur = days.find((d) => d.date === sel) ?? days[0];
  const run = async (fn: () => Promise<unknown>) => { try { setError(""); await fn(); await refresh(); } catch (e) { setError(errMsg(e, "Error")); } };
  const weekday = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(loc, { weekday: "short" });

  const eventFields: FieldDef[] = [
    { name: "title", label: ["Titre", "Title"], required: true, span: 2 }, { name: "date", label: ["Date", "Date"], type: "date", required: true },
    { name: "userId", label: ["Personne (option)", "Person (optional)"], type: "user" }, { name: "start", label: ["De", "From"], placeholder: "09:00" }, { name: "end", label: ["À", "To"], placeholder: "10:00" },
    { name: "note", label: ["Note", "Note"], type: "textarea", rows: 2 },
  ];
  const absFields: FieldDef[] = [
    { name: "userId", label: ["Employé", "Employee"], type: "user", required: true }, { name: "kind", label: ["Type", "Type"], type: "select", required: true, options: KINDS },
    { name: "startsOn", label: ["Du", "From"], type: "date", required: true }, { name: "endsOn", label: ["Au", "To"], type: "date", required: true }, { name: "note", label: ["Note", "Note"], type: "textarea", rows: 2 },
  ];

  return (
    <section className="glass p-5">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="mr-auto font-semibold"><CalendarDays size={16} className="mr-1.5 inline" />{l("La semaine", "The week")}</h2>
        <button className="btn !p-1.5" onClick={() => setFrom(addDays(from, -7))} aria-label="previous"><ChevronLeft size={15} /></button>
        <span className="text-xs text-muted">{fmtDate(from, loc)} → {fmtDate(addDays(from, 6), loc)}</span>
        <button className="btn !p-1.5" onClick={() => setFrom(addDays(from, 7))} aria-label="next"><ChevronRight size={15} /></button>
        <button className="btn !py-1 text-xs" onClick={() => { setFrom(mondayOf(today)); setSel(today); }}>{l("Aujourd'hui", "Today")}</button>
      </div>
      <div className="grid grid-cols-7 gap-1.5">
        {days.map((d) => {
          const n = d.events.length + d.absences.length + d.tasks.length + d.projects.length;
          return (
            <button key={d.date} onClick={() => setSel(d.date)} className="glass-flat p-2 text-center transition hover:brightness-125" style={{ borderColor: d.date === cur?.date ? "var(--brand)" : d.date === today ? "var(--warn)" : undefined, background: d.holiday ? "color-mix(in oklab, var(--ok) 12%, transparent)" : undefined }}>
              <div className="text-[11px] uppercase text-muted">{weekday(d.date)}</div><div className="text-base font-semibold">{d.date.slice(8)}</div>
              <div className="mt-1 flex min-h-[14px] justify-center gap-1">{d.events.length > 0 && <span className="h-1.5 w-1.5 rounded-full bg-[var(--brand)]" />}{d.absences.length > 0 && <span className="h-1.5 w-1.5 rounded-full bg-[var(--warn)]" />}{d.tasks.length > 0 && <span className="h-1.5 w-1.5 rounded-full bg-[var(--brand-2)]" />}{d.holiday && <span className="h-1.5 w-1.5 rounded-full bg-[var(--ok)]" />}</div>
              <div className="text-[10px] text-muted">{n || ""}</div>
            </button>);
        })}
      </div>
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
      {cur && (
        <div className="mt-4 space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-2"><b className="capitalize">{new Date(`${cur.date}T12:00:00`).toLocaleDateString(loc, { weekday: "long", day: "numeric", month: "long" })}</b>
            {cur.holiday && <span className="chip chip-ok">{l(cur.holiday.fr, cur.holiday.en)}</span>}<div className="flex-1" />
            {manage && <><button className="btn !py-1 text-xs" onClick={() => setDlg({ kind: "event" })}><Plus size={13} />{l("Événement", "Event")}</button><button className="btn !py-1 text-xs" onClick={() => setDlg({ kind: "absence" })}><Plus size={13} />{l("Absence", "Absence")}</button></>}</div>
          {cur.events.map((e) => (
            <div key={e.id} className="flex items-start gap-2"><span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-[var(--brand)]" /><div className="flex-1"><button className={manage ? "text-left hover:underline" : "text-left"} onClick={() => manage && setDlg({ kind: "event", ev: e })}>{e.startTime ? `${e.startTime}${e.endTime ? `–${e.endTime}` : ""} · ` : ""}<b>{e.title}</b>{e.userName ? ` · ${e.userName}` : ""}</button>{e.note && <div className="text-xs text-muted">{e.note}</div>}</div>
              {manage && <button className="text-muted hover:text-danger" aria-label="delete event" onClick={() => void run(() => api(`/api/team/meeting/events/${e.id}`, { method: "DELETE" }))}><Trash2 size={13} /></button>}</div>))}
          {cur.absences.map((a) => (
            <div key={a.id} className="flex items-center gap-2"><span className="h-2 w-2 shrink-0 rounded-full bg-[var(--warn)]" /><span className="flex-1">{a.userName} <span className="text-xs text-muted">· {KINDS.find((k) => k.value === a.kind)?.label[loc === "en-CA" ? 1 : 0] ?? a.kind}</span></span>
              {manage && <button className="text-muted hover:text-danger" aria-label="delete absence" onClick={() => void run(() => api(`/api/team/meeting/absences/${a.id}`, { method: "DELETE" }))}><Trash2 size={13} /></button>}</div>))}
          {cur.projects.map((p) => <div key={p.id} className="flex items-center gap-2"><span className="h-2 w-2 shrink-0 rounded-full bg-[var(--danger)]" /><span>{l("Dossier à livrer", "Engagement due")} : <b>{p.name}</b></span></div>)}
          {cur.tasks.map((t) => <div key={t.id} className="flex items-center gap-2"><span className="h-2 w-2 shrink-0 rounded-full bg-[var(--brand-2)]" /><span className="text-muted">{t.title}{t.clientName ? ` · ${t.clientName}` : ""}{t.assigneeName ? ` · ${t.assigneeName}` : ""}</span></div>)}
          {!cur.events.length && !cur.absences.length && !cur.tasks.length && !cur.projects.length && !cur.holiday && <p className="text-muted">{l("Rien de prévu ce jour-là.", "Nothing planned that day.")}</p>}
        </div>)}

      {dlg?.kind === "event" && <FormDialog title={dlg.ev ? l("Modifier l'événement", "Edit event") : l("Nouvel événement", "New event")} fields={eventFields} initial={dlg.ev ? { title: dlg.ev.title, date: dlg.ev.eventDate?.slice(0, 10), userId: dlg.ev.userId ?? "", start: dlg.ev.startTime ?? "", end: dlg.ev.endTime ?? "", note: dlg.ev.note } : { date: cur?.date }}
        onSubmit={async (v) => { const b = { date: v.date, title: v.title, note: v.note ?? "", userId: v.userId || null, start: v.start || null, end: v.end || null }; if (dlg.ev) await api(`/api/team/meeting/events/${dlg.ev.id}`, { method: "PUT", body: b }); else await api("/api/team/meeting/events", { body: b }); await refresh(); }} onClose={() => setDlg(null)} />}
      {dlg?.kind === "absence" && <FormDialog title={l("Nouvelle absence", "New absence")} fields={absFields} initial={{ kind: "vacation", startsOn: cur?.date, endsOn: cur?.date }}
        onSubmit={async (v) => { await api("/api/team/meeting/absences", { body: { userId: v.userId, kind: v.kind, startsOn: v.startsOn, endsOn: v.endsOn, note: v.note ?? "" } }); await refresh(); await qc.invalidateQueries({ queryKey: ["hr-absences"] }); }} onClose={() => setDlg(null)} />}
    </section>
  );
}
