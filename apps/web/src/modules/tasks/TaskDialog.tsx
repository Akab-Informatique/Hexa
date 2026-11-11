import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, Plus, Square, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { fmtDate, useL, useLocale } from "../../lib/l";
import { Chip, errMsg, FormFields, useUsers, type FieldDef } from "../../components/kit";
import { Modal } from "../../components/ui";
import type { TaskRow } from "./TasksPage";
import { autoStartPref, clock, LogTimeDialog, minLabel, setAutoStartPref, useElapsed, useTimerActions, useTimerState, type Stopped } from "./timer";

interface Full extends TaskRow {
  description: string; startDate: string | null; estimateMinutes: number | null; visibility: string; waitsForId: string | null; waitsForTitle: string | null;
  recurrence: { every: number; unit: string; until?: string | null } | null; tags: string[]; createdBy: string | null; isWaiting: boolean;
  checklist: { id: string; text: string; done: boolean }[]; notes: { id: string; body: string; userName: string | null; createdAt: string; audience: "internal" | "client" }[];
  timeEntries: { id: string; workDate: string; minutes: number; description: string; userName: string }[];
  subtasks: { id: string; title: string; status: string }[]; viewers: { id: string; name: string }[];
  kind: "normal" | "continuous" | "daily"; startTime: string | null; dueTime: string | null; remindEveryDays: number | null; lastCheckedOn: string | null;
}
interface TaskFile { id: string; name: string; size: number; byName: string | null }

/** Create or edit a task: details, recurrence, checklist, notes and sub-tasks in one place. */
export default function TaskDialog({ taskId, defaults, onClose }: { taskId: string | null; defaults?: Record<string, unknown>; onClose: () => void }) {
  const l = useL();
  const loc = useLocale();
  const { me, can } = useAuth();
  const qc = useQueryClient();
  const users = useUsers();
  const detail = useQuery({ queryKey: ["task", taskId], queryFn: () => api<Full>(`/api/tasks/${taskId}`), enabled: Boolean(taskId) });
  const open = useQuery({ queryKey: ["tasks-open-list"], queryFn: () => api<TaskRow[]>("/api/tasks?status=open&parent=none") });
  const [values, setValues] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [newItem, setNewItem] = useState("");
  const [draftItems, setDraftItems] = useState<string[]>([]); // bullet points of a task not saved yet
  const [newNote, setNewNote] = useState("");
  const [audience, setAudience] = useState<"internal" | "client">("internal");
  const [viewerIds, setViewerIds] = useState<string[] | null>(null);

  // The timer: starts by itself when a task is opened (unless switched off), keeps running when this window is closed.
  const timer = useTimerState();
  const acts = useTimerActions();
  const [auto, setAuto] = useState(autoStartPref);
  const [log, setLog] = useState<Stopped | null>(null);
  const [closing, setClosing] = useState(false);
  const closeOk = useRef(false);
  const tried = useRef(false);
  const segs = useQuery({ queryKey: ["task-segments", taskId], queryFn: () => api<{ id: string; minutes: number; startedAt: string }[]>(`/api/tasks/${taskId}/segments`), enabled: Boolean(taskId) && timer.enabled });
  const runHere = Boolean(taskId) && timer.state?.running?.taskId === taskId;
  const runElsewhere = Boolean(timer.state?.running) && !runHere;
  const elapsed = useElapsed(runHere ? timer.state?.running?.startedAt : undefined, timer.skew);
  const pendingHere = segs.data ?? [];
  useEffect(() => {
    if (tried.current || !taskId || !detail.data || !timer.loaded || !timer.enabled || !auto) return;
    tried.current = true;
    const x = detail.data;
    const mine = can("tasks.manage", "command.pipeline.manage") || x.createdBy === me.user?.id || x.assigneeId === me.user?.id;
    if (!mine || x.status === "done" || timer.state?.running) return;
    void acts.start(taskId).catch(() => undefined);
  }, [detail.data, timer.loaded]); // eslint-disable-line react-hooks/exhaustive-deps

  const t = detail.data;
  if (taskId && !t) return null;
  const form = values ?? (t
    ? { ...t, assigneeId: t.assigneeId ?? "", clientId: t.clientId ?? "", dueDate: t.dueDate ?? "", startDate: t.startDate ?? "", startTime: t.startTime ?? "", dueTime: t.dueTime ?? "", remindEveryDays: t.remindEveryDays ?? "", estimateMinutes: t.estimateMinutes ?? "", waitsForId: t.waitsForId ?? "", tags: t.tags.join(", "), recEvery: t.recurrence?.every ?? "", recUnit: t.recurrence?.unit ?? "week", recUntil: t.recurrence?.until ?? "" }
    : { status: "todo", priority: "normal", kind: "normal", visibility: "team", assigneeId: me.user?.id, recUnit: "week", ...defaults });
  const editable = !t || can("tasks.manage", "command.pipeline.manage") || t.createdBy === me.user?.id || t.assigneeId === me.user?.id;
  const selViewers = viewerIds ?? t?.viewers.map((v) => v.id) ?? [];
  const refresh = async () => { await qc.invalidateQueries({ queryKey: ["task", taskId] }); await qc.invalidateQueries({ queryKey: ["tasks"] }); await qc.invalidateQueries({ queryKey: ["pipeline"] }); await qc.invalidateQueries({ queryKey: ["tasks-open-list"] }); };

  const fields: FieldDef[] = [
    { name: "title", label: ["Titre", "Title"], required: true, span: 2 },
    { name: "description", label: ["Description", "Description"], type: "textarea" },
    { name: "status", label: ["Statut", "Status"], type: "select", required: true, options: [{ value: "todo", label: ["Nouvelle", "New"] }, { value: "taken", label: ["Prise en charge", "Taken over"] }, { value: "doing", label: ["En cours", "In progress"] }, { value: "blocked", label: ["En attente du client", "Waiting for customer"] }, { value: "done", label: ["Terminée", "Completed"] }] },
    { name: "priority", label: ["Priorité", "Priority"], type: "select", required: true, options: [{ value: "low", label: ["Basse", "Low"] }, { value: "normal", label: ["Normale", "Normal"] }, { value: "high", label: ["Haute", "High"] }, { value: "urgent", label: ["Urgente", "Urgent"] }] },
    { name: "assigneeId", label: ["Assignée à", "Assigned to"], type: "user" }, { name: "clientId", label: ["Client", "Client"], type: "client" },
    { name: "kind", label: ["Type de tâche", "Kind of task"], type: "select", required: true, options: [{ value: "normal", label: ["Normale", "Normal"] }, { value: "continuous", label: ["Continue (rappel tous les n jours)", "Continuous (reminder every n days)"] }, { value: "daily", label: ["Quotidienne (recommence chaque jour)", "Daily (starts over each day)"] }] },
    ...(form.kind === "continuous" ? [{ name: "remindEveryDays", label: ["Rappel tous les (jours)", "Remind every (days)"] as [string, string], type: "number" as const }] : []),
    { name: "startDate", label: ["Début", "Start"], type: "date" }, { name: "startTime", label: ["Pas avant (heure)", "Not before (time)"], placeholder: "09:00", hint: ["Planifiée à partir de cette heure le jour du début", "Planned from that time on the start day"] },
    { name: "dueDate", label: ["Échéance", "Due"], type: "date" }, { name: "dueTime", label: ["Heure d'échéance", "Due time"], placeholder: "16:30" },
    { name: "estimateMinutes", label: ["Estimation (minutes)", "Estimate (minutes)"], type: "number" },
    { name: "visibility", label: ["Visibilité", "Visibility"], type: "select", required: true, options: [{ value: "team", label: ["Équipe", "Team"] }, { value: "private", label: ["Privée", "Private"] }, { value: "selected", label: ["Personnes choisies", "Selected people"] }] },
    { name: "waitsForId", label: ["Attend la tâche", "Waits for"], type: "select", options: (open.data ?? []).filter((x) => x.id !== taskId).map((x) => ({ value: x.id, label: x.title })), span: 2, hint: ["Ne peut pas être terminée avant l'autre", "Cannot be completed before that one"] },
    { name: "tags", label: ["Étiquettes (séparées par des virgules)", "Tags (comma separated)"], span: 2 },
  ];
  const recFields: FieldDef[] = [
    { name: "recEvery", label: ["Répéter tous les", "Repeat every"], type: "number" },
    { name: "recUnit", label: ["Unité", "Unit"], type: "select", required: true, options: [{ value: "day", label: ["jour(s)", "day(s)"] }, { value: "week", label: ["semaine(s)", "week(s)"] }, { value: "month", label: ["mois", "month(s)"] }, { value: "year", label: ["an(s)", "year(s)"] }] },
    { name: "recUntil", label: ["Jusqu'au", "Until"], type: "date" },
  ];

  // Pasting several lines adds one point per line.
  const addItems = async () => {
    const lines = newItem.split(/\r?\n/).map((x) => x.replace(/^[\s•*-]+/, "").trim()).filter(Boolean);
    if (!lines.length) return;
    if (taskId) await act(async () => { for (const text of lines) await api(`/api/tasks/${taskId}/checklist`, { body: { text } }); setNewItem(""); });
    else { setDraftItems([...draftItems, ...lines]); setNewItem(""); }
  };
  const save = async () => {
    const v = form as Record<string, unknown>;
    // Completing a task with time not yet entered: ask what to do with it.
    if (taskId && t && v.status === "done" && t.status !== "done" && timer.enabled && (runHere || pendingHere.length > 0) && !closeOk.current) { setClosing(true); return; }
    setBusy(true); setError("");
    const body = {
      title: v.title, description: v.description ?? "", status: v.status, priority: v.priority, visibility: v.visibility,
      kind: v.kind ?? "normal", startTime: v.startTime || null, dueTime: v.dueTime || null, remindEveryDays: v.kind === "continuous" && v.remindEveryDays ? Number(v.remindEveryDays) : null,
      assigneeId: v.assigneeId || null, clientId: v.clientId || null, startDate: v.startDate || null, dueDate: v.dueDate || null,
      estimateMinutes: v.estimateMinutes === "" || v.estimateMinutes == null ? null : Number(v.estimateMinutes), waitsForId: v.waitsForId || null,
      tags: String(v.tags ?? "").split(",").map((s) => s.trim()).filter(Boolean),
      recurrence: v.recEvery ? { every: Number(v.recEvery), unit: v.recUnit, until: v.recUntil || null } : null,
      viewerIds: v.visibility === "selected" ? selViewers : [],
      ...(taskId ? {} : { checklist: [...draftItems, ...(newItem.trim() ? [newItem.trim()] : [])] }),
    };
    try {
      if (taskId) await api(`/api/tasks/${taskId}`, { method: "PATCH", body }); else await api("/api/tasks", { body });
      await refresh(); onClose();
    } catch (e) { setError(errMsg(e, l("Erreur", "Error"))); } finally { setBusy(false); }
  };

  const act = async (fn: () => Promise<unknown>) => { try { await fn(); await refresh(); } catch (e) { setError(errMsg(e, "Error")); } };

  return (
    <Modal title={taskId ? l("Tâche", "Task") : l("Nouvelle tâche", "New task")} onClose={onClose} wide>
      {t?.isWaiting && <p className="mb-3 text-sm text-warn">⏳ {l("En attente de", "Waiting for")}: {t.waitsForTitle}</p>}
      {taskId && timer.enabled && t && (
        <div className="glass-flat mb-4 flex flex-wrap items-center gap-3 p-3 text-sm">
          <Clock size={16} className="text-muted" />
          {runHere ? (
            <>
              <span className="font-mono text-lg tabular-nums">{clock(elapsed)}</span>
              <span className="text-xs text-muted">{l("Le chrono continue si vous réduisez ou fermez la fenêtre.", "The timer keeps running if you minimize or close this window.")}</span>
              <span className="flex-1" />
              <button className="btn" onClick={onClose}>{l("Réduire", "Minimize")}</button>
              <button className="btn btn-danger" onClick={() => void act(async () => { setLog(await acts.stop()); })}><Square size={13} fill="currentColor" />{l("Arrêter", "Stop")}</button>
            </>
          ) : runElsewhere ? (
            <>
              <span className="text-muted">{l("Chrono en cours sur", "Timer running on")} <b>{timer.state!.running!.title}</b></span><span className="flex-1" />
              {editable && <button className="btn" onClick={() => void act(async () => { await acts.stop(); await acts.start(taskId!); })}>{l("Basculer ici", "Switch here")}</button>}
            </>
          ) : (
            <>
              <span className="text-muted">{l("Chrono arrêté", "Timer stopped")}</span><span className="flex-1" />
              {editable && t.status !== "done" && <button className="btn btn-primary" onClick={() => void act(async () => { await acts.start(taskId!); })}>{l("Démarrer le chrono", "Start the timer")}</button>}
            </>
          )}
          <label className="flex w-full items-center gap-2 text-xs text-muted"><input type="checkbox" className="h-3.5 w-3.5 accent-[var(--brand)]" checked={auto} onChange={(e) => { setAuto(e.target.checked); setAutoStartPref(e.target.checked); }} />{l("Démarrer le chrono à l'ouverture d'une tâche", "Start the timer when I open a task")}</label>
        </div>
      )}
      {pendingHere.length > 0 && (
        <div className="glass-flat mb-4 p-3 text-sm">
          <div className="mb-2 font-medium">{l("Temps à saisir", "Time to log")}</div>
          {pendingHere.map((sg) => (
            <div key={sg.id} className="mb-1 flex items-center gap-2"><span>{minLabel(sg.minutes)} · {fmtDate(sg.startedAt, loc)}</span><span className="flex-1" />
              <button className="btn !py-1 text-xs" onClick={() => setLog({ segmentId: sg.id, minutes: sg.minutes, title: t!.title, clientId: t!.clientId, clientName: t!.clientName })}>{l("Saisir", "Log")}</button>
              </div>))}
        </div>
      )}
      <fieldset disabled={!editable} className="min-w-0 border-0 p-0">
        <FormFields fields={fields.slice(0, 2)} values={form} onChange={setValues} />
        <div className="mb-4">
          <h3 className="mb-2 text-sm font-semibold">{l("Points à faire", "Bullet points")}{t ? ` (${t.checklist.filter((c) => c.done).length}/${t.checklist.length})` : draftItems.length ? ` (${draftItems.length})` : ""}</h3>
          <ul className="mb-2 space-y-1">
            {t ? t.checklist.map((c) => (
              <li key={c.id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" checked={c.done} disabled={!editable} onChange={(e) => void act(() => api(`/api/tasks/checklist/${c.id}`, { method: "PATCH", body: { done: e.target.checked } }))} />
                <span className={c.done ? "text-muted line-through" : ""}>{c.text}</span>
                {editable && <button type="button" className="ml-auto text-muted hover:text-danger" onClick={() => void act(() => api(`/api/tasks/checklist/${c.id}`, { method: "DELETE" }))} aria-label="delete"><Trash2 size={13} /></button>}
              </li>
            )) : draftItems.map((text, i) => (
              <li key={i} className="flex items-center gap-2 text-sm"><span className="text-muted">•</span><span>{text}</span>
                <button type="button" className="ml-auto text-muted hover:text-danger" onClick={() => setDraftItems(draftItems.filter((_, j) => j !== i))} aria-label="delete"><Trash2 size={13} /></button></li>
            ))}
          </ul>
          {editable && (
            <div className="flex gap-2">
              <input className="input" placeholder={l("Ajouter un point… (Entrée pour valider)", "Add a point… (Enter to add)")} value={newItem} onChange={(e) => setNewItem(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void addItems(); } }} />
              <button type="button" className="btn" onClick={() => void addItems()} aria-label={l("Ajouter", "Add")}><Plus size={15} /></button>
            </div>)}
        </div>
        <FormFields fields={fields.slice(2)} values={form} onChange={setValues} />
        {form.visibility === "selected" && (
          <div className="mb-4"><span className="label">{l("Personnes qui peuvent voir cette tâche", "People who can see this task")}</span>
            <div className="flex flex-wrap gap-2">{users.data?.map((u) => {
              const on = selViewers.includes(u.id);
              return <button key={u.id} type="button" aria-pressed={on} className="chip cursor-pointer" onClick={() => setViewerIds(on ? selViewers.filter((x) => x !== u.id) : [...selViewers, u.id])} style={on ? { background: "linear-gradient(135deg, var(--brand), var(--brand-2))", color: "#fff", borderColor: "transparent" } : undefined}>{u.name}</button>;
            })}</div></div>
        )}
        <details className="mb-4"><summary className="cursor-pointer text-sm text-muted">{l("Récurrence", "Recurrence")}{form.recEvery ? ` · ${form.recEvery} ${form.recUnit}` : ""}</summary>
          <div className="mt-3"><FormFields fields={recFields} values={form} onChange={setValues} /></div>
        </details>
      </fieldset>

      {t && (
        <>
          {t.subtasks.length > 0 && <><h3 className="mb-2 text-sm font-semibold">{l("Sous-tâches", "Sub-tasks")}</h3><ul className="mb-4 space-y-1 text-sm">{t.subtasks.map((s) => <li key={s.id}><Chip tone={s.status === "done" ? "ok" : "off"}>{s.status}</Chip> {s.title}</li>)}</ul></>}

          <h3 className="mb-2 text-sm font-semibold">{l("Notes", "Notes")}</h3>
          <ul className="mb-2 space-y-2">{t.notes.map((n) => <li key={n.id} className="glass-flat p-2.5 text-sm" style={n.audience === "client" ? { borderLeft: "3px solid var(--brand-2)" } : undefined}><div className="mb-0.5 flex items-center gap-2 text-xs text-muted">{n.userName} · {fmtDate(n.createdAt, loc)}<Chip tone={n.audience === "client" ? "warn" : "off"}>{n.audience === "client" ? l("Visible par le client", "Visible to client") : l("Interne", "Internal")}</Chip></div><div className="whitespace-pre-wrap">{n.body}</div></li>)}</ul>
          <form className="mb-4 flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); if (newNote.trim()) void act(async () => { await api(`/api/tasks/${taskId}/notes`, { body: { body: newNote.trim(), audience } }); setNewNote(""); }); }}>
            <select className="input !w-auto" value={audience} onChange={(e) => setAudience(e.target.value as "internal" | "client")} aria-label={l("Destinataire du commentaire", "Comment audience")}><option value="internal">{l("Commentaire interne", "Internal comment")}</option><option value="client">{l("Commentaire au client", "Comment to the client")}</option></select>
            <input className="input min-w-[200px] flex-1" placeholder={audience === "client" ? l("Écrire au client…", "Write to the client…") : l("Ajouter une note interne…", "Add an internal note…")} value={newNote} onChange={(e) => setNewNote(e.target.value)} /><button className="btn"><Plus size={15} /></button></form>

          {t.kind === "continuous" && (
            <div className="glass-flat mb-4 flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
              <span>{l("Tâche continue : revient tous les", "Continuous task: comes back every")} <b>{t.remindEveryDays ?? 7}</b> {l("jours", "days")}{t.lastCheckedOn ? ` · ${l("vérifiée le", "last checked")} ${fmtDate(t.lastCheckedOn, loc)}` : ""}</span>
              {editable && <button className="btn" onClick={() => void act(() => api(`/api/pipeline/tasks/${taskId}/check`, { body: {} }))}>{l("Je l'ai vérifiée", "I checked it")}</button>}
            </div>)}

          <h3 className="mb-2 text-sm font-semibold">{l("Fichiers", "Files")}</h3>
          <Files taskId={taskId!} editable={editable} />

          <h3 className="mb-2 text-sm font-semibold">{l("Temps saisi par l'équipe", "Time logged by the team")}</h3>
          {!t.timeEntries.length ? <p className="mb-4 text-xs text-muted">{l("Aucune entrée de temps sur cette tâche.", "No time entries on this task.")}</p> : (
            <div className="mb-4 overflow-x-auto">
              <table className="w-full text-sm">
                <tbody>{t.timeEntries.map((e) => (
                  <tr key={e.id} className="border-b border-white/5 align-top"><td className="py-1.5 pr-3 whitespace-nowrap text-muted">{fmtDate(e.workDate, loc)}</td><td className="py-1.5 pr-3 whitespace-nowrap">{e.userName}</td><td className="py-1.5 pr-3 text-muted">{e.description || "—"}</td><td className="py-1.5 whitespace-nowrap text-right">{minLabel(e.minutes)}</td></tr>
                ))}</tbody>
                <tfoot><tr><td colSpan={3} className="pt-2 text-right text-xs text-muted">{l("Total", "Total")}</td><td className="pt-2 text-right font-semibold whitespace-nowrap">{minLabel(t.timeEntries.reduce((a, e) => a + e.minutes, 0))}</td></tr></tfoot>
              </table>
            </div>)}
        </>
      )}

      {error && <p role="alert" className="mb-3 text-sm text-danger">{error}</p>}
      <div className="flex justify-between gap-2">
        {t && editable ? <button className="btn btn-danger" onClick={() => { if (window.confirm(l("Supprimer cette tâche ?", "Delete this task?"))) void api(`/api/tasks/${taskId}`, { method: "DELETE" }).then(async () => { await refresh(); onClose(); }); }}><Trash2 size={15} />{l("Supprimer", "Delete")}</button> : <span />}
        <div className="flex gap-2"><button className="btn" onClick={onClose}>{l("Fermer", "Close")}</button>{editable && <button className="btn btn-primary" disabled={busy || !String(form.title ?? "").trim()} onClick={() => void save()}>{l("Enregistrer", "Save")}</button>}</div>
      </div>
      {log && <LogTimeDialog seg={log} onClose={() => { setLog(null); void acts.refresh(); }} />}
      {closing && (
        <Modal title={l("Du temps n'est pas saisi", "Some time is not logged")} onClose={() => setClosing(false)}>
          <p className="mb-4 text-sm text-muted">{runHere ? l("Le chrono tourne encore sur cette tâche. ", "The timer is still running on this task. ") : ""}{pendingHere.length > 0 ? l(`Il reste ${minLabel(pendingHere.reduce((a, x) => a + x.minutes, 0))} à saisir.`, `${minLabel(pendingHere.reduce((a, x) => a + x.minutes, 0))} left to log.`) : ""}</p>
          <div className="flex flex-col gap-2">
            <button className="btn btn-primary" onClick={() => void act(async () => { setClosing(false); if (runHere) setLog(await acts.stop()); else if (pendingHere[0]) setLog({ segmentId: pendingHere[0].id, minutes: pendingHere[0].minutes, title: t!.title, clientId: t!.clientId, clientName: t!.clientName }); })}>{l("Saisir le temps maintenant", "Log the time now")}</button>
            <button className="btn" onClick={() => void act(async () => { if (runHere) await acts.stop(); closeOk.current = true; setClosing(false); await save(); })}>{l("Terminer et saisir le temps plus tard", "Complete and log the time later")}</button>
            <button className="btn" onClick={() => setClosing(false)}>{l("Annuler", "Cancel")}</button>
          </div>
        </Modal>
      )}
    </Modal>
  );
}

const b64 = (f: File) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1] ?? ""); r.onerror = () => rej(new Error("read")); r.readAsDataURL(f); });

/** Files on a task (5 MB each, 20 at most). Always downloaded, never shown in the page. */
function Files({ taskId, editable }: { taskId: string; editable: boolean }) {
  const l = useL();
  const qc = useQueryClient();
  const [error, setError] = useState("");
  const q = useQuery({ queryKey: ["task-files", taskId], queryFn: () => api<TaskFile[]>(`/api/pipeline/tasks/${taskId}/files`) });
  const refresh = () => qc.invalidateQueries({ queryKey: ["task-files", taskId] });
  const upload = async (f: File) => {
    setError("");
    try {
      if (f.size > 5 * 1024 * 1024) throw new Error(l("Le fichier dépasse 5 Mo.", "The file is over 5 MB."));
      await api(`/api/pipeline/tasks/${taskId}/files`, { body: { name: f.name, type: f.type || undefined, data: await b64(f) } });
      await refresh();
    } catch (e) { setError(errMsg(e, "Error")); }
  };
  return (
    <div className="mb-4">
      {!q.data?.length ? <p className="mb-2 text-xs text-muted">{l("Aucun fichier.", "No files.")}</p> : (
        <ul className="mb-2 space-y-1 text-sm">{q.data.map((f) => (
          <li key={f.id} className="flex items-center gap-2"><a href={`/api/pipeline/files/${f.id}`} className="truncate">{f.name}</a><span className="text-xs text-muted">{Math.max(1, Math.round(f.size / 1024))} KB · {f.byName}</span>
            {editable && <button className="ml-auto text-muted hover:text-danger" aria-label="remove file" onClick={() => void api(`/api/pipeline/files/${f.id}`, { method: "DELETE" }).then(refresh)}><Trash2 size={13} /></button>}</li>))}</ul>)}
      {editable && <input type="file" className="input" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void upload(f); }} />}
      {error && <p role="alert" className="mt-1 text-sm text-danger">{error}</p>}
    </div>
  );
}
