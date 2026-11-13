import { Fragment, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarOff, ChevronLeft, ChevronRight, GripVertical, Lock, Plus, Repeat, RotateCcw, Star } from "lucide-react";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { addDays, fmtDate, hours, todayISO, useL, useLocale } from "../../lib/l";
import { Chip, Empty, errMsg, Tabs } from "../../components/kit";
import { Modal, PageHeader } from "../../components/ui";
import TaskDialog from "./TaskDialog";
import { priorityLabel, priorityTone, statusLabel, type TaskRow } from "./TasksPage";

interface Item { id: string; title: string | null; private: boolean; status: string; priority: string; kind: string; dueDate: string | null; dueTime: string | null; clientName: string | null; minutes: number; late: boolean; checklistTotal: number; checklistDone: number; checkpoint: boolean }
interface Block { kind: "task" | "event" | "lunch" | "reserved"; start: string; end: string; title: string | null; taskId?: string; priority?: string; private?: boolean; id?: string; pinned?: boolean }
interface BlockDraft { id?: string; title: string; start: string; end: string }
const clockOf = (n: number) => `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
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
      <PageHeader title={l("Opérations", "Operations")} subtitle={l("Ma journée : ce qui est à faire et comment ça tient dans la journée", "My day: what is to do and how it fits the day")}
        actions={can("tasks.edit", "tasks.manage", "command.pipeline.edit") && <button className="btn btn-primary" onClick={() => setDialog({ id: null })}><Plus size={16} />{l("Nouvelle tâche", "New task")}</button>} />
      <Tabs tabs={[{ key: "day", label: l("Ma journée", "My day") }, { key: "board", label: l("Tableau", "Board") }]} value={view} onChange={setView} />
      {view === "day" ? <MyDay onOpen={(id) => setDialog({ id })} /> : <Board onOpen={(id) => setDialog({ id })} />}
      {dialog && <TaskDialog taskId={dialog.id} onClose={() => setDialog(null)} />}
    </>
  );
}

type PanelId = "blocks" | "all" | "prio" | "week" | "quick";
interface Layout { left: PanelId[]; right: PanelId[] }
const DEFAULT_LAYOUT: Layout = { left: ["blocks", "all"], right: ["prio", "week", "quick"] };
const LAYOUT_KEY = "hexa.pipeline.layout";
const HEIGHTS_KEY = "hexa.pipeline.heights";
function loadLayout(): Layout {
  try {
    const j = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "null") as Layout | null;
    const all = [...(j?.left ?? []), ...(j?.right ?? [])];
    if (j && all.length === 5 && new Set(all).size === 5 && DEFAULT_LAYOUT.left.concat(DEFAULT_LAYOUT.right).every((x) => all.includes(x))) return j;
  } catch { /* ignore */ }
  return DEFAULT_LAYOUT;
}

/** A movable (grip, top right) and resizable (bar, bottom) section; both are remembered in this browser. */
function Panel({ height, setHeight, onDragStart, onDrop, label, resetLabel, bare, children }: { height?: number; setHeight: (h: number | null) => void; onDragStart: () => void; onDrop: () => void; label: string; resetLabel: string; bare?: boolean; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const resize = (e: React.MouseEvent) => {
    e.preventDefault();
    const top = ref.current!.getBoundingClientRect().top;
    const move = (ev: MouseEvent) => setHeight(Math.round(Math.min(1600, Math.max(120, ev.clientY - top))));
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  };
  return (
    <div ref={ref} className="group relative" onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }} onDrop={(e) => { e.preventDefault(); e.stopPropagation(); onDrop(); }}>
      <section className={bare ? "" : "glass p-4"} style={height ? { height, overflowY: "auto" } : undefined}>{children}</section>
      <button draggable onDragStart={(e) => { if (ref.current) e.dataTransfer.setDragImage(ref.current, 20, 10); e.dataTransfer.setData("text/plain", "panel"); onDragStart(); }} className="absolute right-2 top-2 z-10 cursor-grab rounded p-1 text-muted opacity-40 hover:opacity-100 group-hover:opacity-80" title={label} aria-label={label}><GripVertical size={14} /></button>
      {!bare && <div className="absolute inset-x-0 -bottom-1 z-10 flex h-3 cursor-row-resize items-center justify-center" onMouseDown={resize} onDoubleClick={() => setHeight(null)} title={resetLabel}><div className="h-1 w-12 rounded-full bg-white/15 group-hover:bg-white/35" /></div>}
    </div>
  );
}

/** Create, change or remove a reserved block: time set aside by hand, neither a task nor a calendar event. */
function BlockDialog({ date, draft, onClose, onDone }: { date: string; draft: BlockDraft; onClose: () => void; onDone: () => Promise<void> }) {
  const l = useL();
  const [title, setTitle] = useState(draft.title);
  const [start, setStart] = useState(draft.start);
  const [end, setEnd] = useState(draft.end);
  const [error, setError] = useState("");
  const valid = title.trim().length > 0 && start < end;
  const save = async () => {
    try {
      if (draft.id) await api(`/api/pipeline/blocks/${draft.id}`, { method: "PATCH", body: { title: title.trim(), start, end } });
      else await api("/api/pipeline/blocks", { body: { date, title: title.trim(), start, end } });
      await onDone();
    } catch (e) { setError(errMsg(e, "Error")); }
  };
  return (
    <Modal title={draft.id ? l("Bloc réservé", "Reserved block") : l("Nouveau bloc réservé", "New reserved block")} onClose={onClose}>
      <p className="mb-3 text-xs text-muted">{l("Du temps mis de côté dans votre journée (formation, déplacement, travail concentré…). Les tâches se placent autour.", "Time set aside in your day (training, travel, focus work…). Tasks are laid out around it.")}</p>
      <label className="mb-3 block"><span className="label">{l("Titre", "Title")}</span><input className="input" autoFocus value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && valid) void save(); }} /></label>
      <div className="mb-3 grid grid-cols-2 gap-3">
        <label className="block"><span className="label">{l("Début", "Start")}</span><input className="input" type="time" step={300} value={start} onChange={(e) => setStart(e.target.value)} /></label>
        <label className="block"><span className="label">{l("Fin", "End")}</span><input className="input" type="time" step={300} value={end} onChange={(e) => setEnd(e.target.value)} /></label>
      </div>
      {error && <p role="alert" className="mb-3 text-sm text-danger">{error}</p>}
      <div className="flex flex-wrap justify-between gap-2">
        {draft.id ? <button className="btn btn-danger" onClick={() => void api(`/api/pipeline/blocks/${draft.id}`, { method: "DELETE" }).then(onDone).catch((e) => setError(errMsg(e, "Error")))}>{l("Supprimer", "Delete")}</button> : <span />}
        <div className="flex gap-2"><button className="btn" onClick={onClose}>{l("Annuler", "Cancel")}</button><button className="btn btn-primary" disabled={!valid} onClick={() => void save()}>{l("Enregistrer", "Save")}</button></div>
      </div>
    </Modal>
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
  const [layout, setLayout] = useState<Layout>(loadLayout);
  const [heights, setHeights] = useState<Record<string, number>>(() => { try { return JSON.parse(localStorage.getItem(HEIGHTS_KEY) ?? "{}"); } catch { return {}; } });
  const [dragId, setDragId] = useState<PanelId | null>(null);
  const [moving, setMoving] = useState<{ key: string; start: number; end: number } | null>(null); // a block being dragged in the day
  const [blockDlg, setBlockDlg] = useState<BlockDraft | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  const justMoved = useRef(false);
  const saveLayout = (n: Layout) => { setLayout(n); try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(n)); } catch { /* ignore */ } };
  const setHeight = (id: string, h: number | null) => setHeights((cur) => { const n = { ...cur }; if (h === null) delete n[id]; else n[id] = h; try { localStorage.setItem(HEIGHTS_KEY, JSON.stringify(n)); } catch { /* ignore */ } return n; });
  /** Drops the dragged panel before another one, or at the end of a column. */
  const dropOn = (col: "left" | "right", before: PanelId | null) => {
    if (!dragId || dragId === before) { setDragId(null); return; }
    const n: Layout = { left: layout.left.filter((x) => x !== dragId), right: layout.right.filter((x) => x !== dragId) };
    const i = before ? n[col].indexOf(before) : -1;
    n[col].splice(i < 0 ? n[col].length : i, 0, dragId);
    setDragId(null); saveLayout(n);
  };
  const resetLayout = () => { saveLayout(DEFAULT_LAYOUT); setHeights({}); try { localStorage.removeItem(HEIGHTS_KEY); } catch { /* ignore */ } };
  const box = useRef<HTMLDivElement>(null);
  const people = useQuery({ queryKey: ["pipeline-people"], queryFn: () => api<{ id: string; name: string }[]>("/api/pipeline/people"), enabled: can("command.pipeline.manage") });
  const q = useQuery({ queryKey: ["pipeline", "day", date, who], queryFn: () => api<DayPlan>(`/api/pipeline/day?date=${date}${who ? `&userId=${who}` : ""}`), refetchInterval: 60_000 });
  const mine = useQuery({ queryKey: ["pipeline", "mine"], queryFn: () => api<TaskRow[]>("/api/tasks?assignee=me&status=open&parent=none"), enabled: !who });
  const d = q.data;
  const refresh = async () => { await qc.invalidateQueries({ queryKey: ["pipeline"] }); await qc.invalidateQueries({ queryKey: ["tasks"] }); await qc.invalidateQueries({ queryKey: ["w-open-tasks"] }); };
  const act = async (fn: () => Promise<unknown>) => { try { setError(""); await fn(); await refresh(); } catch (e) { setError(errMsg(e, "Error")); } };
  const act2 = act;
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

  const panels: Record<PanelId, React.ReactNode> = {
    blocks: (<>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-semibold">{l("Blocs de la journée", "Blocks of the day")}</h2>
        <div className="mr-6 flex items-center gap-3">
          {d.own && !d.dayOff && <button className="btn !py-1 text-xs" onClick={() => setBlockDlg({ title: "", start: clockOf(Math.max(from, Math.min(to - 60, ws))), end: clockOf(Math.max(from, Math.min(to - 60, ws)) + 60) })}><Lock size={12} />{l("Bloc réservé", "Reserved block")}</button>}
          <label className="flex items-center gap-2 text-[11px] text-muted">{l("Hauteur", "Height")}<input type="range" min={36} max={110} value={hourPx} onChange={(e) => setHourPx(Number(e.target.value))} className="accent-[var(--brand)]" /></label></div></div>
      {d.dayOff ? <p className="text-sm text-muted">—</p> : (
        <div ref={grid} className="relative select-none" style={{ height: ((to - from) / 60) * hourPx }} onClick={(e) => {
          if (!d.own || justMoved.current) return;
          const r = grid.current!.getBoundingClientRect();
          const at = Math.max(from, Math.min(to - 30, Math.round((from + ((e.clientY - r.top) / hourPx) * 60) / 15) * 15));
          setBlockDlg({ title: "", start: clockOf(at), end: clockOf(Math.min(to, at + 60)) });
        }} title={d.own ? l("Cliquer pour réserver du temps", "Click to reserve time") : undefined}>
          {Array.from({ length: (to - from) / 60 + 1 }, (_, i) => <div key={i} className="pointer-events-none absolute left-0 right-0 border-t border-white/10 text-[10px] text-muted" style={{ top: i * hourPx }}><span className="-mt-2 block w-10 bg-transparent">{String(from / 60 + i).padStart(2, "0")}:00</span></div>)}
          {d.blocks.map((b, i) => {
            const key = b.id ?? b.taskId ?? String(i);
            const mv = moving?.key === key ? moving : null;
            const s0 = mv ? mv.start : mins(b.start), e0 = mv ? mv.end : mins(b.end);
            const top = ((s0 - from) / 60) * hourPx, h = Math.max(18, ((e0 - s0) / 60) * hourPx - 2);
            const movable = d.own && (b.kind === "reserved" || (b.kind === "task" && !b.private));
            const bg = b.kind === "lunch" ? "rgba(255,255,255,0.06)" : b.kind === "event" ? "color-mix(in oklab, var(--brand-2) 35%, transparent)" : b.kind === "reserved" ? "color-mix(in oklab, var(--warn) 22%, transparent)" : `color-mix(in oklab, ${tone(b.priority)} 38%, transparent)`;
            const act = () => { if (b.kind === "task" && b.taskId && !b.private) onOpen(b.taskId); else if (b.kind === "reserved" && b.id && d.own) setBlockDlg({ id: b.id, title: b.title ?? "", start: b.start, end: b.end }); };
            return (
              <div key={key} role={b.kind === "task" || b.kind === "reserved" ? "button" : undefined} tabIndex={movable ? 0 : undefined}
                onKeyDown={(e) => { if (e.key === "Enter") act(); }}
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => {
                  if (!movable || e.button !== 0) return;
                  e.stopPropagation(); e.preventDefault();
                  const y0 = e.clientY, len = mins(b.end) - mins(b.start), from0 = mins(b.start);
                  let moved = false, cur = from0;
                  const move = (ev: MouseEvent) => {
                    const dy = ev.clientY - y0;
                    if (!moved && Math.abs(dy) < 5) return;
                    moved = true;
                    cur = Math.max(0, Math.min(24 * 60 - len, Math.round((from0 + (dy / hourPx) * 60) / 15) * 15));
                    setMoving({ key, start: cur, end: cur + len });
                  };
                  const up = () => {
                    window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up);
                    setMoving(null);
                    if (!moved) { act(); return; }
                    justMoved.current = true; setTimeout(() => { justMoved.current = false; }, 80);
                    if (cur === from0) return;
                    void act2(b.kind === "reserved"
                      ? () => api(`/api/pipeline/blocks/${b.id}`, { method: "PATCH", body: { start: clockOf(cur), end: clockOf(cur + len) } })
                      : () => api(`/api/pipeline/tasks/${b.taskId}/pin`, { method: "PUT", body: { date, start: clockOf(cur) } }));
                  };
                  window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
                }}
                className={`absolute left-12 right-1 overflow-hidden rounded-lg px-2 py-0.5 text-left text-xs ${movable ? "cursor-grab active:cursor-grabbing" : ""}`}
                style={{ top, height: h, background: bg, border: b.kind === "reserved" ? "1px dashed var(--warn)" : "1px solid rgba(255,255,255,0.12)", zIndex: mv ? 20 : undefined, boxShadow: mv ? "0 6px 20px rgba(0,0,0,.4)" : undefined }}>
                <b>{clockOf(s0)}</b> {b.kind === "lunch" ? l("Dîner", "Lunch") : b.kind === "event" ? `📅 ${b.title}` : b.kind === "reserved" ? `🔒 ${b.title}` : b.private ? l("Tâche privée", "Private task") : b.title}
                {b.kind === "task" && b.pinned && d.own && <button className="absolute right-1 top-0.5 rounded p-0.5 text-muted hover:text-white" title={l("Remettre à sa place automatique", "Back to its automatic place")} aria-label="unpin" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); void act2(() => api(`/api/pipeline/tasks/${b.taskId}/pin?date=${date}`, { method: "DELETE" })); }}><RotateCcw size={11} /></button>}
                {b.kind === "reserved" && d.own && <div className="absolute inset-x-0 bottom-0 h-2 cursor-row-resize" onMouseDown={(e) => {
                  e.stopPropagation(); e.preventDefault();
                  const y0 = e.clientY, e00 = mins(b.end); let cur = e00;
                  const move = (ev: MouseEvent) => { cur = Math.max(mins(b.start) + 15, Math.min(24 * 60, Math.round((e00 + ((ev.clientY - y0) / hourPx) * 60) / 15) * 15)); setMoving({ key, start: mins(b.start), end: cur }); };
                  const up = () => {
                    window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); setMoving(null);
                    justMoved.current = true; setTimeout(() => { justMoved.current = false; }, 80);
                    if (cur !== e00) void act2(() => api(`/api/pipeline/blocks/${b.id}`, { method: "PATCH", body: { end: clockOf(cur) } }));
                  };
                  window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
                }} onClick={(e) => e.stopPropagation()} />}
              </div>);
          })}
          {d.nowMinutes !== null && d.nowMinutes >= from && d.nowMinutes <= to && <div className="pointer-events-none absolute left-10 right-0 border-t-2 border-[var(--danger)]" style={{ top: ((d.nowMinutes - from) / 60) * hourPx }} />}
        </div>)}
    </>),
    all: (<>
                <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">{l("Toutes mes tâches", "All my tasks")}<span className="chip">{mineRows.length}</span></h2>
                {!pageRows.length ? <p className="text-sm text-muted">—</p> : <ul className="space-y-1.5 text-sm">{pageRows.map((t) => <li key={t.id} className="flex items-center justify-between gap-2"><button className="truncate text-left hover:underline" onClick={() => onOpen(t.id)}>{t.title}{t.clientName && <span className="text-xs text-muted"> · {t.clientName}</span>}</button><span className="shrink-0 text-xs text-muted">{fmtDate(t.dueDate, loc)}</span></li>)}</ul>}
                {mineRows.length > 10 && <div className="mt-3 flex items-center justify-end gap-2 text-xs text-muted"><button className="btn !p-1" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="prev"><ChevronLeft size={13} /></button>{page} / {Math.ceil(mineRows.length / 10)}<button className="btn !p-1" disabled={page * 10 >= mineRows.length} onClick={() => setPage(page + 1)} aria-label="next"><ChevronRight size={13} /></button></div>}
    </>),
    prio: (<>
                  <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">{l("Priorités de la journée", "Priorities of the day")}<span className="chip">{d.items.length}</span></h2>
                  {d.items.length === 0 ? <Empty>🎉 {d.dayOff ? l("Journée de congé.", "Day off.") : l("Rien d'urgent ce jour-là.", "Nothing urgent that day.")}</Empty> : <ul className="space-y-2">{d.items.map((it) => <TaskRowItem key={it.id} it={it} />)}</ul>}
                  {d.overflow.length > 0 && !d.dayOff && <p className="mt-3 text-xs text-warn">{d.overflow.length} {l("tâche(s) ne tiennent pas dans la journée.", "task(s) do not fit in the day.")}</p>}
                  {d.waiting.length > 0 && <p className="mt-2 text-xs text-muted">⏳ {l("En attente d'une autre tâche", "Waiting for another task")}: {d.waiting.map((w) => w.title ?? l("tâche privée", "private task")).join(", ")}</p>}
    </>),
    week: (<>
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold"><Star size={14} className="text-warn" />{l("Priorités de la semaine", "Priorities of the week")}<span className="chip">{d.week.length}</span></h2>
              {!d.week.length ? <p className="text-sm text-muted">—</p> : <ul className="space-y-1.5 text-sm">{d.week.map((t) => <li key={t.id} className="flex items-center justify-between gap-2"><button className="truncate text-left hover:underline" onClick={() => !t.private && onOpen(t.id)}>{t.private ? l("Tâche privée", "Private task") : t.title}{t.clientName && <span className="text-xs text-muted"> · {t.clientName}</span>}</button><span className="shrink-0 text-xs" style={{ color: t.dueDate && t.dueDate < d.date ? "var(--danger)" : "var(--muted)" }}>{fmtDate(t.dueDate, loc)}</span></li>)}</ul>}
    </>),
    quick: (<>
            {can("tasks.edit", "tasks.manage", "command.pipeline.edit") && !who && (
              <form className="glass flex gap-2 p-3" onSubmit={(e) => { e.preventDefault(); if (quick.trim()) void act(async () => { await api("/api/tasks", { body: { title: quick.trim(), dueDate: date } }); setQuick(""); }); }}>
                <input className="input" placeholder={l("Ajouter une tâche pour ce jour…", "Add a task for this day…")} value={quick} onChange={(e) => setQuick(e.target.value)} /><button className="btn btn-primary" aria-label="add"><Plus size={16} /></button></form>)}
    </>),
  };
  const panelOk = (id: PanelId) => id !== "quick" || (can("tasks.edit", "tasks.manage", "command.pipeline.edit") && !who);
  const panelOk2 = (id: PanelId) => panelOk(id) && (id !== "all" || !who);

  return (
    <>
      {blockDlg && <BlockDialog date={date} draft={blockDlg} onClose={() => setBlockDlg(null)} onDone={async () => { setBlockDlg(null); await refresh(); }} />}
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

      <div className="mb-2 flex justify-end"><button className="text-xs text-muted hover:underline" onClick={resetLayout}>{l("Rétablir la disposition", "Reset layout")}</button></div>
      <div ref={box} className="flex flex-col gap-4 lg:flex-row lg:gap-0">
        {(["left", "right"] as const).map((col, ci) => (<Fragment key={col}>
          {ci === 1 && <div className="hidden w-3 shrink-0 cursor-col-resize items-center justify-center lg:flex" onMouseDown={drag} onDoubleClick={() => { setSplit(58); try { localStorage.removeItem(SPLIT_KEY); } catch { /* ignore */ } }} title={l("Glisser pour redimensionner (double-clic : rétablir)", "Drag to resize (double-click: reset)")}><div className="h-16 w-1 rounded-full bg-white/20" /></div>}
          <div className={`min-w-0 space-y-4 ${ci === 0 ? "lg:pr-3" : "flex-1 lg:pl-3"}`} style={ci === 0 ? { flexBasis: `${split}%` } : undefined} onDragOver={(e) => e.preventDefault()} onDrop={() => dropOn(col, null)}>
            {layout[col].filter(panelOk2).map((id) => (
              <Panel key={id} height={heights[id]} setHeight={(h) => setHeight(id, h)} onDragStart={() => setDragId(id)} onDrop={() => dropOn(col, id)} label={l("Déplacer", "Move")} resetLabel={l("Double-clic : hauteur automatique", "Double-click: automatic height")} bare={id === "quick"}>{panels[id]}</Panel>))}
            <div className="min-h-6" />
          </div>
        </Fragment>))}
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
