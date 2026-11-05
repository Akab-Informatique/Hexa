import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, BellOff, GripVertical, MessageSquare, Plus, RotateCcw, Search, Trash2 } from "lucide-react";
import { api } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { addDays, fmtDate, todayISO, useL, useLocale } from "../../../lib/l";
import { Empty, errMsg, Tabs } from "../../../components/kit";
import { Modal } from "../../../components/ui";

interface Point { id: string; kind: "point" | "hot" | "issue"; title: string; body: string; authorId: string | null; authorName: string | null; noteCount: number; snoozeUntil: string | null; archivedAt: string | null }
interface Note { id: string; body: string; createdAt: string; userName: string | null }

/** Points to discuss: a running list. Ticking one settles it and sends it to the archive; a point can be put off or noted. */
export function Points() {
  const l = useL();
  const loc = useLocale();
  const { can, me } = useAuth();
  const qc = useQueryClient();
  const [view, setView] = useState<"open" | "later" | "archive">("open");
  const [search, setSearch] = useState("");
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<"point" | "issue">("point");
  const [openId, setOpenId] = useState<string | null>(null);
  const [snooze, setSnooze] = useState<Point | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const q = useQuery({ queryKey: ["meeting-points", view, search], queryFn: () => api<{ points: Point[]; later: number }>(`/api/team/meeting/points?view=${view}&q=${encodeURIComponent(search)}`), refetchInterval: 15_000 });
  const edit = can("team.meeting.edit", "team.meeting.manage");
  const manage = can("team.meeting.manage");
  const pts = q.data?.points ?? [];
  const refresh = async () => { await qc.invalidateQueries({ queryKey: ["meeting-points"] }); await qc.invalidateQueries({ queryKey: ["w-meeting"] }); };
  const run = async (fn: () => Promise<unknown>) => { try { setError(""); await fn(); await refresh(); } catch (e) { setError(errMsg(e, "Error")); } };
  const patch = (id: string, b: object) => run(() => api(`/api/team/meeting/points/${id}`, { method: "PATCH", body: b }));
  const reorder = (from: string, to: string) => {
    if (from === to) return;
    const ids = pts.map((p) => p.id); const i = ids.indexOf(from), j = ids.indexOf(to); ids.splice(j, 0, ids.splice(i, 1)[0]!);
    void run(() => api("/api/team/meeting/points/order", { method: "PUT", body: { ids } }));
  };

  return (
    <section className="glass p-5">
      <h2 className="mb-3 font-semibold">{l("Points à discuter", "Points to discuss")}</h2>
      <Tabs tabs={[{ key: "open", label: l("À discuter", "Open") }, { key: "later", label: `${l("Reportés", "Put off")} (${q.data?.later ?? 0})` }, { key: "archive", label: l("Archives", "Archive") }]} value={view} onChange={setView} />
      {view === "archive" && <div className="relative mb-3"><Search size={14} className="pointer-events-none absolute left-3 top-3 text-muted" /><input className="input !pl-8" placeholder={l("Rechercher dans les archives…", "Search the archive…")} value={search} onChange={(e) => setSearch(e.target.value)} /></div>}
      {error && <p role="alert" className="mb-2 text-sm text-danger">{error}</p>}
      {pts.length === 0 ? <Empty>{view === "open" ? l("Aucun point. Ajoutez-en un ci-dessous.", "No points. Add one below.") : view === "later" ? l("Rien de reporté.", "Nothing put off.") : l("Archives vides.", "Archive is empty.")}</Empty> : (
        <ul className="space-y-1.5">{pts.map((p) => (
          <li key={p.id} onDragOver={(e) => view === "open" && manage && e.preventDefault()} onDrop={() => { if (dragId) reorder(dragId, p.id); setDragId(null); }}>
            <div className="flex items-start gap-2 text-sm" style={{ opacity: dragId === p.id ? 0.4 : 1 }}>
              {view === "open" && manage && <span draggable onDragStart={() => setDragId(p.id)} onDragEnd={() => setDragId(null)} className="mt-0.5 cursor-grab text-muted" title={l("Glisser pour réordonner", "Drag to reorder")}><GripVertical size={14} /></span>}
              {view !== "archive" ? <input type="checkbox" className="mt-1 h-4 w-4 accent-[var(--brand)]" checked={false} disabled={!edit} onChange={() => void patch(p.id, { done: true })} aria-label={l("Régler ce point", "Settle this point")} />
                : <button className="btn !p-1" title={l("Remettre sur la liste", "Back on the list")} onClick={() => void patch(p.id, { archived: false })}><RotateCcw size={13} /></button>}
              <button className="min-w-0 flex-1 text-left" onClick={() => setOpenId(openId === p.id ? null : p.id)}>
                <span className={p.kind === "issue" ? "text-warn" : ""}>{p.kind === "issue" ? "⚠ " : ""}{p.title}</span>
                <span className="ml-2 text-xs text-muted">{p.authorName}{p.snoozeUntil && view === "later" ? ` · ${l("revient le", "back on")} ${fmtDate(p.snoozeUntil, loc)}` : ""}</span>
                {p.noteCount > 0 && <span className="ml-2 inline-flex items-center gap-0.5 text-xs text-muted"><MessageSquare size={11} />{p.noteCount}</span>}
              </button>
              {edit && view === "open" && <button className="text-muted hover:text-white" title={l("Reporter", "Put off")} onClick={() => setSnooze(p)} aria-label="snooze"><BellOff size={13} /></button>}
              {edit && view === "later" && <button className="text-muted hover:text-white" title={l("Remettre sur la liste", "Bring back")} onClick={() => void patch(p.id, { snoozeUntil: null })} aria-label="bring back"><RotateCcw size={13} /></button>}
              {edit && view === "open" && <button className="text-muted hover:text-white" title={l("Archiver", "Archive")} onClick={() => void patch(p.id, { archived: true })} aria-label="archive"><Archive size={13} /></button>}
              {edit && (p.authorId === me.user?.id || manage) && <button className="text-muted hover:text-danger" onClick={() => { if (window.confirm(l("Supprimer ce point ?", "Delete this point?"))) void run(() => api(`/api/team/meeting/points/${p.id}`, { method: "DELETE" })); }} aria-label="delete"><Trash2 size={13} /></button>}
            </div>
            {openId === p.id && <PointNotes id={p.id} canWrite={edit} onChanged={refresh} />}
          </li>))}</ul>)}
      {edit && view === "open" && (
        <form className="mt-4 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (title.trim()) void run(async () => { await api("/api/team/meeting/points", { body: { kind, title: title.trim() } }); setTitle(""); }); }}>
          <select className="input !w-auto" value={kind} onChange={(e) => setKind(e.target.value as "point" | "issue")} aria-label="kind"><option value="point">{l("Point", "Point")}</option><option value="issue">{l("Problème", "Issue")}</option></select>
          <input className="input" placeholder={l("Ajouter à l'ordre du jour…", "Add to the agenda…")} value={title} onChange={(e) => setTitle(e.target.value)} />
          <button className="btn btn-primary" aria-label="add"><Plus size={16} /></button>
        </form>)}
      {snooze && <SnoozeDialog point={snooze} onClose={() => setSnooze(null)} onPick={async (d) => { await patch(snooze.id, { snoozeUntil: d }); setSnooze(null); }} />}
    </section>
  );
}

function PointNotes({ id, canWrite, onChanged }: { id: string; canWrite: boolean; onChanged: () => Promise<unknown> }) {
  const l = useL();
  const loc = useLocale();
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const q = useQuery({ queryKey: ["meeting-notes", id], queryFn: () => api<Note[]>(`/api/team/meeting/points/${id}/notes`) });
  return (
    <div className="glass-flat ml-6 mt-1.5 p-3 text-sm">
      {!q.data?.length ? <p className="text-xs text-muted">{l("Aucune note.", "No notes.")}</p> : <ul className="mb-2 space-y-1.5">{q.data.map((n) => <li key={n.id}><span className="whitespace-pre-wrap">{n.body}</span> <span className="text-xs text-muted">· {n.userName} · {fmtDate(n.createdAt, loc)}</span></li>)}</ul>}
      {canWrite && <form className="flex gap-2" onSubmit={async (e) => { e.preventDefault(); if (!text.trim()) return; await api(`/api/team/meeting/points/${id}/notes`, { body: { body: text.trim() } }); setText(""); await qc.invalidateQueries({ queryKey: ["meeting-notes", id] }); await onChanged(); }}><input className="input" placeholder={l("Ajouter une note…", "Add a note…")} value={text} onChange={(e) => setText(e.target.value)} /><button className="btn" aria-label="add note"><Plus size={14} /></button></form>}
    </div>
  );
}

function SnoozeDialog({ point, onClose, onPick }: { point: Point; onClose: () => void; onPick: (day: string) => Promise<void> }) {
  const l = useL();
  const [day, setDay] = useState(addDays(todayISO(), 7));
  const today = todayISO();
  return (
    <Modal title={l("Reporter ce point", "Put this point off")} onClose={onClose}>
      <p className="mb-3 text-sm text-muted">« {point.title} » {l("quitte la liste jusqu'à ce jour.", "leaves the list until that day.")}</p>
      <div className="mb-3 flex flex-wrap gap-2">{[[l("Demain", "Tomorrow"), 1], [l("Dans une semaine", "In a week"), 7], [l("Dans un mois", "In a month"), 30]].map(([t, n]) => <button key={String(t)} className="btn" onClick={() => void onPick(addDays(today, Number(n)))}>{t}</button>)}</div>
      <label className="mb-4 block"><span className="label">{l("Ou une date", "Or a date")}</span><input className="input" type="date" min={addDays(today, 1)} value={day} onChange={(e) => setDay(e.target.value)} /></label>
      <div className="flex justify-end gap-2"><button className="btn" onClick={onClose}>{l("Annuler", "Cancel")}</button><button className="btn btn-primary" disabled={day <= today} onClick={() => void onPick(day)}>{l("Reporter", "Put off")}</button></div>
    </Modal>
  );
}
