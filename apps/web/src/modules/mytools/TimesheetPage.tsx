import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronLeft, ChevronRight, Plus, Send, Trash2, X } from "lucide-react";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { addDays, fmtDate, hours, mondayOf, todayISO, useL, useLocale } from "../../lib/l";
import { Chip, Empty, errMsg, FormDialog, Tabs, type FieldDef } from "../../components/kit";
import { PageHeader } from "../../components/ui";

interface Entry { id: string; workDate: string; minutes: number; clientId: string | null; clientName: string | null; description: string; billable: boolean; status: string; taskTitle: string | null }
interface Week { week: string; entries: Entry[]; totalMinutes: number; hasDraft: boolean }
interface Pending { id: string; userName: string; workDate: string; minutes: number; clientName: string | null; description: string; billable: boolean }

const tone = (s: string) => (s === "approved" ? "ok" : s === "submitted" ? "warn" : s === "rejected" ? "danger" : "off") as "ok" | "warn" | "danger" | "off";

export default function TimesheetPage() {
  const l = useL();
  const loc = useLocale();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [tab, setTab] = useState<"mine" | "approve">(can("mytools.timesheet.use") ? "mine" : "approve");
  const [week, setWeek] = useState(mondayOf(todayISO()));
  const [dialog, setDialog] = useState<null | { row?: Entry; date?: string }>(null);
  const [error, setError] = useState("");
  const q = useQuery({ queryKey: ["timesheet", week], queryFn: () => api<Week>(`/api/my/timesheet?week=${week}`), enabled: tab === "mine" });
  const pending = useQuery({ queryKey: ["timesheet-pending"], queryFn: () => api<Pending[]>("/api/my/timesheet/pending"), enabled: tab === "approve" && can("mytools.timesheet.approve") });
  const refresh = async () => { await qc.invalidateQueries({ queryKey: ["timesheet"] }); await qc.invalidateQueries({ queryKey: ["timesheet-pending"] }); await qc.invalidateQueries({ queryKey: ["w-ts"] }); };
  const days = Array.from({ length: 7 }, (_, i) => addDays(week, i));
  const run = async (fn: () => Promise<unknown>) => { try { setError(""); await fn(); await refresh(); } catch (e) { setError(errMsg(e, "Error")); } };

  const fields: FieldDef[] = [
    { name: "workDate", label: ["Date", "Date"], type: "date", required: true },
    { name: "hours", label: ["Durée (heures)", "Duration (hours)"], type: "number", step: "0.25", required: true },
    { name: "clientId", label: ["Client", "Client"], type: "client" },
    { name: "billable", label: ["Facturable", "Billable"], type: "checkbox" },
    { name: "description", label: ["Description", "Description"], type: "textarea", rows: 2 },
  ];

  return (
    <>
      <PageHeader title={l("Feuille de temps", "Timesheet")} />
      {can("mytools.timesheet.approve") && can("mytools.timesheet.use") && <Tabs tabs={[{ key: "mine", label: l("Ma semaine", "My week") }, { key: "approve", label: `${l("À approuver", "To approve")}${pending.data ? ` (${pending.data.length})` : ""}` }]} value={tab} onChange={setTab} />}
      {error && <p role="alert" className="mb-3 text-sm text-danger">{error}</p>}

      {tab === "mine" && q.data && (
        <>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2"><button className="btn !p-2" onClick={() => setWeek(addDays(week, -7))} aria-label="previous"><ChevronLeft size={16} /></button><span className="min-w-[200px] text-center text-sm font-medium">{fmtDate(week, loc)} → {fmtDate(addDays(week, 6), loc)}</span><button className="btn !p-2" onClick={() => setWeek(addDays(week, 7))} aria-label="next"><ChevronRight size={16} /></button></div>
            <div className="flex items-center gap-3"><span className="text-lg font-semibold">{hours(q.data.totalMinutes)}</span>
              {q.data.hasDraft && q.data.entries.length > 0 && <button className="btn btn-primary" onClick={() => void run(() => api("/api/my/timesheet/submit", { body: { week } }))}><Send size={15} />{l("Soumettre la semaine", "Submit week")}</button>}</div>
          </div>
          <div className="grid gap-3 lg:grid-cols-7">
            {days.map((d) => {
              const rows = q.data.entries.filter((e) => e.workDate === d);
              const total = rows.reduce((a, e) => a + e.minutes, 0);
              return (
                <section key={d} className="glass flex min-h-[170px] flex-col p-3">
                  <div className="mb-2 flex items-center justify-between"><span className="text-xs font-medium text-muted">{new Date(`${d}T12:00:00`).toLocaleDateString(loc, { weekday: "short", day: "numeric" })}</span><span className="text-xs">{total ? hours(total) : ""}</span></div>
                  <div className="flex-1 space-y-1.5">{rows.map((e) => (
                    <button key={e.id} className="glass-flat block w-full p-2 text-left text-xs transition hover:bg-white/10" onClick={() => (e.status === "draft" || e.status === "rejected") && setDialog({ row: e })}>
                      <div className="flex justify-between gap-1"><b>{hours(e.minutes)}</b><Chip tone={tone(e.status)}>{e.status}</Chip></div>
                      <div className="mt-0.5 truncate text-muted">{e.clientName ?? l("Interne", "Internal")}{e.billable ? " $" : ""}</div>
                      {e.description && <div className="truncate">{e.description}</div>}
                    </button>))}</div>
                  {can("mytools.timesheet.use") && <button className="btn mt-2 !py-1 text-xs" onClick={() => setDialog({ date: d })}><Plus size={13} /></button>}
                </section>
              );
            })}
          </div>
        </>
      )}

      {tab === "approve" && (
        <section className="glass overflow-x-auto p-2">
          {!pending.data?.length ? <Empty>{l("Rien à approuver.", "Nothing to approve.")}</Empty> : (
            <table className="grid"><thead><tr><th>{l("Employé", "Employee")}</th><th>Date</th><th>{l("Durée", "Duration")}</th><th>Client</th><th>Description</th><th /></tr></thead>
              <tbody>{pending.data.map((e) => (
                <tr key={e.id}><td className="font-medium">{e.userName}</td><td>{fmtDate(e.workDate, loc)}</td><td>{hours(e.minutes)}</td><td className="text-muted">{e.clientName ?? "—"}{e.billable ? " $" : ""}</td><td className="text-muted">{e.description}</td>
                  <td className="whitespace-nowrap text-right"><button className="btn !p-1.5" title={l("Approuver", "Approve")} onClick={() => void run(() => api(`/api/my/timesheet/${e.id}/decision`, { body: { decision: "approve" } }))}><Check size={15} color="var(--ok)" /></button> <button className="btn !p-1.5" title={l("Refuser", "Reject")} onClick={() => void run(() => api(`/api/my/timesheet/${e.id}/decision`, { body: { decision: "reject" } }))}><X size={15} color="var(--danger)" /></button></td></tr>))}</tbody></table>
          )}
          <p className="p-3 text-xs text-muted">{l("Le temps facturable approuvé est envoyé à « Travail à facturer ».", "Approved billable time is sent to “Work to bill”.")}</p>
        </section>
      )}

      {dialog && (
        <FormDialog title={dialog.row ? l("Modifier l'entrée", "Edit entry") : l("Nouvelle entrée de temps", "New time entry")} fields={fields}
          initial={dialog.row ? { workDate: dialog.row.workDate, hours: dialog.row.minutes / 60, clientId: dialog.row.clientId ?? "", billable: dialog.row.billable, description: dialog.row.description } : { workDate: dialog.date ?? todayISO(), billable: true }}
          onSubmit={async (v) => {
            const body = { workDate: v.workDate, minutes: Math.round(Number(v.hours) * 60), clientId: v.clientId || null, billable: Boolean(v.billable), description: v.description ?? "" };
            if (dialog.row) await api(`/api/my/timesheet/${dialog.row.id}`, { method: "PATCH", body }); else await api("/api/my/timesheet", { body });
            await refresh();
          }} onClose={() => setDialog(null)}>
          {dialog.row && <button type="button" className="btn btn-danger mb-3" onClick={() => void run(async () => { await api(`/api/my/timesheet/${dialog.row!.id}`, { method: "DELETE" }); setDialog(null); })}><Trash2 size={14} />{l("Supprimer", "Delete")}</button>}
        </FormDialog>
      )}
    </>
  );
}
