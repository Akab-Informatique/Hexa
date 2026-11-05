import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronLeft, ChevronRight, FileText, Pencil, Plus, Send, Trash2, X } from "lucide-react";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { addDays, fmtDate, money, mondayOf, todayISO, useL, useLocale } from "../../lib/l";
import { Chip, confirmDo, Empty, errMsg, Stat, Tabs, useClients, type DirUser } from "../../components/kit";
import { Modal, PageHeader } from "../../components/ui";
import { workdayMinutes } from "@nexo/shared/workday";

interface TType { key: string; kind: string; labelFr: string; labelEn: string }
interface Entry { id: string; workDate: string; typeKey: string; kind: string; minutes: number; startTime: string | null; endTime: string | null; lunchMinutes: number; bankMinutes: number; clientId: string | null; clientName: string | null; description: string; billable: boolean; billableMinutes: number | null }
interface Totals { paidMinutes: number; workdayMinutes: number; bankedMinutes: number; clientMinutes: number; billableMinutes: number; byType: Record<string, number> }
interface Week { start: string; userId: string; mine: boolean; status: "draft" | "submitted" | "approved" | "rejected" | "paid"; rejectReason: string; locked: boolean; entries: Entry[]; totals: Totals }
interface Pending { userId: string; userName: string; weekStart: string; status: string; paidMinutes: number; workdayMinutes: number; clientMinutes: number; billableMinutes: number }

const tone = (s: string) => (s === "approved" || s === "paid" ? "ok" : s === "submitted" ? "warn" : s === "rejected" ? "danger" : "off") as "ok" | "warn" | "danger" | "off";
/** "1:30", "1.5" or "90m" -> minutes. */
export const parseHm = (s: string): number | null => {
  const t = s.trim().replace(",", ".");
  const m = /^(\d+):(\d{1,2})$/.exec(t);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t) * 60);
  return null;
};
const hm = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;

export default function TimesheetPage() {
  const l = useL();
  const loc = useLocale();
  const { can, me } = useAuth();
  const qc = useQueryClient();
  const approver = can("mytools.timesheet.approve", "mytools.timesheet.manage");
  const [tab, setTab] = useState<"week" | "approvals" | "report">("week");
  const [start, setStart] = useState(mondayOf(todayISO()));
  const [who, setWho] = useState<string>("");
  const [dlg, setDlg] = useState<null | { entry?: Entry; date?: string }>(null);
  const [openDays, setOpenDays] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [money_, setMoney] = useState(false);
  const people = useQuery({ queryKey: ["time-people"], queryFn: () => api<DirUser[]>("/api/time/people"), enabled: approver });
  const types = useQuery({ queryKey: ["time-types"], queryFn: () => api<TType[]>("/api/time/types") });
  const q = useQuery({ queryKey: ["time-week", start, who], queryFn: () => api<Week>(`/api/time/week?start=${start}${who ? `&userId=${who}` : ""}`) });
  const refresh = async () => { await qc.invalidateQueries({ queryKey: ["time-week"] }); await qc.invalidateQueries({ queryKey: ["time-approvals"] }); };
  const w = q.data;
  const label = (k: string) => { const t = types.data?.find((x) => x.key === k); return t ? l(t.labelFr, t.labelEn) : k; };
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const canEdit = w && (!w.locked);
  const run = async (fn: () => Promise<unknown>) => { setError(""); try { await fn(); await refresh(); } catch (e) { setError(errMsg(e, "Error")); } };
  const statusText: Record<string, [string, string]> = { draft: ["Brouillon", "Draft"], submitted: ["Envoyée", "Sent"], approved: ["Approuvée", "Approved"], rejected: ["Refusée", "Refused"], paid: ["Payée", "Paid"] };

  return (
    <>
      <PageHeader title={l("Feuille de temps", "Timesheet")} subtitle={l("Heures payées, banque d'heures et approbation", "Paid hours, hours bank and approval")}
        actions={tab === "week" && canEdit && <button className="btn btn-primary" onClick={() => setDlg({})}><Plus size={16} />{l("Ajouter une entrée", "Add an entry")}</button>} />
      {approver && <Tabs tabs={[{ key: "week", label: l("Semaine", "Week") }, { key: "approvals", label: l("À approuver", "To approve") }, { key: "report", label: l("Rapport", "Report") }]} value={tab} onChange={setTab} />}

      {tab === "week" && (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <button className="btn !p-2" onClick={() => setStart(addDays(start, -7))} aria-label="prev"><ChevronLeft size={16} /></button>
            <div className="glass-flat px-4 py-2 text-sm font-medium">{fmtDate(start, loc)} → {fmtDate(addDays(start, 6), loc)}</div>
            <button className="btn !p-2" onClick={() => setStart(addDays(start, 7))} aria-label="next"><ChevronRight size={16} /></button>
            <button className="btn" onClick={() => setStart(mondayOf(todayISO()))}>{l("Cette semaine", "This week")}</button>
            {approver && <select className="input !w-auto" value={who} onChange={(e) => setWho(e.target.value)} aria-label="person"><option value="">{l("Ma feuille", "My timesheet")}</option>{people.data?.filter((p) => p.id !== me.user?.id).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}
            {w && <Chip tone={tone(w.status)}>{l(...statusText[w.status]!)}</Chip>}
            <div className="flex-1" />
            {w && !w.mine && can("mytools.timesheet.approve", "mytools.timesheet.manage", "hr.manage") && <button className="btn" onClick={() => setMoney(true)}><FileText size={15} />{l("Copie comptabilité", "Accounting copy")}</button>}
            <button className="btn" onClick={() => setOpenDays(openDays.length ? [] : days)}>{openDays.length ? l("Tout réduire", "Collapse all") : l("Tout ouvrir", "Expand all")}</button>
            {w && canEdit && w.entries.length > 0 && w.status !== "paid" && w.status !== "approved" && w.status !== "submitted" && <button className="btn btn-primary" onClick={() => confirmDo(l("Envoyer cette semaine pour approbation ?", "Send this week for approval?"), () => void run(() => api("/api/time/week/submit", { body: { start, userId: w.userId } })))}><Send size={15} />{l("Envoyer la semaine", "Send the week")}</button>}
          </div>
          {error && <p role="alert" className="mb-3 text-sm text-danger">{codeText(error, l)}</p>}
          {w?.status === "rejected" && <div className="glass mb-4 p-4 text-sm" style={{ borderColor: "var(--danger)" }}><b className="text-danger">{l("Semaine refusée", "Week refused")}</b>{w.rejectReason && <>: {w.rejectReason}</>}<div className="mt-1 text-xs text-muted">{l("Corrigez les entrées puis renvoyez la semaine.", "Fix the entries, then send the week again.")}</div></div>}
          {w?.locked && w.status !== "draft" && <p className="mb-3 text-xs text-muted">{l("La semaine est envoyée : elle ne peut plus être modifiée.", "The week is sent: it can no longer be changed.")}</p>}

          {w && (
            <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label={l("Heures payées", "Paid hours")} value={hm(w.totals.paidMinutes)} />
              <Stat label={l("Journées de travail", "Work days")} value={hm(w.totals.workdayMinutes)} />
              <Stat label={l("Mises en banque", "Banked")} value={hm(w.totals.bankedMinutes)} />
              <div className="glass-flat p-3 text-xs"><div className="mb-1 text-muted">{l("Par type", "By type")}</div><div className="flex flex-wrap gap-1">{Object.entries(w.totals.byType).map(([k, v]) => <span key={k} className="chip">{label(k)} {hm(v)}</span>)}{!Object.keys(w.totals.byType).length && "—"}</div></div>
            </div>)}

          <div className="space-y-2">
            {days.map((d) => {
              const es = w?.entries.filter((e) => e.workDate === d) ?? [];
              const wd = es.find((e) => e.kind === "workday");
              const total = es.reduce((a, e) => a + (e.kind === "workday" || e.kind === "vacation" || e.kind === "sick" || e.kind === "holiday" || e.kind === "bankpay" ? e.minutes - (e.kind === "workday" ? e.bankMinutes : 0) : 0), 0);
              const open = openDays.includes(d);
              return (
                <section key={d} className="glass p-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="w-36 text-sm font-medium">{new Date(`${d}T12:00:00`).toLocaleDateString(loc, { weekday: "long", day: "numeric", month: "short" })}</div>
                    <div className="text-sm text-muted">{wd ? `${wd.startTime}–${wd.endTime}` : "—"}</div>
                    <div className="flex-1 text-sm"><b>{hm(total)}</b> <span className="text-muted">{l("payées", "paid")}</span></div>
                    <div className="text-xs text-muted">{es.length} {l("entrée(s)", "entry(ies)")}</div>
                    {es.length > 0 && <button className="btn !py-1 text-xs" onClick={() => setOpenDays(open ? openDays.filter((x) => x !== d) : [...openDays, d])}>{l("Détails", "Details")}</button>}
                    {canEdit && <button className="btn !p-1.5" onClick={() => setDlg({ date: d })} aria-label="add"><Plus size={14} /></button>}
                  </div>
                  {open && es.length > 0 && (
                    <table className="grid mt-2"><tbody>{es.map((e) => (
                      <tr key={e.id}><td><Chip>{label(e.typeKey)}</Chip></td>
                        <td className="text-muted">{e.clientName ?? ""}{e.description ? ` ${e.clientName ? "·" : ""} ${e.description}` : ""}{e.kind === "workday" && e.bankMinutes > 0 ? ` · ${l("banque", "bank")} ${hm(e.bankMinutes)}` : ""}</td>
                        <td className="text-right font-medium">{hm(e.minutes)}</td>
                        <td className="whitespace-nowrap text-right">{canEdit && <><button className="btn !p-1.5" onClick={() => setDlg({ entry: e })} aria-label="edit"><Pencil size={13} /></button> <button className="btn btn-danger !p-1.5" aria-label="delete" onClick={() => confirmDo(l("Supprimer cette entrée ?", "Delete this entry?"), () => void run(() => api(`/api/time/entries/${e.id}`, { method: "DELETE" })))}><Trash2 size={13} /></button></>}</td></tr>))}</tbody></table>)}
                </section>);
            })}
          </div>
        </>)}

      {tab === "approvals" && <Approvals label={label} onOpen={(uid, wk) => { setWho(uid); setStart(wk); setTab("week"); }} />}
      {tab === "report" && <Report people={people.data ?? []} label={label} />}
      {dlg && types.data && w && <EntryDialog types={types.data} week={w} date={dlg.date ?? dlg.entry?.workDate ?? (w.start <= todayISO() && todayISO() <= addDays(w.start, 6) ? todayISO() : w.start)} entry={dlg.entry} onDone={refresh} onClose={() => setDlg(null)} />}
      {money_ && w && <AccountingCopy userId={w.userId} start={start} label={label} onClose={() => setMoney(false)} />}
    </>
  );
}

/** Server error codes in plain words. */
export function codeText(code: string, l: (fr: string, en: string) => string): string {
  const m: Record<string, [string, string]> = {
    timesheet_locked: ["La semaine est envoyée : elle ne peut plus être modifiée.", "The week is sent: it can no longer be changed."],
    workday_exists: ["Il y a déjà une journée de travail ce jour-là.", "There is already a work day on that date."],
    hr_wage_missing: ["Le salaire horaire n'est pas inscrit au dossier RH.", "The hourly wage is not set in the HR file."],
    holiday_no_basis: ["Aucune semaine complète avant ce férié : pas de paie à calculer.", "No complete week before this holiday: no pay to work out."],
    week_empty: ["La semaine est vide.", "The week is empty."], bank_exceeds_day: ["Les heures en banque dépassent la journée.", "Banked hours exceed the day."],
    workday_times_required: ["Indiquez l'heure de début et de fin.", "Enter the start and end time."], workday_times_invalid: ["La fin doit être après le début.", "The end must be after the start."],
    travel_client_required: ["Un déplacement facturable demande un client.", "A billable trip needs a client."], minutes_required: ["Indiquez la durée.", "Enter the duration."],
    entry_invoiced: ["Cette entrée est déjà facturée.", "This entry is already invoiced."], own_time: ["Vous ne pouvez pas approuver votre propre temps.", "You cannot approve your own time."],
  };
  return m[code] ? l(...m[code]!) : code;
}

function EntryDialog({ types, week, date, entry, onDone, onClose }: { types: TType[]; week: Week; date: string; entry?: Entry; onDone: () => Promise<unknown>; onClose: () => void }) {
  const l = useL();
  const clients = useClients();
  const manual = types.filter((t) => t.kind !== "bankpay" || true);
  const [typeKey, setTypeKey] = useState(entry?.typeKey ?? manual.find((t) => t.kind === "workday")?.key ?? manual[0]!.key);
  const kind = types.find((t) => t.key === typeKey)?.kind ?? "other";
  const [workDate, setWorkDate] = useState(date);
  const [startT, setStartT] = useState(entry?.startTime ?? "08:00");
  const [endT, setEndT] = useState(entry?.endTime ?? "16:00");
  const [bank, setBank] = useState(entry?.bankMinutes ? hm(entry.bankMinutes) : "");
  const [dur, setDur] = useState(entry && !["workday", "holiday"].includes(entry.kind) ? hm(entry.minutes) : "");
  const [clientId, setClientId] = useState(entry?.clientId ?? "");
  const [desc, setDesc] = useState(entry?.description ?? "");
  const [billable, setBillable] = useState(entry?.billable ?? kind === "work");
  const [billed, setBilled] = useState(entry?.billableMinutes != null ? hm(entry.billableMinutes) : "");
  const [error, setError] = useState("");
  const wd = kind === "workday" ? workdayMinutes(startT, endT) : null;

  const save = async () => {
    setError("");
    const b: Record<string, unknown> = { workDate, typeKey, description: desc || undefined, userId: week.mine ? undefined : week.userId };
    if (kind === "workday") { b.start = startT; b.end = endT; b.bankMinutes = bank ? parseHm(bank) ?? 0 : 0; }
    else if (kind !== "holiday") { const m = parseHm(dur); if (!m) { setError(l("Indiquez la durée (ex. 1:30).", "Enter the duration (e.g. 1:30).")); return; } b.minutes = m; }
    if (kind === "work" || kind === "travel") { b.clientId = clientId || null; b.billable = billable; if (kind === "work" && billable && billed) b.billableMinutes = parseHm(billed); }
    try {
      if (entry) await api(`/api/time/entries/${entry.id}`, { method: "PATCH", body: b });
      else await api("/api/time/entries", { body: b });
      await onDone(); onClose();
    } catch (e) { setError(codeText(errMsg(e, "Error"), l)); }
  };

  return (
    <Modal title={entry ? l("Modifier l'entrée", "Edit entry") : l("Nouvelle entrée", "New entry")} onClose={onClose}>
      <div className="grid gap-x-4 sm:grid-cols-2">
        <label className="mb-4 block"><span className="label">{l("Type", "Type")}</span><select className="input" value={typeKey} disabled={Boolean(entry)} onChange={(e) => { setTypeKey(e.target.value); const k = types.find((t) => t.key === e.target.value)?.kind; setBillable(k === "work"); }}>{manual.map((t) => <option key={t.key} value={t.key}>{l(t.labelFr, t.labelEn)}</option>)}</select></label>
        <label className="mb-4 block"><span className="label">{l("Date", "Date")}</span><input className="input" type="date" value={workDate} min={week.start} max={addDays(week.start, 6)} onChange={(e) => setWorkDate(e.target.value)} /></label>
        {kind === "workday" && (<>
          <label className="mb-4 block"><span className="label">{l("Début", "Start")}</span><input className="input" type="time" value={startT} onChange={(e) => setStartT(e.target.value)} /></label>
          <label className="mb-4 block"><span className="label">{l("Fin", "End")}</span><input className="input" type="time" value={endT} onChange={(e) => setEndT(e.target.value)} /></label>
          <label className="mb-4 block"><span className="label">{l("Heures mises en banque (h:mm)", "Hours put in the bank (h:mm)")}</span><input className="input" placeholder="0:00" value={bank} onChange={(e) => setBank(e.target.value)} /></label>
          <div className="mb-4 text-sm"><span className="label">{l("Heures payées pour la journée", "Paid hours for the day")}</span><div className="py-2 font-medium">{wd ? hm(wd.paid - (bank ? parseHm(bank) ?? 0 : 0)) : "—"}{wd && wd.lunchTaken > 0 && <span className="ml-2 text-xs text-muted">({l("dîner de 30 min non payé déduit", "30 min unpaid lunch taken off")})</span>}</div></div>
        </>)}
        {kind === "holiday" && <p className="mb-4 text-sm text-muted sm:col-span-2">{l("Aucune durée à saisir : la paie du férié est calculée à partir des quatre semaines complètes précédentes.", "No duration to enter: holiday pay is worked out from the four complete weeks before.")}</p>}
        {kind !== "workday" && kind !== "holiday" && <label className="mb-4 block"><span className="label">{l("Durée (h:mm)", "Duration (h:mm)")}</span><input className="input" placeholder="1:30" value={dur} onChange={(e) => setDur(e.target.value)} /></label>}
        {(kind === "work" || kind === "travel") && <label className="mb-4 block"><span className="label">{l("Client", "Client")}</span><select className="input" value={clientId} onChange={(e) => setClientId(e.target.value)}><option value="">—</option>{clients.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>}
        {(kind === "work" || kind === "travel") && <label className="mb-4 flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" checked={billable} onChange={(e) => setBillable(e.target.checked)} />{l("Facturable", "Billable")}</label>}
        {kind === "work" && billable && <label className="mb-4 block"><span className="label">{l("Heures facturées (si différent)", "Billed hours (if different)")}</span><input className="input" placeholder={dur || "1:30"} value={billed} onChange={(e) => setBilled(e.target.value)} /></label>}
        {kind !== "holiday" && <label className="mb-4 block sm:col-span-2"><span className="label">{l("Description", "Description")}</span><input className="input" value={desc} onChange={(e) => setDesc(e.target.value)} /></label>}
      </div>
      {error && <p role="alert" className="mb-3 text-sm text-danger">{error}</p>}
      <div className="flex justify-end gap-2"><button className="btn" onClick={onClose}>{l("Annuler", "Cancel")}</button><button className="btn btn-primary" onClick={() => void save()}>{l("Enregistrer", "Save")}</button></div>
    </Modal>
  );
}

function Approvals({ label, onOpen }: { label: (k: string) => string; onOpen: (userId: string, start: string) => void }) {
  void label;
  const l = useL();
  const loc = useLocale();
  const qc = useQueryClient();
  const [status, setStatus] = useState<"submitted" | "approved">("submitted");
  const [error, setError] = useState("");
  const q = useQuery({ queryKey: ["time-approvals", status], queryFn: () => api<Pending[]>(`/api/time/approvals?status=${status}`) });
  const refresh = () => qc.invalidateQueries({ queryKey: ["time-approvals"] });
  const run = async (fn: () => Promise<unknown>) => { setError(""); try { await fn(); await refresh(); } catch (e) { setError(codeText(errMsg(e, "Error"), l)); } };
  return (
    <>
      <Tabs tabs={[{ key: "submitted", label: l("En attente", "Waiting") }, { key: "approved", label: l("Approuvées (à payer)", "Approved (to pay)") }]} value={status} onChange={setStatus} />
      {error && <p role="alert" className="mb-3 text-sm text-danger">{error}</p>}
      <div className="glass overflow-x-auto p-2">
        {!q.data?.length ? <Empty>{l("Rien à traiter.", "Nothing to handle.")}</Empty> : (
          <table className="grid"><thead><tr><th>{l("Employé", "Employee")}</th><th>{l("Semaine du", "Week of")}</th><th>{l("Heures payées", "Paid hours")}</th><th>{l("Journées", "Work days")}</th><th>{l("Client", "Client")}</th><th /></tr></thead>
            <tbody>{q.data.map((r) => (
              <tr key={r.userId + r.weekStart}><td className="font-medium">{r.userName}</td><td>{fmtDate(r.weekStart, loc)}</td><td>{hm(r.paidMinutes)}</td><td>{hm(r.workdayMinutes)}</td><td>{hm(r.clientMinutes)}</td>
                <td className="whitespace-nowrap text-right">
                  <button className="btn !py-1 text-xs" onClick={() => onOpen(r.userId, r.weekStart)}>{l("Voir", "View")}</button>{" "}
                  {status === "submitted" ? (<>
                    <button className="btn !p-1.5" title={l("Approuver", "Approve")} onClick={() => void run(() => api("/api/time/approvals/decision", { body: { userId: r.userId, start: r.weekStart, decision: "approve" } }))}><Check size={14} color="var(--ok)" /></button>{" "}
                    <button className="btn !p-1.5" title={l("Refuser", "Refuse")} onClick={() => { const reason = window.prompt(l("Raison du refus", "Reason for the refusal")); if (reason?.trim()) void run(() => api("/api/time/approvals/decision", { body: { userId: r.userId, start: r.weekStart, decision: "reject", reason } })); }}><X size={14} color="var(--danger)" /></button>
                  </>) : <button className="btn" onClick={() => void run(() => api("/api/time/approvals/paid", { body: { items: [{ userId: r.userId, start: r.weekStart }], paid: true } }))}>{l("Marquer payée", "Mark paid")}</button>}
                </td></tr>))}</tbody></table>)}
      </div>
    </>
  );
}

function Report({ people, label }: { people: DirUser[]; label: (k: string) => string }) {
  const l = useL();
  const { me } = useAuth();
  const [from, setFrom] = useState(addDays(mondayOf(todayISO()), -28));
  const [to, setTo] = useState(todayISO());
  const [who, setWho] = useState("");
  const q = useQuery({ queryKey: ["time-report", from, to, who], queryFn: () => api<Totals & { productivityPct: number | null; byClient: { name: string; minutes: number; billableMinutes: number }[] }>(`/api/time/report?from=${from}&to=${to}${who ? `&userId=${who}` : ""}`) });
  const r = q.data;
  return (
    <>
      <div className="mb-4 flex flex-wrap items-end gap-2">
        <label><span className="label">{l("Du", "From")}</span><input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label><span className="label">{l("Au", "To")}</span><input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <select className="input !w-auto" value={who} onChange={(e) => setWho(e.target.value)}><option value="">{me.user?.name}</option>{people.filter((p) => p.id !== me.user?.id).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
      </div>
      {r && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5">
            <Stat label={l("Heures payées", "Paid hours")} value={hm(r.paidMinutes)} /><Stat label={l("Journées de travail", "Work days")} value={hm(r.workdayMinutes)} />
            <Stat label={l("Temps client", "Client time")} value={hm(r.clientMinutes)} /><Stat label={l("Facturable", "Billable")} value={hm(r.billableMinutes)} />
            <Stat label={l("Productivité", "Productivity")} value={r.productivityPct == null ? "—" : `${r.productivityPct} %`} />
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <section className="glass p-4"><h2 className="mb-2 text-sm font-semibold">{l("Par type", "By type")}</h2>{Object.entries(r.byType).map(([k, v]) => <div key={k} className="flex justify-between border-b border-white/5 py-1.5 text-sm"><span>{label(k)}</span><b>{hm(v)}</b></div>)}{!Object.keys(r.byType).length && <Empty>—</Empty>}</section>
            <section className="glass p-4"><h2 className="mb-2 text-sm font-semibold">{l("Par client", "By client")}</h2>{r.byClient.map((c) => <div key={c.name} className="flex justify-between border-b border-white/5 py-1.5 text-sm"><span>{c.name}</span><span><b>{hm(c.minutes)}</b> <span className="text-muted">/ {hm(c.billableMinutes)} {l("fact.", "billable")}</span></span></div>)}{!r.byClient.length && <Empty>—</Empty>}</section>
          </div>
        </>)}
    </>
  );
}

interface Acc { wageCents: number | null; paidMinutes: number; grossCents: number | null; accrualCents: number; balances: { bankCents: number; vacationCents: number; sickHundredths: number }; totals: Totals; entries: Entry[] }
function AccountingCopy({ userId, start, label, onClose }: { userId: string; start: string; label: (k: string) => string; onClose: () => void }) {
  const l = useL();
  const loc = useLocale();
  const q = useQuery({ queryKey: ["time-acc", userId, start], queryFn: () => api<Acc>(`/api/time/week/accounting?userId=${userId}&start=${start}`) });
  const a = q.data;
  const wage = a?.wageCents ?? 0;
  return (
    <Modal title={`${l("Copie pour la comptabilité", "Accounting copy")} · ${fmtDate(start, loc)}`} onClose={onClose} wide>
      {!a ? null : (
        <div id="acc-print" className="text-sm">
          <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label={l("Heures payées", "Paid hours")} value={hm(a.paidMinutes)} /><Stat label={l("Taux horaire", "Hourly rate")} value={a.wageCents ? money(a.wageCents / 100, loc) : "—"} />
            <Stat label={l("Paie brute", "Gross pay")} value={a.grossCents != null ? money(a.grossCents / 100, loc) : "—"} /><Stat label={l("4 % vacances", "4 % vacation")} value={money(a.accrualCents / 100, loc)} />
          </div>
          <table className="grid"><thead><tr><th>{l("Date", "Date")}</th><th>{l("Type", "Type")}</th><th>{l("Détail", "Detail")}</th><th>{l("Heures", "Hours")}</th><th>{l("Montant", "Amount")}</th></tr></thead>
            <tbody>{a.entries.map((e) => {
              const paid = ["workday", "vacation", "sick", "holiday", "bankpay"].includes(e.kind) ? e.minutes - (e.kind === "workday" ? e.bankMinutes : 0) : 0;
              return <tr key={e.id}><td>{fmtDate(e.workDate, loc)}</td><td>{label(e.typeKey)}</td><td className="text-muted">{e.clientName ?? e.description}{e.bankMinutes ? ` · ${l("banque", "bank")} ${hm(e.bankMinutes)}` : ""}</td><td>{hm(e.minutes)}</td><td>{paid && wage ? money((paid / 60) * wage / 100, loc) : ""}</td></tr>;
            })}</tbody></table>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <Stat label={l("Banque d'heures ($)", "Hours bank ($)")} value={money(a.balances.bankCents / 100, loc)} tone={a.balances.bankCents < 0 ? "danger" : undefined} />
            <Stat label={l("Banque de vacances ($)", "Vacation bank ($)")} value={money(a.balances.vacationCents / 100, loc)} tone={a.balances.vacationCents < 0 ? "danger" : undefined} />
            <Stat label={l("Jours de maladie (h)", "Sick time (h)")} value={`${(a.balances.sickHundredths / 100).toFixed(2)} h`} tone={a.balances.sickHundredths < 0 ? "danger" : undefined} />
          </div>
          <div className="mt-4 flex justify-end gap-2"><button className="btn" onClick={() => window.print()}>{l("Imprimer", "Print")}</button><button className="btn" onClick={onClose}>{l("Fermer", "Close")}</button></div>
        </div>)}
    </Modal>
  );
}

