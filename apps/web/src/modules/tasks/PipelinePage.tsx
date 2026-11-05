import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarOff, ChevronLeft, ChevronRight, Plus, Repeat, Star } from "lucide-react";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { addDays, fmtDate, hours, todayISO, useL, useLocale } from "../../lib/l";
import { Chip, Empty, errMsg, Tabs } from "../../components/kit";
import { PageHeader } from "../../components/ui";
import TaskDialog from "./TaskDialog";
import { priorityLabel, priorityTone, statusLabel, type TaskRow } from "./TasksPage";

interface Item { id: string; title: string | null; private: boolean; status: string; priority: string; kind: string; dueDate: string | null; dueTime: string | null; clientName: string | null; minutes: number; late: boolean; checklistTotal: number; checklistDone: number; checkpoint: boolean }
interface Block { kind: "task" | "event" | "lunch"; start: string; end: string; title: string | null; taskId?: string; priority?: string; private?: boolean }
interface DayPlan {
  date: string; userId: string; own: boolean; dayOff: string | null; dayOffName: { fr: string; en: string } | null; capacityMinutes: number; plannedMinutes: number; freeMinutes: number;
  settings: { workStart: string; workEnd: string }; items: Item[]; waiting: { id: string; title: string | null }[]; blocks: Block[]; overflow: Item[];
  week: { id: string; title: string | null; private: boolean; priority: string; dueDate: string | null; clientName: string | null }[]; nowMinutes: number | null;
}
const COLUMNS = ["todo", "taken", "doing", "blocked", "done"] as const;
const SPLIT_KEY = "hexa.pipeline.split";
const HOUR_KEY = "hexa.pipeline.hourPx";
const mins = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));

/** Pipeline: "My day" (what is on the plate and how it fits the working day) and a status board. */
export default function PipelinePage() {
  const l = useL();
  const { can } = useAuth();
  const [view, setView] = useState<"day" | "board">("day");
  const [dialog, setDialog] = useState<{ id: string | null } | null>(null);
  return (
    <>
      <PageHeader title={l("Pipeline", "Pipeline")} subtitle={l("Ma journée : ce qui est à faire et comment ça tient dans la journée", "My day: what is to do and how it fits the day")}
        actions={can("tasks.edit", "tasks.manage", "command.pipeline.edit") && <button className="btn btn-primary" onClick={() => setDialog({ id: null })}><Plus size={16} />{l("Nouvelle tâche", "New task")}</button>} />
      <Tabs tabs={[{ key: "day", label: l("Ma journée", "My day") }, { key: "board", label: l("Tableau", "Board") }]} value={view} onChange={setView} />
      {view === "day" ? <MyDay onOpen={(id) => setDialog({ id })} /> : <Board onOpen={(id) => setDialog({ id })} />}
      {dialog && <TaskDialog taskId={dialog.id} onClose={() => setDialog(null)} />}
    </>
  );
}

function MyDay({ onOpen }: { onOpen: (id: string) => void }) {
  const l = useL();
  const loc = useLocale();
  const { can, me } = useAuth();
  const qc = useQueryClient();
  const [date, setDate] = useState(todayISO());
  const [who, setWho] = useState("");
  const [quick, setQuick] = useState("");
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");
  const [split, setSplit] = useState<number>(() => { try { return Number(localStorage.getItem(SPLIT_KEY)) || 58; } catch { return 58; } });
  const [hourPx, setHourPx] = useState<number>(() => { try { return Number(localStorage.getItem(HOUR_KEY)) || 56; } catch { return 56; } });
  const box = useRef<HTMLDivElement>(null);
  const people = useQuery({ queryKey: ["pipeline-people"], queryFn: () => api<{ id: string; name: string }[]>("/api/pipeline/people"), enabled: can("command.pipeline.manage") });
  const q = useQuery({ queryKey: ["pipeline", "day", date, who], queryFn: () => api<DayPlan>(`/api/pipeline/day?date=${date}${who ? `&userId=${who}` : ""}`), refetchInterval: 60_000 });
  const mine = useQuery({ queryKey: ["pipeline", "mine"], queryFn: () => api<TaskRow[]>("/api/tasks?assignee=me&status=open&parent=none"), enabled: !who });
  const d = q.data;
  const refresh = async () => { await qc.invalidateQueries({ queryKey: ["pipeline"] }); await qc.invalidateQueries({ queryKey: ["tasks"] }); await qc.invalidateQueries({ queryKey: ["w-open-tasks"] }); };
  const act = async (fn: () => Promise<unknown>) => { try { setError(""); await fn(); await refresh(); } catch (e) { setError(errMsg(e, "Error")); } };
  const done = (id: string) => act(() => api(`/api/tasks/${id}`, { method: "PATCH", body: { status: "done" } }));
  const start = (id: string) => act(() => api(`/api/tasks/${id}`, { method: "PATCH", body: { status: "doing" } }));
  const check = (id: string) => act(() => api(`/api/pipeline/tasks/${id}/check`, { body: { date } }));

  // The bar between the two sides is dragged with the mouse (double-click puts it back).
  const drag = (e: React.MouseEvent) => {
    e.preventDefault();
    const move = (ev: MouseEvent) => { const r = box.current!.getBoundingClientRect(); const pct = Math.min(75, Math.max(30, ((ev.clientX - r.left) / r.width) * 100)); setSplit(pct); try { localStorage.setItem(SPLIT_KEY, String(Math.round(pct))); } catch { /* ignore */ } };
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  };
  useEffect(() => { try { localStorage.setItem(HOUR_KEY, String(hourPx)); } catch { /* ignore */ } }, [hourPx]);

  if (!d) return null;
  const today = todayISO();
  const ws = mins(d.settings.workStart), we = mins(d.settings.workEnd);
  const from = Math.floor(ws / 60) * 60, to = Math.ceil(we / 60) * 60;
  const tone = (p?: string) => (p === "urgent" ? "var(--danger)" : p === "high" ? "var(--warn)" : "var(--brand)");
  const mineRows = mine.data ?? [];
  const pageRows = mineRows.slice((page - 1) * 10, page * 10);
  const short = d.freeMinutes < 0;

  const title = (i: { title: string | null; private?: boolean }) => (i.private ? l("Tâche privée", "Private task") : i.title);
  const TaskRowItem = ({ it }: { it: Item }) => (
    <li className="glass-flat flex items-start gap-3 p-3 text-sm">
      {d.own && <input type="checkbox" className="mt-1 h-4 w-4 accent-[var(--brand)]" checked={false} onChange={() => void (it.kind === "continuous" ? check(it.id) : done(it.id))} aria-label={it.kind === "continuous" ? l("Vérifié", "Checked") : l("Terminer", "Complete")} />}
      <button className="min-w-0 flex-1 text-left" onClick={() => !it.private && onOpen(it.id)}>
        <div className="font-medium">{title(it)}{it.kind === "daily" && <Repeat size={12} className="ml-1.5 inline text-muted" />}{it.checkpoint && <span className="ml-1.5 text-xs text-warn">{l("point de contrôle", "checkpoint")}</span>}</div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted"><Chip tone={priorityTone(it.priority)}>{priorityLabel(l, it.priority)}</Chip>{it.clientName && <span>{it.clientName}</span>}
          {it.dueDate && <span style={{ color: it.late ? "var(--danger)" : undefined }}>· {fmtDate(it.dueDate, loc)}{it.dueTime ? ` ${it.dueTime}` : ""}</span>}<span>· {it.minutes} min</span>{it.checklistTotal > 0 && <span>· ☑ {it.checklistDone}/{it.checklistTotal}</span>}</div>
      </button>
      {d.own && it.status !== "doing" && it.kind !== "continuous" && <button className="btn !px-2 !py-1 text-xs" onClick={() => void start(it.id)}>{l("Commencer", "Start")}</button>}
    </li>
  );

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button className="btn !p-2" onClick={() => setDate(addDays(date, -1))} aria-label="prev"><ChevronLeft size={16} /></button>
        <div className="glass-flat px-4 py-2 text-sm font-medium capitalize">{new Date(`${date}T12:00:00`).toLocaleDateString(loc, { weekday: "long", day: "numeric", month: "long" })}</div>
        <button className="btn !p-2" onClick={() => setDate(addDays(date, 1))} aria-label="next"><ChevronRight size={16} /></button>
        {date !== today && <button className="btn" onClick={() => setDate(today)}>{l("Aujourd'hui", "Today")}</button>}
        {can("command.pipeline.manage") && <select className="input !w-auto" value={who} onChange={(e) => setWho(e.target.value)} aria-label="person"><option value="">{l("Ma journée", "My day")}</option>{people.data?.filter((p) => p.id !== me.user?.id).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}
        <div className="flex-1" />
        {d.dayOff ? <Chip tone="warn"><CalendarOff size={12} />{d.dayOff === "holiday" && d.dayOffName ? l(d.dayOffName.fr, d.dayOffName.en) : d.dayOff === "weekend" ? l("Fin de semaine", "Weekend") : l("Absence", "Away")}</Chip>
          : <span className="text-sm"><b>{hours(d.plannedMinutes)}</b> {l("planifiées sur", "planned of")} <b>{hours(d.capacityMinutes)}</b> · <span style={{ color: short ? "var(--danger)" : "var(--ok)" }}>{short ? `${l("manque", "short by")} ${hours(-d.freeMinutes)}` : `${hours(d.freeMinutes)} ${l("libres", "free")}`}</span></span>}
      </div>
      {!d.dayOff && <div className="mb-4 h-2 rounded-full bg-white/10"><div className="h-full rounded-full" style={{ width: `${Math.min(100, d.capacityMinutes ? (d.plannedMinutes / d.capacityMinutes) * 100 : 0)}%`, background: short ? "var(--danger)" : "linear-gradient(90deg, var(--brand), var(--brand-2))" }} /></div>}
      {error && <p role="alert" className="mb-3 text-sm text-danger">{error}</p>}

      <div ref={box} className="flex flex-col gap-4 lg:flex-row lg:gap-0">
        <div className="min-w-0 space-y-4 lg:pr-3" style={{ flexBasis: `${split}%` }}>
          <section className="glass p-4">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">{l("Priorités de la journée", "Priorities of the day")}<span className="chip">{d.items.length}</span></h2>
            {d.items.length === 0 ? <Empty>🎉 {d.dayOff ? l("Journée de congé.", "Day off.") : l("Rien d'urgent ce jour-là.", "Nothing urgent that day.")}</Empty> : <ul className="space-y-2">{d.items.map((it) => <TaskRowItem key={it.id} it={it} />)}</ul>}
            {d.overflow.length > 0 && !d.dayOff && <p className="mt-3 text-xs text-warn">{d.overflow.length} {l("tâche(s) ne tiennent pas dans la journée.", "task(s) do not fit in the day.")}</p>}
            {d.waiting.length > 0 && <p className="mt-2 text-xs text-muted">⏳ {l("En attente d'une autre tâche", "Waiting for another task")}: {d.waiting.map((w) => w.title ?? l("tâche privée", "private task")).join(", ")}</p>}
          </section>

          <section className="glass p-4">
            <div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-semibold">{l("Blocs de la journée", "Blocks of the day")}</h2>
              <label className="flex items-center gap-2 text-[11px] text-muted">{l("Hauteur", "Height")}<input type="range" min={36} max={110} value={hourPx} onChange={(e) => setHourPx(Number(e.target.value))} className="accent-[var(--brand)]" /></label></div>
            {d.dayOff ? <p className="text-sm text-muted">—</p> : (
              <div className="relative" style={{ height: ((to - from) / 60) * hourPx }}>
                {Array.from({ length: (to - from) / 60 + 1 }, (_, i) => <div key={i} className="absolute left-0 right-0 border-t border-white/10 text-[10px] text-muted" style={{ top: i * hourPx }}><span className="-mt-2 block w-10 bg-transparent">{String(from / 60 + i).padStart(2, "0")}:00</span></div>)}
                {d.blocks.map((b, i) => {
                  const top = ((mins(b.start) - from) / 60) * hourPx, h = Math.max(18, ((mins(b.end) - mins(b.start)) / 60) * hourPx - 2);
                  const bg = b.kind === "lunch" ? "rgba(255,255,255,0.06)" : b.kind === "event" ? "color-mix(in oklab, var(--brand-2) 35%, transparent)" : `color-mix(in oklab, ${tone(b.priority)} 38%, transparent)`;
                  return <button key={i} disabled={b.kind !== "task" || b.private} onClick={() => b.taskId && onOpen(b.taskId)} className="absolute left-12 right-1 overflow-hidden rounded-lg px-2 py-0.5 text-left text-xs" style={{ top, height: h, background: bg, border: "1px solid rgba(255,255,255,0.12)" }}>
                    <b>{b.start}</b> {b.kind === "lunch" ? l("Dîner", "Lunch") : b.kind === "event" ? `📅 ${b.title}` : b.private ? l("Tâche privée", "Private task") : b.title}</button>;
                })}
                {d.nowMinutes !== null && d.nowMinutes >= from && d.nowMinutes <= to && <div className="pointer-events-none absolute left-10 right-0 border-t-2 border-[var(--danger)]" style={{ top: ((d.nowMinutes - from) / 60) * hourPx }} />}
              </div>)}
          </section>
        </div>

        <div className="hidden w-3 shrink-0 cursor-col-resize items-center justify-center lg:flex" onMouseDown={drag} onDoubleClick={() => { setSplit(58); try { localStorage.removeItem(SPLIT_KEY); } catch { /* ignore */ } }} title={l("Glisser pour redimensionner (double-clic : rétablir)", "Drag to resize (double-click: reset)")}><div className="h-16 w-1 rounded-full bg-white/20" /></div>

        <div className="min-w-0 flex-1 space-y-4 lg:pl-3">
          {can("tasks.edit", "tasks.manage", "command.pipeline.edit") && !who && (
            <form className="glass flex gap-2 p-3" onSubmit={(e) => { e.preventDefault(); if (quick.trim()) void act(async () => { await api("/api/tasks", { body: { title: quick.trim(), dueDate: date } }); setQuick(""); }); }}>
              <input className="input" placeholder={l("Ajouter une tâche pour ce jour…", "Add a task for this day…")} value={quick} onChange={(e) => setQuick(e.target.value)} /><button className="btn btn-primary" aria-label="add"><Plus size={16} /></button></form>)}
          <section className="glass p-4">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold"><Star size={14} className="text-warn" />{l("Priorités de la semaine", "Priorities of the week")}<span className="chip">{d.week.length}</span></h2>
            {!d.week.length ? <p className="text-sm text-muted">—</p> : <ul className="space-y-1.5 text-sm">{d.week.map((t) => <li key={t.id} className="flex items-center justify-between gap-2"><button className="truncate text-left hover:underline" onClick={() => !t.private && onOpen(t.id)}>{t.private ? l("Tâche privée", "Private task") : t.title}{t.clientName && <span className="text-xs text-muted"> · {t.clientName}</span>}</button><span className="shrink-0 text-xs" style={{ color: t.dueDate && t.dueDate < d.date ? "var(--danger)" : "var(--muted)" }}>{fmtDate(t.dueDate, loc)}</span></li>)}</ul>}
          </section>
          {!who && (
            <section className="glass p-4">
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">{l("Toutes mes tâches", "All my tasks")}<span className="chip">{mineRows.length}</span></h2>
              {!pageRows.length ? <p className="text-sm text-muted">—</p> : <ul className="space-y-1.5 text-sm">{pageRows.map((t) => <li key={t.id} className="flex items-center justify-between gap-2"><button className="truncate text-left hover:underline" onClick={() => onOpen(t.id)}>{t.title}{t.clientName && <span className="text-xs text-muted"> · {t.clientName}</span>}</button><span className="shrink-0 text-xs text-muted">{fmtDate(t.dueDate, loc)}</span></li>)}</ul>}
              {mineRows.length > 10 && <div className="mt-3 flex items-center justify-end gap-2 text-xs text-muted"><button className="btn !p-1" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="prev"><ChevronLeft size={13} /></button>{page} / {Math.ceil(mineRows.length / 10)}<button className="btn !p-1" disabled={page * 10 >= mineRows.length} onClick={() => setPage(page + 1)} aria-label="next"><ChevronRight size={13} /></button></div>}
            </section>)}
        </div>
      </div>
    </>
  );
}

function Board({ onOpen }: { onOpen: (id: string) => void }) {
  const l = useL();
  const loc = useLocale();
  const qc = useQueryClient();
  const [scope, setScope] = useState<"me" | "all">("me");
  const [dragId, setDragId] = useState<string | null>(null);
  const board = useQuery({ queryKey: ["pipeline", "board", scope], queryFn: () => api<TaskRow[]>(`/api/tasks?${scope === "me" ? "assignee=me&" : ""}parent=none&status=all`) });
  const move = async (id: string, status: string) => {
    try { await api(`/api/tasks/${id}`, { method: "PATCH", body: { status } }); await qc.invalidateQueries({ queryKey: ["pipeline"] }); await qc.invalidateQueries({ queryKey: ["tasks"] }); }
    catch (e) { alert(e instanceof Error ? e.message : "Error"); }
  };
  return (
    <>
      <div className="mb-3 flex justify-end"><Tabs tabs={[{ key: "me", label: l("Mes tâches", "My tasks") }, { key: "all", label: l("Équipe", "Team") }]} value={scope} onChange={setScope} /></div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        {COLUMNS.map((s) => {
          const rows = (board.data ?? []).filter((t) => t.status === s);
          return (
            <section key={s} className="glass min-h-[240px] p-3" onDragOver={(e) => e.preventDefault()} onDrop={() => { if (dragId) { void move(dragId, s); setDragId(null); } }}>
              <h2 className="mb-3 flex items-center gap-2 px-1 text-sm font-semibold">{statusLabel(l, s)}<span className="chip">{rows.length}</span></h2>
              <div className="space-y-2">{rows.map((t) => (
                <div key={t.id} draggable onDragStart={() => setDragId(t.id)} onClick={() => onOpen(t.id)} className="glass-flat cursor-pointer p-3 text-sm transition hover:bg-white/10">
                  <div className="font-medium">{t.title}{t.isWaiting && " ⏳"}{t.recurrence ? " ↻" : ""}</div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted"><Chip tone={priorityTone(t.priority)}>{priorityLabel(l, t.priority)}</Chip>{t.clientName && <span>{t.clientName}</span>}{t.dueDate && <span>· {fmtDate(t.dueDate, loc)}</span>}{t.checklistTotal > 0 && <span>· ☑ {t.checklistDone}/{t.checklistTotal}</span>}</div>
                </div>))}</div>
            </section>
          );
        })}
      </div>
    </>
  );
}
