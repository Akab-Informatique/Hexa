import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderOpen, Plus, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { fmtDate, money, useL, useLocale } from "../../lib/l";
import { Chip, Empty, errMsg, FormDialog, Stat, Tabs, type FieldDef } from "../../components/kit";
import { Modal, PageHeader } from "../../components/ui";

interface Staff { id: string; name: string; email: string; active: boolean; jobTitle: string | null; hireDate: string | null; phone: string | null; emergencyContact: string | null; hourlyWage: number | null; overtimeHours: number | null; notes: string; bankCents?: number; vacationCents?: number; sickHundredths?: number }
interface Absence { id: string; userId: string; userName: string; kind: string; startsOn: string; endsOn: string; note: string; createdBy: string | null }
interface LedgerRow { id: string; account: "bank" | "vacation" | "sick"; delta: number; kind: string; reason: string; weekStart: string | null; createdAt: string; byName: string | null }
interface Ledger { balances: { bankCents: number; vacationCents: number; sickHundredths: number }; rows: LedgerRow[] }

const hrs = (h100: number) => `${(h100 / 100).toFixed(2)} h`;

export default function HrPage() {
  const l = useL();
  const loc = useLocale();
  const { can, me } = useAuth();
  const qc = useQueryClient();
  const [tab, setTab] = useState<"staff" | "absences">("staff");
  const [file, setFile] = useState<Staff | null>(null);
  const [absDlg, setAbsDlg] = useState(false);
  const manage = can("hr.manage");
  const staff = useQuery({ queryKey: ["hr-staff"], queryFn: () => api<Staff[]>("/api/hr/staff") });
  const abs = useQuery({ queryKey: ["hr-absences"], queryFn: () => api<Absence[]>("/api/hr/absences"), enabled: tab === "absences" });
  const refresh = async () => { await qc.invalidateQueries({ queryKey: ["hr-staff"] }); await qc.invalidateQueries({ queryKey: ["hr-absences"] }); await qc.invalidateQueries({ queryKey: ["meeting"] }); await qc.invalidateQueries({ queryKey: ["hr-ledger"] }); };
  const kinds = [{ value: "vacation", label: ["Vacances", "Vacation"] }, { value: "sick", label: ["Maladie", "Sick"] }, { value: "training", label: ["Formation", "Training"] }, { value: "personal", label: ["Personnel", "Personal"] }, { value: "other", label: ["Autre", "Other"] }] as { value: string; label: [string, string] }[];
  const absFields: FieldDef[] = [
    ...(manage ? [{ name: "userId", label: ["Employé", "Employee"] as [string, string], type: "user" as const }] : []),
    { name: "kind", label: ["Type", "Type"], type: "select", required: true, options: kinds }, { name: "startsOn", label: ["Du", "From"], type: "date", required: true }, { name: "endsOn", label: ["Au", "To"], type: "date", required: true }, { name: "note", label: ["Note", "Note"], type: "textarea", rows: 2 },
  ];
  const neg = (n?: number) => (n != null && n < 0 ? "var(--danger)" : undefined);

  return (
    <>
      <PageHeader title={l("Ressources humaines", "Human resources")} subtitle={l("Employés, banques d'heures et de vacances, absences", "Staff, hours and vacation banks, absences")}
        actions={tab === "absences" && <button className="btn btn-primary" onClick={() => setAbsDlg(true)}><Plus size={16} />{l("Absence", "Absence")}</button>} />
      <Tabs tabs={[{ key: "staff", label: l("Employés", "Staff") }, { key: "absences", label: l("Absences", "Absences") }]} value={tab} onChange={setTab} />

      {tab === "staff" && (
        <div className="glass overflow-x-auto p-2">
          <table className="grid"><thead><tr><th>{l("Employé", "Employee")}</th><th>{l("Poste", "Title")}</th><th>{l("Embauche", "Hired")}</th>{manage && <><th>{l("Salaire", "Wage")}</th><th>{l("Banque d'heures", "Hours bank")}</th><th>{l("Vacances", "Vacation")}</th><th>{l("Maladie", "Sick")}</th><th /></>}</tr></thead>
            <tbody>{staff.data?.map((s) => (
              <tr key={s.id} style={{ opacity: s.active ? 1 : 0.5 }}><td><div className="font-medium">{s.name}</div><div className="text-xs text-muted">{s.email}</div></td><td className="text-muted">{s.jobTitle || "—"}</td><td className="text-muted">{fmtDate(s.hireDate, loc)}</td>
                {manage && <>
                  <td>{s.hourlyWage != null ? `${money(s.hourlyWage, loc)}/h` : <Chip tone="warn">{l("à inscrire", "to set")}</Chip>}</td>
                  <td style={{ color: neg(s.bankCents) }}>{money((s.bankCents ?? 0) / 100, loc)}</td><td style={{ color: neg(s.vacationCents) }}>{money((s.vacationCents ?? 0) / 100, loc)}</td><td style={{ color: neg(s.sickHundredths) }}>{hrs(s.sickHundredths ?? 0)}</td>
                  <td className="text-right"><button className="btn !py-1 text-xs" onClick={() => setFile(s)}><FolderOpen size={14} />{l("Dossier RH", "HR file")}</button></td></>}</tr>))}</tbody></table>
          <p className="p-3 text-xs text-muted">{l("Les comptes utilisateurs se gèrent dans Administration › Utilisateurs. Les banques suivent la feuille de temps; un employé ne voit jamais ces données.", "User accounts are managed in Administration › Users. The banks follow the timesheets; an employee never sees this data.")}</p>
        </div>
      )}

      {tab === "absences" && (
        <div className="glass overflow-x-auto p-2">
          {!abs.data?.length ? <Empty>{l("Aucune absence.", "No absences.")}</Empty> : (
            <table className="grid"><tbody>{abs.data.map((a) => (
              <tr key={a.id}><td className="font-medium">{a.userName}</td><td><Chip>{kinds.find((k) => k.value === a.kind)?.label[loc === "en-CA" ? 1 : 0] ?? a.kind}</Chip></td><td>{fmtDate(a.startsOn, loc)} → {fmtDate(a.endsOn, loc)}</td><td className="text-muted">{a.note}</td>
                <td className="text-right">{(manage || a.createdBy === me.user?.id) && <button className="btn btn-danger !p-1.5" aria-label="delete" onClick={() => { if (window.confirm(l("Supprimer cette absence ?", "Delete this absence?"))) void api(`/api/hr/absences/${a.id}`, { method: "DELETE" }).then(refresh).catch((e) => alert(errMsg(e, "Error"))); }}><Trash2 size={14} /></button>}</td></tr>))}</tbody></table>)}
          <p className="p-3 text-xs text-muted">{l("Pour les heures payées, saisissez des entrées Vacances ou Maladie dans la feuille de temps : elles déplacent les banques.", "For paid hours, enter Vacation or Sick entries in the timesheet: they move the banks.")}</p>
        </div>
      )}

      {file && <HrFile staff={file} onClose={() => setFile(null)} onChanged={refresh} />}
      {absDlg && <FormDialog title={l("Nouvelle absence", "New absence")} fields={absFields} initial={{ kind: "vacation", userId: me.user?.id }}
        onSubmit={async (v) => { await api("/api/hr/absences", { body: { userId: v.userId || undefined, kind: v.kind, startsOn: v.startsOn, endsOn: v.endsOn, note: v.note ?? "" } }); await refresh(); }} onClose={() => setAbsDlg(false)} />}
    </>
  );
}

/** The HR file of one employee: profile, the three banks with their history, and confirmed hand adjustments. */
function HrFile({ staff, onClose, onChanged }: { staff: Staff; onClose: () => void; onChanged: () => Promise<unknown> }) {
  const l = useL();
  const loc = useLocale();
  const qc = useQueryClient();
  const [tab, setTab] = useState<"profile" | "banks">("profile");
  const ledger = useQuery({ queryKey: ["hr-ledger", staff.id], queryFn: () => api<Ledger>(`/api/hr/staff/${staff.id}/ledger`), enabled: tab === "banks" });
  const [account, setAccount] = useState<"bank" | "vacation" | "sick">("bank");
  const [mode, setMode] = useState<"hours" | "amount">("hours");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const [p, setP] = useState({ jobTitle: staff.jobTitle ?? "", hireDate: staff.hireDate ?? "", phone: staff.phone ?? "", emergencyContact: staff.emergencyContact ?? "", hourlyWage: staff.hourlyWage != null ? String(staff.hourlyWage) : "", overtimeHours: String(staff.overtimeHours ?? 40), notes: staff.notes ?? "" });
  const names = { bank: l("Banque d'heures ($)", "Hours bank ($)"), vacation: l("Banque de vacances ($)", "Vacation bank ($)"), sick: l("Maladie (heures)", "Sick time (hours)") };
  const fmtDelta = (r: LedgerRow) => (r.account === "sick" ? `${r.delta > 0 ? "+" : ""}${hrs(r.delta)}` : `${r.delta > 0 ? "+" : ""}${money(r.delta / 100, loc)}`);
  const b = ledger.data?.balances;

  const saveProfile = async () => {
    setError(""); setMsg("");
    try {
      await api(`/api/hr/staff/${staff.id}`, { method: "PUT", body: { jobTitle: p.jobTitle, hireDate: p.hireDate || null, phone: p.phone, emergencyContact: p.emergencyContact, hourlyWage: p.hourlyWage === "" ? null : Number(p.hourlyWage), overtimeHours: Number(p.overtimeHours) || 40, notes: p.notes } });
      await onChanged(); setMsg(l("Enregistré", "Saved"));
    } catch (e) { setError(errMsg(e, "Error")); }
  };
  const adjust = async () => {
    setError(""); setMsg("");
    try {
      const n = Number(value);
      const r = await api<{ negative: boolean }>(`/api/hr/staff/${staff.id}/adjust`, { body: { account, ...(mode === "hours" || account === "sick" ? { hours: n } : { amount: n }), reason, confirm: true } });
      setValue(""); setReason(""); setConfirm(false);
      setMsg(r.negative ? l("Enregistré : le solde est maintenant négatif.", "Saved: the balance is now negative.") : l("Ajustement enregistré.", "Adjustment saved."));
      await qc.invalidateQueries({ queryKey: ["hr-ledger", staff.id] }); await onChanged();
    } catch (e) { const c = errMsg(e, "Error"); setError(c === "hr_wage_missing" ? l("Inscrivez d'abord le salaire horaire.", "Set the hourly wage first.") : c); }
  };

  return (
    <Modal title={`${l("Dossier RH", "HR file")} · ${staff.name}`} onClose={onClose} wide>
      <Tabs tabs={[{ key: "profile", label: l("Fiche", "Profile") }, { key: "banks", label: l("Banques et historique", "Banks and history") }]} value={tab} onChange={setTab} />
      {tab === "profile" && (
        <>
          <div className="grid gap-x-4 sm:grid-cols-2">
            {([["jobTitle", "Titre du poste", "Job title", "text"], ["hireDate", "Date d'embauche", "Hire date", "date"], ["phone", "Téléphone", "Phone", "text"], ["emergencyContact", "Contact d'urgence", "Emergency contact", "text"], ["hourlyWage", "Salaire horaire ($)", "Hourly wage ($)", "number"], ["overtimeHours", "Seuil de temps supplémentaire (h/sem.)", "Overtime threshold (h/week)", "number"]] as const).map(([k, fr, en, type]) => (
              <label key={k} className="mb-4 block"><span className="label">{l(fr, en)}</span><input className="input" type={type} step={type === "number" ? "0.01" : undefined} value={p[k]} onChange={(e) => setP({ ...p, [k]: e.target.value })} /></label>))}
            <label className="mb-4 block sm:col-span-2"><span className="label">{l("Notes", "Notes")}</span><textarea className="input" rows={3} value={p.notes} onChange={(e) => setP({ ...p, notes: e.target.value })} /></label>
          </div>
          <div className="flex items-center justify-end gap-3">{msg && <span role="status" className="text-sm text-muted">{msg}</span>}<button className="btn btn-primary" onClick={() => void saveProfile()}>{l("Enregistrer", "Save")}</button></div>
        </>)}
      {tab === "banks" && (
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-3">
            <Stat label={names.bank} value={money((b?.bankCents ?? 0) / 100, loc)} tone={(b?.bankCents ?? 0) < 0 ? "danger" : undefined} />
            <Stat label={names.vacation} value={money((b?.vacationCents ?? 0) / 100, loc)} tone={(b?.vacationCents ?? 0) < 0 ? "danger" : undefined} />
            <Stat label={names.sick} value={hrs(b?.sickHundredths ?? 0)} tone={(b?.sickHundredths ?? 0) < 0 ? "danger" : undefined} />
          </div>
          <div className="glass-flat mb-4 p-3">
            <div className="mb-2 text-sm font-medium">{l("Ajustement à la main", "Adjust by hand")}</div>
            <div className="flex flex-wrap items-end gap-2">
              <label><span className="label">{l("Compte", "Account")}</span><select className="input" value={account} onChange={(e) => setAccount(e.target.value as typeof account)}><option value="bank">{names.bank}</option><option value="vacation">{names.vacation}</option><option value="sick">{names.sick}</option></select></label>
              {account !== "sick" && <label><span className="label">{l("En", "In")}</span><select className="input" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}><option value="hours">{l("heures", "hours")}</option><option value="amount">{l("dollars", "dollars")}</option></select></label>}
              <label><span className="label">{l("Quantité (+ ou −)", "Amount (+ or −)")}</span><input className="input !w-32" type="number" step="0.01" value={value} onChange={(e) => setValue(e.target.value)} /></label>
              <label className="min-w-[180px] flex-1"><span className="label">{l("Raison", "Reason")}</span><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></label>
            </div>
            <label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />{l("Je confirme cet ajustement (il est inscrit au journal).", "I confirm this adjustment (it is logged).")}</label>
            <div className="mt-3 flex items-center gap-3"><button className="btn btn-primary" disabled={!confirm || !value || !reason.trim()} onClick={() => void adjust()}>{l("Appliquer", "Apply")}</button>{msg && <span role="status" className="text-sm text-muted">{msg}</span>}</div>
          </div>
          {error && <p role="alert" className="mb-3 text-sm text-danger">{error}</p>}
          <div className="max-h-72 overflow-auto"><table className="grid"><thead><tr><th>{l("Date", "Date")}</th><th>{l("Compte", "Account")}</th><th>{l("Mouvement", "Move")}</th><th>{l("Détail", "Detail")}</th></tr></thead>
            <tbody>{ledger.data?.rows.map((r) => (
              <tr key={r.id}><td className="whitespace-nowrap text-muted">{fmtDate(r.createdAt, loc)}</td><td>{names[r.account]}</td><td style={{ color: r.delta < 0 ? "var(--danger)" : "var(--ok)" }}>{fmtDelta(r)}</td>
                <td className="text-muted">{r.kind === "accrual" ? l("4 % des vacances de la semaine", "4 % vacation of the week") : r.reason}{r.byName ? ` · ${r.byName}` : ""}</td></tr>))}</tbody></table>
            {ledger.data && !ledger.data.rows.length && <Empty>{l("Aucun mouvement.", "No moves.")}</Empty>}</div>
        </>)}
      {error && tab === "profile" && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
    </Modal>
  );
}
