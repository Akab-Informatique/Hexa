import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { fmtDate, useL, useLocale } from "../../lib/l";
import { Chip, errMsg, FormFields, useUsers, type FieldDef } from "../../components/kit";
import { Modal } from "../../components/ui";
import type { TaskRow } from "./TasksPage";

interface Full extends TaskRow {
  description: string; startDate: string | null; estimateMinutes: number | null; visibility: string; waitsForId: string | null; waitsForTitle: string | null;
  recurrence: { every: number; unit: string; until?: string | null } | null; tags: string[]; createdBy: string | null; isWaiting: boolean;
  checklist: { id: string; text: string; done: boolean }[]; notes: { id: string; body: string; userName: string | null; createdAt: string }[];
  subtasks: { id: string; title: string; status: string }[]; viewers: { id: string; name: string }[];
}

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
  const [newNote, setNewNote] = useState("");
  const [viewerIds, setViewerIds] = useState<string[] | null>(null);

  const t = detail.data;
  if (taskId && !t) return null;
  const form = values ?? (t
    ? { ...t, assigneeId: t.assigneeId ?? "", clientId: t.clientId ?? "", dueDate: t.dueDate ?? "", startDate: t.startDate ?? "", estimateMinutes: t.estimateMinutes ?? "", waitsForId: t.waitsForId ?? "", tags: t.tags.join(", "), recEvery: t.recurrence?.every ?? "", recUnit: t.recurrence?.unit ?? "week", recUntil: t.recurrence?.until ?? "" }
    : { status: "todo", priority: "normal", visibility: "team", assigneeId: me.user?.id, recUnit: "week", ...defaults });
  const editable = !t || can("tasks.manage", "command.pipeline.manage") || t.createdBy === me.user?.id || t.assigneeId === me.user?.id;
  const selViewers = viewerIds ?? t?.viewers.map((v) => v.id) ?? [];
  const refresh = async () => { await qc.invalidateQueries({ queryKey: ["task", taskId] }); await qc.invalidateQueries({ queryKey: ["tasks"] }); await qc.invalidateQueries({ queryKey: ["pipeline"] }); await qc.invalidateQueries({ queryKey: ["tasks-open-list"] }); };

  const fields: FieldDef[] = [
    { name: "title", label: ["Titre", "Title"], required: true, span: 2 },
    { name: "description", label: ["Description", "Description"], type: "textarea" },
    { name: "status", label: ["Statut", "Status"], type: "select", required: true, options: [{ value: "todo", label: ["À faire", "To do"] }, { value: "doing", label: ["En cours", "Doing"] }, { value: "blocked", label: ["Bloquée", "Blocked"] }, { value: "done", label: ["Terminée", "Done"] }] },
    { name: "priority", label: ["Priorité", "Priority"], type: "select", required: true, options: [{ value: "low", label: ["Basse", "Low"] }, { value: "normal", label: ["Normale", "Normal"] }, { value: "high", label: ["Haute", "High"] }, { value: "urgent", label: ["Urgente", "Urgent"] }] },
    { name: "assigneeId", label: ["Assignée à", "Assigned to"], type: "user" }, { name: "clientId", label: ["Client", "Client"], type: "client" },
    { name: "startDate", label: ["Début", "Start"], type: "date" }, { name: "dueDate", label: ["Échéance", "Due"], type: "date" },
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

  const save = async () => {
    setBusy(true); setError("");
    const v = form as Record<string, unknown>;
    const body = {
      title: v.title, description: v.description ?? "", status: v.status, priority: v.priority, visibility: v.visibility,
      assigneeId: v.assigneeId || null, clientId: v.clientId || null, startDate: v.startDate || null, dueDate: v.dueDate || null,
      estimateMinutes: v.estimateMinutes === "" || v.estimateMinutes == null ? null : Number(v.estimateMinutes), waitsForId: v.waitsForId || null,
      tags: String(v.tags ?? "").split(",").map((s) => s.trim()).filter(Boolean),
      recurrence: v.recEvery ? { every: Number(v.recEvery), unit: v.recUnit, until: v.recUntil || null } : null,
      viewerIds: v.visibility === "selected" ? selViewers : [],
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
      <fieldset disabled={!editable} className="min-w-0 border-0 p-0">
        <FormFields fields={fields} values={form} onChange={setValues} />
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
          <h3 className="mb-2 mt-2 text-sm font-semibold">{l("Liste de vérification", "Checklist")} ({t.checklist.filter((c) => c.done).length}/{t.checklist.length})</h3>
          <ul className="mb-2 space-y-1">
            {t.checklist.map((c) => (
              <li key={c.id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" checked={c.done} disabled={!editable} onChange={(e) => void act(() => api(`/api/tasks/checklist/${c.id}`, { method: "PATCH", body: { done: e.target.checked } }))} />
                <span className={c.done ? "text-muted line-through" : ""}>{c.text}</span>
                {editable && <button className="ml-auto text-muted hover:text-danger" onClick={() => void act(() => api(`/api/tasks/checklist/${c.id}`, { method: "DELETE" }))} aria-label="delete"><Trash2 size={13} /></button>}
              </li>
            ))}
          </ul>
          {editable && <form className="mb-4 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (newItem.trim()) void act(async () => { await api(`/api/tasks/${taskId}/checklist`, { body: { text: newItem.trim() } }); setNewItem(""); }); }}>
            <input className="input" placeholder={l("Ajouter un élément…", "Add an item…")} value={newItem} onChange={(e) => setNewItem(e.target.value)} /><button className="btn"><Plus size={15} /></button></form>}

          {t.subtasks.length > 0 && <><h3 className="mb-2 text-sm font-semibold">{l("Sous-tâches", "Sub-tasks")}</h3><ul className="mb-4 space-y-1 text-sm">{t.subtasks.map((s) => <li key={s.id}><Chip tone={s.status === "done" ? "ok" : "off"}>{s.status}</Chip> {s.title}</li>)}</ul></>}

          <h3 className="mb-2 text-sm font-semibold">{l("Notes", "Notes")}</h3>
          <ul className="mb-2 space-y-2">{t.notes.map((n) => <li key={n.id} className="glass-flat p-2.5 text-sm"><div className="mb-0.5 text-xs text-muted">{n.userName} · {fmtDate(n.createdAt, loc)}</div><div className="whitespace-pre-wrap">{n.body}</div></li>)}</ul>
          <form className="mb-4 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (newNote.trim()) void act(async () => { await api(`/api/tasks/${taskId}/notes`, { body: { body: newNote.trim() } }); setNewNote(""); }); }}>
            <input className="input" placeholder={l("Ajouter une note…", "Add a note…")} value={newNote} onChange={(e) => setNewNote(e.target.value)} /><button className="btn"><Plus size={15} /></button></form>
        </>
      )}

      {error && <p role="alert" className="mb-3 text-sm text-danger">{error}</p>}
      <div className="flex justify-between gap-2">
        {t && editable ? <button className="btn btn-danger" onClick={() => { if (window.confirm(l("Supprimer cette tâche ?", "Delete this task?"))) void api(`/api/tasks/${taskId}`, { method: "DELETE" }).then(async () => { await refresh(); onClose(); }); }}><Trash2 size={15} />{l("Supprimer", "Delete")}</button> : <span />}
        <div className="flex gap-2"><button className="btn" onClick={onClose}>{l("Fermer", "Close")}</button>{editable && <button className="btn btn-primary" disabled={busy || !String(form.title ?? "").trim()} onClick={() => void save()}>{l("Enregistrer", "Save")}</button>}</div>
      </div>
    </Modal>
  );
}
