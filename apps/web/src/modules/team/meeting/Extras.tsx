import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { api } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { fmtDate, todayISO, useL, useLocale } from "../../../lib/l";
import { Empty, errMsg, FormDialog, Tabs, useUsers, type FieldDef } from "../../../components/kit";
import { Modal } from "../../../components/ui";

/** The week ahead: what the week looks like, and a few suggestions (written by the portal's rules). */
export function Brief() {
  const l = useL();
  const loc = useLocale();
  const q = useQuery({ queryKey: ["meeting-brief"], queryFn: () => api<{ from: string; to: string; bullets: { tone: string; fr: string; en: string }[]; suggestions: { fr: string; en: string }[] }>("/api/team/meeting/brief"), refetchInterval: 60_000 });
  const b = q.data;
  if (!b) return null;
  const color = (t: string) => (t === "danger" ? "var(--danger)" : t === "warn" ? "var(--warn)" : t === "ok" ? "var(--ok)" : "var(--brand-2)");
  return (
    <section className="glass p-5">
      <h2 className="mb-1 font-semibold">{l("La semaine à venir", "The week ahead")}</h2>
      <p className="mb-3 text-xs text-muted">{fmtDate(b.from, loc)} → {fmtDate(b.to, loc)}</p>
      <div className="grid gap-5 md:grid-cols-2">
        <ul className="space-y-1.5 text-sm">{b.bullets.map((x, i) => <li key={i} className="flex gap-2"><span className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ background: color(x.tone) }} />{l(x.fr, x.en)}</li>)}</ul>
        <div><h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">{l("Suggestions", "Suggestions")}</h3>{!b.suggestions.length ? <p className="text-sm text-muted">—</p> : <ul className="space-y-1.5 text-sm">{b.suggestions.map((x, i) => <li key={i}>→ {l(x.fr, x.en)}</li>)}</ul>}</div>
      </div>
    </section>
  );
}

interface Gauge { count: number; byAssignee: { id: string | null; name: string; count: number }[] }
type Gauges = { friday: string; thresholds: Record<"overdue" | "week" | "unassigned", { warn: number; critical: number }>; overdue: Gauge; week: Gauge; unassigned: Gauge };

/** Green until the warning level, then red, critical beyond. A click opens the matching list. */
export function Gauges() {
  const l = useL();
  const [who, setWho] = useState<Record<string, string | null>>({});
  const q = useQuery({ queryKey: ["meeting-gauges"], queryFn: () => api<Gauges>("/api/team/meeting/gauges"), refetchInterval: 30_000 });
  const g = q.data;
  if (!g) return null;
  const items: { key: "overdue" | "week" | "unassigned"; title: string; sub: string; link: (a?: string | null) => string }[] = [
    { key: "overdue", title: l("En retard", "Overdue"), sub: l("Échéance dépassée", "Past their due date"), link: (a) => `/tasks?due=overdue${a ? `&assignee=${a}` : ""}` },
    { key: "week", title: l("D'ici vendredi", "Due by Friday"), sub: `${l("Jusqu'au", "Until")} ${g.friday}`, link: (a) => `/tasks?due=friday${a ? `&assignee=${a}` : ""}` },
    { key: "unassigned", title: l("Sans responsable", "Without an owner"), sub: l("Tâches ouvertes non assignées", "Open unassigned tasks"), link: () => "/tasks?assignee=none" },
  ];
  return (
    <section className="glass p-5">
      <h2 className="mb-3 font-semibold">{l("Charge de l'équipe", "Team load")}</h2>
      <div className="grid gap-4 md:grid-cols-3">
        {items.map((it) => {
          const gg = g[it.key], th = g.thresholds[it.key];
          const sel = who[it.key] ?? null;
          const count = sel === null ? gg.count : gg.byAssignee.find((x) => (x.id ?? "") === sel)?.count ?? 0;
          const level = count >= th.critical ? "critical" : count >= th.warn ? "warn" : "ok";
          const color = level === "critical" ? "var(--danger)" : level === "warn" ? "var(--warn)" : "var(--ok)";
          return (
            <div key={it.key} className="glass-flat p-4">
              <Link to={it.link(sel)} className="block no-underline">
                <div className="text-xs text-muted">{it.title}</div>
                <div className="my-1 text-4xl font-semibold" style={{ color }}>{count}</div>
                <div className="h-2 rounded-full bg-white/10"><div className="h-full rounded-full" style={{ width: `${Math.min(100, (count / th.critical) * 100)}%`, background: color }} /></div>
                <div className="mt-1 text-[11px] text-muted">{it.sub}{level === "critical" ? ` · ${l("critique", "critical")}` : ""}</div>
              </Link>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {gg.byAssignee.map((a) => { const k = a.id ?? ""; const on = sel === k; return <button key={k || "none"} className="chip cursor-pointer" style={on ? { background: "var(--brand)", color: "#fff" } : undefined} onClick={() => setWho({ ...who, [it.key]: on ? null : k })}>{a.name || l("Non assignées", "Unassigned")} {a.count}</button>; })}
              </div>
            </div>);
        })}
      </div>
    </section>
  );
}

interface Proj { id: string; name: string; clientId: string | null; clientName: string | null; dueDate: string | null; status: string; members: { userId: string; name: string }[]; noteCount: number }

/** Engagements in progress: client, due day, team and notes. Done ones sit behind a toggle. */
export function Projects() {
  const l = useL();
  const loc = useLocale();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [done, setDone] = useState(false);
  const [dlg, setDlg] = useState<null | { row?: Proj }>(null);
  const [open, setOpen] = useState<Proj | null>(null);
  const [error, setError] = useState("");
  const q = useQuery({ queryKey: ["meeting-projects", done], queryFn: () => api<Proj[]>(`/api/team/meeting/projects?done=${done ? 1 : 0}`) });
  const users = useUsers();
  const edit = can("team.meeting.edit", "team.meeting.manage");
  const refresh = () => qc.invalidateQueries({ queryKey: ["meeting-projects"] });
  const today = todayISO();
  const fields: FieldDef[] = [{ name: "name", label: ["Dossier", "Engagement"], required: true, span: 2 }, { name: "clientId", label: ["Client", "Client"], type: "client" }, { name: "dueDate", label: ["À livrer le", "Due"], type: "date" }];
  const run = async (fn: () => Promise<unknown>) => { try { setError(""); await fn(); await refresh(); } catch (e) { setError(errMsg(e, "Error")); } };
  return (
    <section className="glass p-5">
      <div className="mb-3 flex items-center gap-2"><h2 className="mr-auto font-semibold">{l("Dossiers en cours", "Engagements in progress")}</h2>
        <Tabs tabs={[{ key: "open", label: l("En cours", "Open") }, { key: "done", label: l("Terminés", "Done") }]} value={done ? "done" : "open"} onChange={(k) => setDone(k === "done")} />
        {edit && <button className="btn btn-primary" onClick={() => setDlg({})}><Plus size={15} />{l("Dossier", "Engagement")}</button>}</div>
      {error && <p role="alert" className="mb-2 text-sm text-danger">{error}</p>}
      {!q.data?.length ? <Empty>{l("Aucun dossier.", "No engagements.")}</Empty> : (
        <div className="grid gap-3 md:grid-cols-2">{q.data.map((p) => (
          <div key={p.id} className="glass-flat p-3 text-sm">
            <div className="flex items-start justify-between gap-2"><button className="text-left font-medium hover:underline" onClick={() => setOpen(p)}>{p.name}</button>
              {edit && <button className="btn !px-2 !py-0.5 text-xs" onClick={() => void run(() => api(`/api/team/meeting/projects/${p.id}`, { method: "PATCH", body: { status: p.status === "done" ? "open" : "done" } }))}>{p.status === "done" ? l("Rouvrir", "Reopen") : l("Terminé", "Done")}</button>}</div>
            <div className="mt-1 text-xs text-muted">{p.clientName ?? "—"} · <span style={{ color: p.dueDate && p.dueDate < today && p.status === "open" ? "var(--danger)" : undefined }}>{p.dueDate ? fmtDate(p.dueDate, loc) : l("sans date", "no date")}</span> · {p.noteCount} {l("note(s)", "note(s)")}</div>
            <div className="mt-2 flex flex-wrap gap-1">{p.members.map((m) => <span key={m.userId} className="chip">{m.name}</span>)}</div>
          </div>))}</div>)}
      {dlg && <FormDialog title={dlg.row ? l("Modifier le dossier", "Edit engagement") : l("Nouveau dossier", "New engagement")} fields={fields} initial={{}} onSubmit={async (v) => { await api("/api/team/meeting/projects", { body: { name: v.name, clientId: v.clientId || null, dueDate: v.dueDate || null } }); await refresh(); }} onClose={() => setDlg(null)} />}
      {open && <ProjectWindow p={open} users={users.data ?? []} canEdit={edit} canDelete={can("team.meeting.manage")} onClose={() => setOpen(null)} onChanged={refresh} />}
    </section>
  );
}

function ProjectWindow({ p, users, canEdit, canDelete, onClose, onChanged }: { p: Proj; users: { id: string; name: string }[]; canEdit: boolean; canDelete: boolean; onClose: () => void; onChanged: () => Promise<unknown> }) {
  const l = useL();
  const loc = useLocale();
  const qc = useQueryClient();
  const [members, setMembers] = useState(p.members.map((m) => m.userId));
  const [text, setText] = useState("");
  const notes = useQuery({ queryKey: ["meeting-project-notes", p.id], queryFn: () => api<{ id: string; body: string; createdAt: string; userName: string | null }[]>(`/api/team/meeting/projects/${p.id}/notes`) });
  const toggle = async (id: string) => { const n = members.includes(id) ? members.filter((x) => x !== id) : [...members, id]; setMembers(n); await api(`/api/team/meeting/projects/${p.id}`, { method: "PATCH", body: { memberIds: n } }); await onChanged(); };
  return (
    <Modal title={p.name} onClose={onClose} wide>
      <div className="mb-4"><span className="label">{l("Équipe", "Team")}</span><div className="flex flex-wrap gap-1.5">{users.map((u) => <button key={u.id} disabled={!canEdit} className="chip cursor-pointer" style={members.includes(u.id) ? { background: "var(--brand)", color: "#fff" } : undefined} onClick={() => void toggle(u.id)}>{u.name}</button>)}</div></div>
      <span className="label">{l("Notes", "Notes")}</span>
      {canEdit && <form className="mb-3 flex gap-2" onSubmit={async (e) => { e.preventDefault(); if (!text.trim()) return; await api(`/api/team/meeting/projects/${p.id}/notes`, { body: { body: text.trim() } }); setText(""); await qc.invalidateQueries({ queryKey: ["meeting-project-notes", p.id] }); await onChanged(); }}><input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder={l("Ajouter une note…", "Add a note…")} /><button className="btn btn-primary" aria-label="add"><Plus size={15} /></button></form>}
      <ul className="mb-4 max-h-60 space-y-2 overflow-auto text-sm">{notes.data?.map((n) => <li key={n.id}><span className="whitespace-pre-wrap">{n.body}</span> <span className="text-xs text-muted">· {n.userName} · {fmtDate(n.createdAt, loc)}</span></li>)}{!notes.data?.length && <li className="text-muted">—</li>}</ul>
      <div className="flex justify-between">{canDelete ? <button className="btn btn-danger" onClick={async () => { if (window.confirm(l("Supprimer ce dossier ?", "Delete this engagement?"))) { await api(`/api/team/meeting/projects/${p.id}`, { method: "DELETE" }); await onChanged(); onClose(); } }}><Trash2 size={14} />{l("Supprimer", "Delete")}</button> : <span />}<button className="btn" onClick={onClose}>{l("Fermer", "Close")}</button></div>
    </Modal>
  );
}

interface Trend { weekStart: string; created: number; completed: number; net: number; openAtEnd: number; avgDays: number | null; within2Pct: number | null }

/** Week by week: tasks created, completed, what stayed open, and how fast they were closed. */
export function Trends() {
  const l = useL();
  const loc = useLocale();
  const [weeks, setWeeks] = useState(12);
  const q = useQuery({ queryKey: ["meeting-trends", weeks], queryFn: () => api<{ rows: Trend[] }>(`/api/team/meeting/trends?weeks=${weeks}`) });
  const rows = q.data?.rows ?? [];
  const max = Math.max(1, ...rows.flatMap((r) => [r.created, r.completed]));
  return (
    <section className="glass p-5">
      <div className="mb-3 flex flex-wrap items-center gap-3"><h2 className="mr-auto font-semibold">{l("Tendances", "Trends")}</h2>
        <label className="flex items-center gap-2 text-xs text-muted">{l("Semaines", "Weeks")}: <b className="text-white">{weeks}</b><input type="range" min={4} max={52} value={weeks} onChange={(e) => setWeeks(Number(e.target.value))} className="accent-[var(--brand)]" /></label></div>
      <div className="mb-4 flex h-28 items-end gap-1" aria-hidden>{rows.map((r) => (
        <div key={r.weekStart} className="flex flex-1 items-end justify-center gap-px" title={`${fmtDate(r.weekStart, loc)}: +${r.created} / ✓${r.completed}`}>
          <div className="w-full rounded-t" style={{ height: `${(r.created / max) * 100}%`, background: "var(--brand-2)" }} /><div className="w-full rounded-t" style={{ height: `${(r.completed / max) * 100}%`, background: "var(--ok)" }} /></div>))}</div>
      <div className="mb-2 flex gap-4 text-xs text-muted"><span><span className="mr-1 inline-block h-2 w-2 rounded-sm" style={{ background: "var(--brand-2)" }} />{l("Créées", "Created")}</span><span><span className="mr-1 inline-block h-2 w-2 rounded-sm" style={{ background: "var(--ok)" }} />{l("Terminées", "Completed")}</span></div>
      <div className="max-h-64 overflow-auto"><table className="grid"><thead><tr><th>{l("Semaine du", "Week of")}</th><th>{l("Créées", "Created")}</th><th>{l("Terminées", "Completed")}</th><th>Net</th><th>{l("Ouvertes à la fin", "Open at end")}</th><th>{l("Délai moyen (j)", "Avg time (d)")}</th><th>≤ 2 j</th></tr></thead>
        <tbody>{[...rows].reverse().map((r) => <tr key={r.weekStart}><td className="whitespace-nowrap">{fmtDate(r.weekStart, loc)}</td><td>{r.created}</td><td>{r.completed}</td><td style={{ color: r.net > 0 ? "var(--warn)" : "var(--ok)" }}>{r.net > 0 ? `+${r.net}` : r.net}</td><td>{r.openAtEnd}</td><td>{r.avgDays ?? "—"}</td><td>{r.within2Pct == null ? "—" : `${r.within2Pct} %`}</td></tr>)}</tbody></table></div>
    </section>
  );
}
