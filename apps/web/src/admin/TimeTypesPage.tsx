import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import { useL } from "../lib/l";
import { Chip, errMsg, Tabs } from "../components/kit";
import { PageHeader } from "../components/ui";

interface TT { key: string; kind: string; labelFr: string; labelEn: string; active: boolean; builtIn: boolean }
interface ET { key: string; labelFr: string; labelEn: string; unit: "none" | "km"; rateCents: number; billable: boolean; active: boolean }

const KIND: Record<string, [string, string]> = { work: ["Travail client", "Client work"], workday: ["Journée de travail", "Work day"], bankpay: ["Paiement de banque", "Bank payout"], other: ["Dans la journée", "Inside the day"], travel: ["Déplacement", "Travel"], vacation: ["Vacances", "Vacation"], sick: ["Maladie", "Sick"], holiday: ["Férié", "Holiday"] };

/** Administration of the time types and expense types (labels and on/off; the rules of a type are fixed by its kind). */
export default function TimeTypesPage() {
  const l = useL();
  const [tab, setTab] = useState<"time" | "exp">("time");
  return (
    <>
      <PageHeader title={l("Temps et dépenses", "Time and expenses")} subtitle={l("Types offerts dans la feuille de temps et les rapports de dépenses", "Types offered in the timesheet and the expense reports")} />
      <Tabs tabs={[{ key: "time", label: l("Types de temps", "Time types") }, { key: "exp", label: l("Types de dépenses", "Expense types") }]} value={tab} onChange={setTab} />
      {tab === "time" ? <TimeTypes /> : <ExpenseTypes />}
    </>
  );
}

function TimeTypes() {
  const l = useL();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin-time-types"], queryFn: () => api<TT[]>("/api/admin/time/time-types") });
  const [fr, setFr] = useState(""), [en, setEn] = useState(""), [error, setError] = useState("");
  const refresh = async () => { await qc.invalidateQueries({ queryKey: ["admin-time-types"] }); await qc.invalidateQueries({ queryKey: ["time-types"] }); };
  const run = async (fn: () => Promise<unknown>) => { setError(""); try { await fn(); await refresh(); } catch (e) { const c = errMsg(e, "Error"); setError(c === "type_required" ? l("Ce type fixe une règle : on ne peut pas le retirer.", "This type carries a rule: it cannot be removed.") : c === "type_in_use" ? l("Ce type est utilisé.", "This type is in use.") : c); } };
  return (
    <div className="glass overflow-x-auto p-2">
      <table className="grid"><thead><tr><th>{l("Français", "French")}</th><th>{l("Anglais", "English")}</th><th>{l("Règle", "Rule")}</th><th>{l("Actif", "Active")}</th><th /></tr></thead>
        <tbody>{q.data?.map((t) => (
          <tr key={t.key} style={{ opacity: t.active ? 1 : 0.5 }}>
            <td><input className="input" defaultValue={t.labelFr} onBlur={(e) => e.target.value !== t.labelFr && e.target.value.trim() && void run(() => api(`/api/admin/time/time-types/${t.key}`, { method: "PATCH", body: { labelFr: e.target.value } }))} /></td>
            <td><input className="input" defaultValue={t.labelEn} onBlur={(e) => e.target.value !== t.labelEn && e.target.value.trim() && void run(() => api(`/api/admin/time/time-types/${t.key}`, { method: "PATCH", body: { labelEn: e.target.value } }))} /></td>
            <td><Chip>{l(...KIND[t.kind]!)}</Chip></td>
            <td><input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" checked={t.active} onChange={(e) => void run(() => api(`/api/admin/time/time-types/${t.key}`, { method: "PATCH", body: { active: e.target.checked } }))} /></td>
            <td className="text-right">{!t.builtIn && <button className="btn btn-danger !p-1.5" aria-label="delete" onClick={() => void run(() => api(`/api/admin/time/time-types/${t.key}`, { method: "DELETE" }))}><Trash2 size={14} /></button>}</td></tr>))}</tbody></table>
      <div className="flex flex-wrap items-end gap-2 p-3">
        <label className="min-w-[160px] flex-1"><span className="label">{l("Nouveau type (français)", "New type (French)")}</span><input className="input" value={fr} onChange={(e) => setFr(e.target.value)} /></label>
        <label className="min-w-[160px] flex-1"><span className="label">{l("Anglais", "English")}</span><input className="input" value={en} onChange={(e) => setEn(e.target.value)} /></label>
        <button className="btn btn-primary" disabled={!fr.trim() || !en.trim()} onClick={() => void run(async () => { await api("/api/admin/time/time-types", { body: { key: fr.toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "type", labelFr: fr, labelEn: en } }); setFr(""); setEn(""); })}><Plus size={15} />{l("Ajouter", "Add")}</button>
      </div>
      <p className="px-3 pb-3 text-xs text-muted">{l("Un nouveau type est du temps « dans la journée de travail » : il n'ajoute pas de paie. Les types à règle (journée, vacances, maladie, férié, banque, déplacement, travail client) sont fixes.", "A new type is time \"inside the work day\": it adds no pay. Types with a rule (work day, vacation, sick, holiday, bank, travel, client work) are fixed.")}</p>
      {error && <p role="alert" className="px-3 pb-3 text-sm text-danger">{error}</p>}
    </div>
  );
}

function ExpenseTypes() {
  const l = useL();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin-exp-types"], queryFn: () => api<ET[]>("/api/admin/time/expense-types") });
  const [nf, setNf] = useState({ fr: "", en: "", unit: "none" as "none" | "km", rate: "" });
  const [error, setError] = useState("");
  const refresh = async () => { await qc.invalidateQueries({ queryKey: ["admin-exp-types"] }); await qc.invalidateQueries({ queryKey: ["exp-types"] }); };
  const run = async (fn: () => Promise<unknown>) => { setError(""); try { await fn(); await refresh(); } catch (e) { const c = errMsg(e, "Error"); setError(c === "type_in_use" ? l("Ce type a des dépenses : on peut le désactiver mais pas le supprimer.", "This type has expenses: you can turn it off but not delete it.") : c); } };
  const patch = (k: string, body: object) => run(() => api(`/api/admin/time/expense-types/${k}`, { method: "PATCH", body }));
  return (
    <div className="glass overflow-x-auto p-2">
      <table className="grid"><thead><tr><th>{l("Français", "French")}</th><th>{l("Anglais", "English")}</th><th>{l("Unité", "Unit")}</th><th>{l("Taux $/km", "Rate $/km")}</th><th>{l("Facturable par défaut", "Billable by default")}</th><th>{l("Actif", "Active")}</th><th /></tr></thead>
        <tbody>{q.data?.map((t) => (
          <tr key={t.key} style={{ opacity: t.active ? 1 : 0.5 }}>
            <td><input className="input" defaultValue={t.labelFr} onBlur={(e) => e.target.value !== t.labelFr && e.target.value.trim() && void patch(t.key, { labelFr: e.target.value })} /></td>
            <td><input className="input" defaultValue={t.labelEn} onBlur={(e) => e.target.value !== t.labelEn && e.target.value.trim() && void patch(t.key, { labelEn: e.target.value })} /></td>
            <td><Chip>{t.unit === "km" ? l("Kilomètres", "Kilometres") : l("Montant", "Amount")}</Chip></td>
            <td>{t.unit === "km" ? <input className="input !w-24" type="number" step="0.01" defaultValue={t.rateCents / 100} onBlur={(e) => Number(e.target.value) * 100 !== t.rateCents && void patch(t.key, { rate: Number(e.target.value) })} /> : "—"}</td>
            <td><input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" checked={t.billable} onChange={(e) => void patch(t.key, { billable: e.target.checked })} /></td>
            <td><input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" checked={t.active} onChange={(e) => void patch(t.key, { active: e.target.checked })} /></td>
            <td className="text-right"><button className="btn btn-danger !p-1.5" aria-label="delete" onClick={() => void run(() => api(`/api/admin/time/expense-types/${t.key}`, { method: "DELETE" }))}><Trash2 size={14} /></button></td></tr>))}</tbody></table>
      <div className="flex flex-wrap items-end gap-2 p-3">
        <label className="min-w-[140px] flex-1"><span className="label">{l("Nouveau (français)", "New (French)")}</span><input className="input" value={nf.fr} onChange={(e) => setNf({ ...nf, fr: e.target.value })} /></label>
        <label className="min-w-[140px] flex-1"><span className="label">{l("Anglais", "English")}</span><input className="input" value={nf.en} onChange={(e) => setNf({ ...nf, en: e.target.value })} /></label>
        <label><span className="label">{l("Unité", "Unit")}</span><select className="input" value={nf.unit} onChange={(e) => setNf({ ...nf, unit: e.target.value as "none" | "km" })}><option value="none">{l("Montant", "Amount")}</option><option value="km">{l("Kilomètres", "Kilometres")}</option></select></label>
        {nf.unit === "km" && <label><span className="label">$/km</span><input className="input !w-24" type="number" step="0.01" value={nf.rate} onChange={(e) => setNf({ ...nf, rate: e.target.value })} /></label>}
        <button className="btn btn-primary" disabled={!nf.fr.trim() || !nf.en.trim()} onClick={() => void run(async () => { await api("/api/admin/time/expense-types", { body: { key: nf.fr.toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "type", labelFr: nf.fr, labelEn: nf.en, unit: nf.unit, rate: Number(nf.rate) || 0 } }); setNf({ fr: "", en: "", unit: "none", rate: "" }); })}><Plus size={15} />{l("Ajouter", "Add")}</button>
      </div>
      <p className="px-3 pb-3 text-xs text-muted">{l("Le taux au kilomètre sert à la comptabilité : l'employé ne voit que les kilomètres.", "The per-km rate is for accounting: the employee only sees the kilometres.")}</p>
      {error && <p role="alert" className="px-3 pb-3 text-sm text-danger">{error}</p>}
    </div>
  );
}
