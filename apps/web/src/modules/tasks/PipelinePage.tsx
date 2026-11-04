import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { fmtDate, useL, useLocale } from "../../lib/l";
import { Chip, Empty, Tabs } from "../../components/kit";
import { PageHeader } from "../../components/ui";
import TaskDialog from "./TaskDialog";
import { priorityLabel, priorityTone, statusLabel, type TaskRow } from "./TasksPage";

interface Day { today: string; overdue: TaskRow[]; dueToday: TaskRow[]; doing: TaskRow[] }
const COLUMNS = ["todo", "doing", "blocked", "done"] as const;

/** Daily work organisation (reference "Pipeline"): "my day" on one side, a status board on the other. */
export default function PipelinePage() {
  const l = useL();
  const loc = useLocale();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [view, setView] = useState<"day" | "board">("day");
  const [scope, setScope] = useState<"me" | "all">("me");
  const [dialog, setDialog] = useState<{ id: string | null } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const day = useQuery({ queryKey: ["pipeline", "day"], queryFn: () => api<Day>("/api/tasks/day") });
  const board = useQuery({ queryKey: ["pipeline", "board", scope], queryFn: () => api<TaskRow[]>(`/api/tasks?${scope === "me" ? "assignee=me&" : ""}parent=none&status=all`), enabled: view === "board" });

  const move = async (id: string, status: string) => {
    try { await api(`/api/tasks/${id}`, { method: "PATCH", body: { status } }); await qc.invalidateQueries({ queryKey: ["pipeline"] }); await qc.invalidateQueries({ queryKey: ["tasks"] }); }
    catch (e) { alert(e instanceof Error ? e.message : "Error"); }
  };

  const Card = ({ t, compact }: { t: TaskRow; compact?: boolean }) => (
    <div draggable={!compact} onDragStart={() => setDragId(t.id)} onClick={() => setDialog({ id: t.id })} className="glass-flat cursor-pointer p-3 text-sm transition hover:bg-white/10">
      <div className="font-medium">{t.title}{t.isWaiting && " ⏳"}{t.recurrence ? " ↻" : ""}</div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
        <Chip tone={priorityTone(t.priority)}>{priorityLabel(l, t.priority)}</Chip>
        {t.clientName && <span>{t.clientName}</span>}{t.dueDate && <span>· {fmtDate(t.dueDate, loc)}</span>}
        {t.checklistTotal > 0 && <span>· ☑ {t.checklistDone}/{t.checklistTotal}</span>}
      </div>
      {compact && t.status !== "done" && (
        <div className="mt-2 flex gap-1.5" onClick={(e) => e.stopPropagation()}>
          {t.status !== "doing" && <button className="btn !px-2.5 !py-1 text-xs" onClick={() => void move(t.id, "doing")}>{l("Commencer", "Start")}</button>}
          <button className="btn !px-2.5 !py-1 text-xs" onClick={() => void move(t.id, "done")}>{l("Terminer", "Done")}</button>
        </div>
      )}
    </div>
  );

  const Section = ({ title, rows, tone }: { title: string; rows: TaskRow[]; tone?: string }) => (
    <section className="glass p-4">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold" style={{ color: tone }}>{title}<span className="chip">{rows.length}</span></h2>
      <div className="space-y-2">{rows.length ? rows.map((t) => <Card key={t.id} t={t} compact />) : <p className="text-sm text-muted">—</p>}</div>
    </section>
  );

  return (
    <>
      <PageHeader title={l("Pipeline", "Pipeline")} subtitle={l("Organisation du travail de la journée", "Organizing the day's work")}
        actions={can("tasks.edit", "tasks.manage", "command.pipeline.edit") && <button className="btn btn-primary" onClick={() => setDialog({ id: null })}><Plus size={16} />{l("Nouvelle tâche", "New task")}</button>} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs tabs={[{ key: "day", label: l("Ma journée", "My day") }, { key: "board", label: l("Tableau", "Board") }]} value={view} onChange={setView} />
        {view === "board" && <Tabs tabs={[{ key: "me", label: l("Mes tâches", "My tasks") }, { key: "all", label: l("Équipe", "Team") }]} value={scope} onChange={setScope} />}
      </div>

      {view === "day" && day.data && (
        day.data.overdue.length + day.data.dueToday.length + day.data.doing.length === 0
          ? <div className="glass"><Empty>🎉 {l("Rien d'urgent aujourd'hui.", "Nothing urgent today.")}</Empty></div>
          : <div className="grid gap-4 lg:grid-cols-3">
              <Section title={l("En retard", "Overdue")} rows={day.data.overdue} tone="var(--danger)" />
              <Section title={l("Aujourd'hui", "Today")} rows={day.data.dueToday} />
              <Section title={l("En cours", "In progress")} rows={day.data.doing} tone="var(--warn)" />
            </div>
      )}

      {view === "board" && (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {COLUMNS.map((s) => {
            const rows = (board.data ?? []).filter((t) => t.status === s);
            return (
              <section key={s} className="glass min-h-[240px] p-3" onDragOver={(e) => e.preventDefault()} onDrop={() => { if (dragId) { void move(dragId, s); setDragId(null); } }}>
                <h2 className="mb-3 flex items-center gap-2 px-1 text-sm font-semibold">{statusLabel(l, s)}<span className="chip">{rows.length}</span></h2>
                <div className="space-y-2">{rows.map((t) => <Card key={t.id} t={t} />)}</div>
              </section>
            );
          })}
        </div>
      )}
      {dialog && <TaskDialog taskId={dialog.id} onClose={() => setDialog(null)} />}
    </>
  );
}
