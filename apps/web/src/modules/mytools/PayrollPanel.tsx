import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Download } from "lucide-react";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { addDays, fmtDate, todayISO, useL, useLocale } from "../../lib/l";
import { Chip, Empty, errMsg, Stat } from "../../components/kit";

interface DayRow { date: string; trackedMinutes: number; billableMinutes: number; paidMinutes: number }
interface Emp {
  userId: string; name: string; trackedMinutes: number; billableMinutes: number; nonBillableMinutes: number; paidMinutes: number; timerMinutes: number;
  days: DayRow[]; byClient: { clientId: string | null; name: string; minutes: number; billableMinutes: number }[];
  byTask: { taskId: string; title: string; clientName: string | null; minutes: number; billableMinutes: number }[];
  statuses: Record<string, { count: number; minutes: number }>; weeks: { start: string; status: string }[];
}
interface Payroll { period: { start: string; end: string; days: number; type: "weekly" | "biweekly" }; config: { type: "weekly" | "biweekly"; anchor: string }; employees: Emp[] }
interface Settings { type: "weekly" | "biweekly"; anchor: string; canEdit: boolean }

const hm = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
const statusTone = (s: string) => (s === "approved" || s === "paid" ? "ok" : s === "submitted" ? "warn" : s === "rejected" ? "danger" : "off") as "ok" | "warn" | "danger" | "off";
const statusText: Record<string, [string, string]> = { draft: ["Brouillon", "Draft"], submitted: ["Envoyée", "Sent"], approved: ["Approuvée", "Approved"], rejected: ["Refusée", "Refused"], paid: ["Payée", "Paid"] };

/** Payroll view: one pay period, per employee totals, days, clients and tasks, with a CSV export. Approvers and managers only (the server checks too). */
export function PayrollPanel() {
  const l = useL();
  const loc = useLocale();
  const { can } = useAuth();
  const qc = useQueryClient();
  const manager = can("mytools.timesheet.manage");
  const [date, setDate] = useState(todayISO());
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState("");
  const q = useQuery({ queryKey: ["time-payroll", date], queryFn: () => api<Payroll>(`/api/time/payroll?date=${date}`) });
  const settings = useQuery({ queryKey: ["time-payroll-settings"], queryFn: () => api<Settings>("/api/time/payroll/settings") });
  const [cfgType, setCfgType] = useState<"weekly" | "biweekly" | "">("");
  const [cfgAnchor, setCfgAnchor] = useState("");
  const p = q.data?.period;
  const rows = q.data?.employees ?? [];
  const tot = rows.reduce((a, e) => ({ tracked: a.tracked + e.trackedMinutes, billable: a.billable + e.billableMinutes, paid: a.paid + e.paidMinutes }), { tracked: 0, billable: 0, paid: 0 });

  const saveCfg = async () => {
    setError("");
    try {
      await api("/api/time/payroll/settings", { method: "PUT", body: { type: cfgType || settings.data?.type, anchor: cfgAnchor || settings.data?.anchor } });
      setCfgType(""); setCfgAnchor("");
      await qc.invalidateQueries({ queryKey: ["time-payroll-settings"] }); await qc.invalidateQueries({ queryKey: ["time-payroll"] });
    } catch (e) { setError(errMsg(e, "Error")); }
  };

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button className="btn !p-2" aria-label="prev" disabled={!p} onClick={() => p && setDate(addDays(p.start, -1))}><ChevronLeft size={16} /></button>
        <div className="glass-flat px-4 py-2 text-sm font-medium">{p ? `${fmtDate(p.start, loc)} → ${fmtDate(p.end, loc)}` : "…"} <span className="ml-2 text-xs text-muted">{p?.type === "biweekly" ? l("aux deux semaines", "biweekly") : l("hebdomadaire", "weekly")}</span></div>
        <button className="btn !p-2" aria-label="next" disabled={!p} onClick={() => p && setDate(addDays(p.end, 1))}><ChevronRight size={16} /></button>
        <button className="btn" onClick={() => setDate(todayISO())}>{l("Période courante", "Current period")}</button>
        <div className="flex-1" />
        {p && <a className="btn btn-primary" href={`/api/time/payroll/export?date=${p.start}`} download><Download size={15} />{l("Exporter en CSV", "Export CSV")}</a>}
      </div>
      {error && <p role="alert" className="mb-3 text-sm text-danger">{error}</p>}

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label={l("Heures saisies", "Tracked hours")} value={hm(tot.tracked)} />
        <Stat label={l("Facturables", "Billable")} value={hm(tot.billable)} />
        <Stat label={l("Non facturables", "Non-billable")} value={hm(Math.max(0, tot.tracked - tot.billable))} />
        <Stat label={l("Heures payées (journées, congés)", "Paid hours (work days, leave)")} value={hm(tot.paid)} />
      </div>

      <div className="glass overflow-x-auto p-2">
        {!rows.length ? <Empty>{l("Aucune entrée sur cette période.", "No entries in this period.")}</Empty> : (
          <table className="grid">
            <thead><tr><th>{l("Employé", "Employee")}</th><th>{l("Saisies", "Tracked")}</th><th>{l("Facturables", "Billable")}</th><th>{l("Non fact.", "Non-bill.")}</th><th>{l("Chrono", "Timer")}</th><th>{l("Payées", "Paid")}</th><th>{l("Statuts", "Statuses")}</th><th /></tr></thead>
            <tbody>{rows.map((e) => (
              <PayRow key={e.userId} e={e} period={p!} open={open === e.userId} toggle={() => setOpen(open === e.userId ? null : e.userId)} />
            ))}</tbody>
          </table>)}
      </div>

      {manager && settings.data && (
        <section className="glass mt-4 p-4">
          <h2 className="mb-2 text-sm font-semibold">{l("Période de paie de l'entreprise", "Firm pay period")}</h2>
          <div className="flex flex-wrap items-end gap-3">
            <label><span className="label">{l("Type", "Type")}</span>
              <select className="input" value={cfgType || settings.data.type} onChange={(e) => setCfgType(e.target.value as "weekly" | "biweekly")}>
                <option value="weekly">{l("Hebdomadaire", "Weekly")}</option><option value="biweekly">{l("Aux deux semaines", "Biweekly")}</option></select></label>
            <label><span className="label">{l("Premier jour d'une période", "First day of a period")}</span><input className="input" type="date" value={cfgAnchor || settings.data.anchor} onChange={(e) => setCfgAnchor(e.target.value)} /></label>
            <button className="btn btn-primary" disabled={!cfgType && !cfgAnchor} onClick={() => void saveCfg()}>{l("Enregistrer", "Save")}</button>
          </div>
          <p className="mt-2 text-xs text-muted">{l("Les périodes sont comptées à partir de cette date, par blocs de 7 ou 14 jours. Toute modification est consignée.", "Periods are counted from this date, in blocks of 7 or 14 days. Every change is recorded.")}</p>
        </section>)}
    </>
  );
}

function PayRow({ e, period, open, toggle }: { e: Emp; period: Payroll["period"]; open: boolean; toggle: () => void }) {
  const l = useL();
  const loc = useLocale();
  const byDate = new Map(e.days.map((d) => [d.date, d]));
  const dates = Array.from({ length: period.days }, (_, i) => addDays(period.start, i));
  return (
    <>
      <tr>
        <td className="font-medium">{e.name}</td><td>{hm(e.trackedMinutes)}</td><td>{hm(e.billableMinutes)}</td><td>{hm(e.nonBillableMinutes)}</td><td>{hm(e.timerMinutes)}</td><td>{hm(e.paidMinutes)}</td>
        <td><div className="flex flex-wrap gap-1">{Object.entries(e.statuses).map(([k, v]) => <Chip key={k} tone={statusTone(k)}>{l(...(statusText[k] ?? [k, k]))} {v.count}</Chip>)}</div></td>
        <td className="text-right"><button className="btn !py-1 text-xs" onClick={toggle}>{open ? l("Fermer", "Close") : l("Détails", "Details")}</button></td>
      </tr>
      {open && (
        <tr><td colSpan={8}>
          <div className="grid gap-4 p-2 md:grid-cols-3">
            <div>
              <h3 className="mb-1 text-xs font-semibold text-muted">{l("Par jour", "By day")}</h3>
              {dates.map((d) => { const r = byDate.get(d); return (
                <div key={d} className="flex justify-between border-b border-white/5 py-1 text-sm"><span>{new Date(`${d}T12:00:00`).toLocaleDateString(loc, { weekday: "short", day: "numeric", month: "short" })}</span>
                  <span>{r ? <><b>{hm(r.trackedMinutes)}</b> <span className="text-xs text-muted">{hm(r.billableMinutes)} {l("fact.", "bill.")}{r.paidMinutes ? ` · ${hm(r.paidMinutes)} ${l("payées", "paid")}` : ""}</span></> : <span className="text-muted">—</span>}</span></div>); })}
            </div>
            <div>
              <h3 className="mb-1 text-xs font-semibold text-muted">{l("Par client", "By client")}</h3>
              {e.byClient.map((c) => <div key={c.clientId ?? "none"} className="flex justify-between border-b border-white/5 py-1 text-sm"><span>{c.name || "—"}</span><span><b>{hm(c.minutes)}</b> <span className="text-xs text-muted">{hm(c.billableMinutes)} {l("fact.", "bill.")}</span></span></div>)}
              {!e.byClient.length && <p className="text-sm text-muted">—</p>}
            </div>
            <div>
              <h3 className="mb-1 text-xs font-semibold text-muted">{l("Par tâche", "By task")}</h3>
              {e.byTask.map((k) => <div key={k.taskId} className="flex justify-between gap-2 border-b border-white/5 py-1 text-sm"><span className="min-w-0 truncate" title={k.title}>{k.title}{k.clientName ? ` · ${k.clientName}` : ""}</span><b>{hm(k.minutes)}</b></div>)}
              {!e.byTask.length && <p className="text-sm text-muted">—</p>}
            </div>
          </div>
          {e.weeks.length > 0 && <div className="flex flex-wrap gap-1 px-2 pb-2 text-xs text-muted">{l("Semaines", "Weeks")}: {e.weeks.map((w) => <Chip key={w.start} tone={statusTone(w.status)}>{fmtDate(w.start, loc)} · {l(...(statusText[w.status] ?? [w.status, w.status]))}</Chip>)}</div>}
        </td></tr>)}
    </>
  );
}
