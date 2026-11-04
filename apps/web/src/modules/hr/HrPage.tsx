import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { fmtDate, money, useL, useLocale } from "../../lib/l";
import { Chip, Empty, errMsg, FormDialog, Tabs, type FieldDef } from "../../components/kit";
import { PageHeader } from "../../components/ui";

interface Staff { id: string; name: string; email: string; active: boolean; jobTitle: string | null; hireDate: string | null; phone: string | null; emergencyContact: string | null; hourlyWage: number | null; vacationHours: number; sickDays: number; notes: string }
interface Absence { id: string; userId: string; userName: string; kind: string; startsOn: string; endsOn: string; note: string; createdBy: string | null }

export default function HrPage() {
  const l = useL();
  const loc = useLocale();
  const { can, me } = useAuth();
  const qc = useQueryClient();
  const [tab, setTab] = useState<"staff" | "absences">("staff");
  const [edit, setEdit] = useState<Staff | null>(null);
  const [absDlg, setAbsDlg] = useState(false);
  const manage = can("hr.manage");
  const staff = useQuery({ queryKey: ["hr-staff"], queryFn: () => api<Staff[]>("/api/hr/staff") });
  const abs = useQuery({ queryKey: ["hr-absences"], queryFn: () => api<Absence[]>("/api/hr/absences"), enabled: tab === "absences" });
  const refresh = async () => { await qc.invalidateQueries({ queryKey: ["hr-staff"] }); await qc.invalidateQueries({ queryKey: ["hr-absences"] }); await qc.invalidateQueries({ queryKey: ["meeting"] }); };
  const kinds = [{ value: "vacation", label: ["Vacances", "Vacation"] }, { value: "sick", label: ["Maladie", "Sick"] }, { value: "training", label: ["Formation", "Training"] }, { value: "personal", label: ["Personnel", "Personal"] }, { value: "other", label: ["Autre", "Other"] }] as { value: string; label: [string, string] }[];

  const staffFields: FieldDef[] = [
    { name: "jobTitle", label: ["Titre du poste", "Job title"] }, { name: "hireDate", label: ["Date d'embauche", "Hire date"], type: "date" },
    { name: "phone", label: ["Téléphone", "Phone"] }, { name: "emergencyContact", label: ["Contact d'urgence", "Emergency contact"] },
    { name: "hourlyWage", label: ["Salaire horaire", "Hourly wage"], type: "number", step: "0.01" }, { name: "vacationHours", label: ["Banque de vacances (heures)", "Vacation bank (hours)"], type: "number", step: "0.25" },
    { name: "sickDays", label: ["Jours de maladie", "Sick days"], type: "number", step: "0.5" }, { name: "notes", label: ["Notes", "Notes"], type: "textarea" },
  ];
  const absFields: FieldDef[] = [
    ...(manage ? [{ name: "userId", label: ["Employé", "Employee"] as [string, string], type: "user" as const }] : []),
    { name: "kind", label: ["Type", "Type"], type: "select", required: true, options: kinds }, { name: "startsOn", label: ["Du", "From"], type: "date", required: true }, { name: "endsOn", label: ["Au", "To"], type: "date", required: true }, { name: "note", label: ["Note", "Note"], type: "textarea", rows: 2 },
  ];

  return (
    <>
      <PageHeader title={l("Ressources humaines", "Human resources")} subtitle={l("Employés et absences", "Staff and absences")}
        actions={tab === "absences" && <button className="btn btn-primary" onClick={() => setAbsDlg(true)}><Plus size={16} />{l("Absence", "Absence")}</button>} />
      <Tabs tabs={[{ key: "staff", label: l("Employés", "Staff") }, { key: "absences", label: l("Absences", "Absences") }]} value={tab} onChange={setTab} />

      {tab === "staff" && (
        <div className="glass overflow-x-auto p-2">
          <table className="grid"><thead><tr><th>{l("Employé", "Employee")}</th><th>{l("Poste", "Title")}</th><th>{l("Embauche", "Hired")}</th><th>{l("Vacances (h)", "Vacation (h)")}</th><th>{l("Maladie (j)", "Sick (d)")}</th>{manage && <th>{l("Salaire", "Wage")}</th>}{manage && <th />}</tr></thead>
            <tbody>{staff.data?.map((s) => (
              <tr key={s.id} style={{ opacity: s.active ? 1 : 0.5 }}><td><div className="font-medium">{s.name}</div><div className="text-xs text-muted">{s.email}</div></td><td className="text-muted">{s.jobTitle || "—"}</td><td className="text-muted">{fmtDate(s.hireDate, loc)}</td><td>{s.vacationHours}</td><td>{s.sickDays}</td>
                {manage && <td>{s.hourlyWage != null ? `${money(s.hourlyWage, loc)}/h` : "—"}</td>}{manage && <td className="text-right"><button className="btn !p-1.5" onClick={() => setEdit(s)} aria-label="edit"><Pencil size={14} /></button></td>}</tr>))}</tbody></table>
          <p className="p-3 text-xs text-muted">{l("Les comptes utilisateurs se gèrent dans Administration › Utilisateurs.", "User accounts are managed in Administration › Users.")}</p>
        </div>
      )}

      {tab === "absences" && (
        <div className="glass overflow-x-auto p-2">
          {!abs.data?.length ? <Empty>{l("Aucune absence.", "No absences.")}</Empty> : (
            <table className="grid"><tbody>{abs.data.map((a) => (
              <tr key={a.id}><td className="font-medium">{a.userName}</td><td><Chip>{kinds.find((k) => k.value === a.kind)?.label[loc === "en-CA" ? 1 : 0] ?? a.kind}</Chip></td><td>{fmtDate(a.startsOn, loc)} → {fmtDate(a.endsOn, loc)}</td><td className="text-muted">{a.note}</td>
                <td className="text-right">{(manage || a.createdBy === me.user?.id) && <button className="btn btn-danger !p-1.5" aria-label="delete" onClick={() => { if (window.confirm(l("Supprimer cette absence ?", "Delete this absence?"))) void api(`/api/hr/absences/${a.id}`, { method: "DELETE" }).then(refresh).catch((e) => alert(errMsg(e, "Error"))); }}><Trash2 size={14} /></button>}</td></tr>))}</tbody></table>)}
        </div>
      )}

      {edit && <FormDialog title={`${l("Fiche RH", "HR file")}: ${edit.name}`} fields={staffFields} wide initial={{ ...edit, hourlyWage: edit.hourlyWage ?? "", hireDate: edit.hireDate ?? "" }}
        onSubmit={async (v) => { await api(`/api/hr/staff/${edit.id}`, { method: "PUT", body: { jobTitle: v.jobTitle ?? "", hireDate: v.hireDate || null, phone: v.phone ?? "", emergencyContact: v.emergencyContact ?? "", hourlyWage: v.hourlyWage === "" || v.hourlyWage == null ? null : Number(v.hourlyWage), vacationHours: Number(v.vacationHours) || 0, sickDays: Number(v.sickDays) || 0, notes: v.notes ?? "" } }); await refresh(); }} onClose={() => setEdit(null)} />}
      {absDlg && <FormDialog title={l("Nouvelle absence", "New absence")} fields={absFields} initial={{ kind: "vacation", userId: me.user?.id }}
        onSubmit={async (v) => { await api("/api/hr/absences", { body: { userId: v.userId || undefined, kind: v.kind, startsOn: v.startsOn, endsOn: v.endsOn, note: v.note ?? "" } }); await refresh(); }} onClose={() => setAbsDlg(false)} />}
    </>
  );
}
