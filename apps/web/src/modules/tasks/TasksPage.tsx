import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CircleDot, Plus, Search, Zap } from "lucide-react";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { fmtDate, todayISO, useL, useLocale } from "../../lib/l";
import { Chip, Empty, Toolbar, useClients, useUsers } from "../../components/kit";
import { PageHeader } from "../../components/ui";
import TaskDialog from "./TaskDialog";
import AutoTaskRules from "./AutoTaskRules";

export interface TaskRow {
  id: string; title: string; status: "todo" | "taken" | "doing" | "blocked" | "done"; priority: "low" | "normal" | "high" | "urgent"; assigneeId: string | null; assigneeName: string | null;
  clientId: string | null; clientName: string | null; dueDate: string | null; checklistTotal: number; checklistDone: number; subtaskTotal: number; isWaiting: boolean; visibility: string; recurrence: unknown;
}

export const priorityTone = (p: string) => (p === "urgent" ? "danger" : p === "high" ? "warn" : "off") as "danger" | "warn" | "off";
export const statusLabel = (l: ReturnType<typeof useL>, s: string) => ({ todo: l("Nouvelle", "New"), taken: l("Prise en charge", "Taken over"), doing: l("En cours", "In progress"), blocked: l("En attente du client", "Waiting for customer"), done: l("Terminée", "Completed") }[s] ?? s);
export const priorityLabel = (l: ReturnType<typeof useL>, p: string) => ({ low: l("Basse", "Low"), normal: l("Normale", "Normal"), high: l("Haute", "High"), urgent: l("Urgente", "Urgent") }[p] ?? p);

/** The big view of all tasks: filters on top, one row per task, click to open the editor. */
export default function TasksPage() {
  const l = useL();
  const loc = useLocale();
  const { can } = useAuth();
  const qc = useQueryClient();
  const users = useUsers();
  const clients = useClients();
  const [params, setParams] = useSearchParams();
  // Links (the meeting gauges, a person's count) arrive with their filters in the address.
  const [f, setF] = useState({ q: "", assignee: params.get("assignee") ?? "", status: params.get("status") ?? "open", client: params.get("client") ?? "", priority: "", due: params.get("due") ?? "" });
  const [dialog, setDialog] = useState<{ id: string | null } | null>(null);
  const [rules, setRules] = useState(false);
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));

  useEffect(() => { const o = params.get("open"); if (o) { setDialog({ id: o }); setParams({}, { replace: true }); } }, [params, setParams]);

  const qs = new URLSearchParams(Object.entries({ ...f, parent: "none" }).filter(([, v]) => v)).toString();
  const list = useQuery({ queryKey: ["tasks", qs], queryFn: () => api<TaskRow[]>(`/api/tasks?${qs}`) });
  const today = todayISO();
  const toggle = async (t: TaskRow) => {
    try { await api(`/api/tasks/${t.id}`, { method: "PATCH", body: { status: t.status === "done" ? "todo" : "done" } }); await qc.invalidateQueries({ queryKey: ["tasks"] }); }
    catch (e) { alert(e instanceof Error ? e.message : "Error"); }
  };

  return (
    <>
      <PageHeader title={l("Tâches", "Tasks")} subtitle={l("Toutes les tâches de l'équipe", "All the team's tasks")}
        actions={<>{can("tasks.automation.manage") && <button className="btn" onClick={() => setRules(true)}><Zap size={16} />{l("Automatisation", "Automation")}</button>}{can("tasks.edit", "tasks.manage", "command.pipeline.edit") && <button className="btn btn-primary" onClick={() => setDialog({ id: null })}><Plus size={16} />{l("Nouvelle tâche", "New task")}</button>}</>} />
      <Toolbar>
        <div className="relative min-w-[200px] flex-1"><Search size={15} className="pointer-events-none absolute left-3 top-3 text-muted" /><input className="input !pl-9" placeholder={l("Rechercher…", "Search…")} value={f.q} onChange={(e) => set("q", e.target.value)} /></div>
        <select className="input !w-auto" value={f.status} onChange={(e) => set("status", e.target.value)} aria-label="status">
          <option value="open">{l("Ouvertes", "Open")}</option><option value="all">{l("Toutes", "All")}</option><option value="todo">{l("Nouvelles", "New")}</option><option value="taken">{l("Prises en charge", "Taken over")}</option><option value="doing">{l("En cours", "In progress")}</option><option value="blocked">{l("En attente du client", "Waiting for customer")}</option><option value="done">{l("Terminées", "Done")}</option></select>
        <select className="input !w-auto" value={f.assignee} onChange={(e) => set("assignee", e.target.value)} aria-label="assignee"><option value="">{l("Tous", "Everyone")}</option><option value="me">{l("Moi", "Me")}</option><option value="none">{l("Non assignées", "Unassigned")}</option>{users.data?.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
        <select className="input !w-auto" value={f.client} onChange={(e) => set("client", e.target.value)} aria-label="client"><option value="">{l("Tous les clients", "All clients")}</option>{clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <select className="input !w-auto" value={f.priority} onChange={(e) => set("priority", e.target.value)} aria-label="priority"><option value="">{l("Priorité", "Priority")}</option><option value="urgent">{l("Urgente", "Urgent")}</option><option value="high">{l("Haute", "High")}</option><option value="normal">{l("Normale", "Normal")}</option><option value="low">{l("Basse", "Low")}</option></select>
        <select className="input !w-auto" value={f.due} onChange={(e) => set("due", e.target.value)} aria-label="due"><option value="">{l("Échéance", "Due")}</option><option value="overdue">{l("En retard", "Overdue")}</option><option value="today">{l("Aujourd'hui", "Today")}</option><option value="friday">{l("D'ici vendredi", "By Friday")}</option><option value="week">{l("Cette semaine", "This week")}</option></select>
      </Toolbar>

      <div className="glass overflow-x-auto p-2">
        {list.data?.length === 0 ? <Empty>{l("Aucune tâche.", "No tasks.")}</Empty> : (
          <table className="grid">
            <thead><tr><th style={{ width: 40 }} /><th>{l("Tâche", "Task")}</th><th>{l("Client", "Client")}</th><th>{l("Assignée à", "Assignee")}</th><th>{l("Échéance", "Due")}</th><th>{l("Priorité", "Priority")}</th><th>{l("Statut", "Status")}</th></tr></thead>
            <tbody>{list.data?.map((t) => (
              <tr key={t.id} className="cursor-pointer" onClick={() => setDialog({ id: t.id })}>
                <td onClick={(e) => { e.stopPropagation(); void toggle(t); }}><span className="grid h-5 w-5 place-items-center rounded-md border border-white/30" style={t.status === "done" ? { background: "var(--ok)", borderColor: "transparent" } : undefined}>{t.status === "done" && <Check size={13} color="#000" />}</span></td>
                <td><div className={`font-medium ${t.status === "done" ? "text-muted line-through" : ""}`}>{t.title}{t.isWaiting && " ⏳"}{t.recurrence ? " ↻" : ""}{t.visibility === "private" ? " 🔒" : ""}</div>
                  {(t.checklistTotal > 0 || t.subtaskTotal > 0) && <div className="text-xs text-muted">{t.checklistTotal > 0 && `☑ ${t.checklistDone}/${t.checklistTotal}`} {t.subtaskTotal > 0 && `· ${t.subtaskTotal} ${l("sous-tâches", "sub-tasks")}`}</div>}</td>
                <td className="text-muted">{t.clientName ?? "—"}</td><td className="text-muted">{t.assigneeName ?? "—"}</td>
                <td style={{ color: t.dueDate && t.dueDate < today && t.status !== "done" ? "var(--danger)" : undefined }}>{fmtDate(t.dueDate, loc)}</td>
                <td><Chip tone={priorityTone(t.priority)}>{priorityLabel(l, t.priority)}</Chip></td>
                <td><Chip tone={t.status === "done" ? "ok" : t.status === "blocked" ? "danger" : t.status === "doing" ? "warn" : "off"}><CircleDot size={11} />{statusLabel(l, t.status)}</Chip></td>
              </tr>))}</tbody>
          </table>
        )}
      </div>
      {rules && <AutoTaskRules onClose={() => setRules(false)} />}
      {dialog && <TaskDialog taskId={dialog.id} onClose={() => setDialog(null)} />}
    </>
  );
}
