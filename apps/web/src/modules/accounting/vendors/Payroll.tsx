import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { money, useL, useLocale } from "../../../lib/l";
import { errMsg, Stat } from "../../../components/kit";

interface Plan { weekday: number; total: number; rows: { userId: string; name: string; weeklyAmount: number }[] }

/** What is paid out each week and on which weekday: counted in the forecast. HR only. */
export function Payroll() {
  const l = useL();
  const loc = useLocale();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["vp-payroll"], queryFn: () => api<Plan>("/api/accounting/payroll") });
  const [weekday, setWeekday] = useState<number | null>(null);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const p = q.data;
  if (!p) return null;
  const wd = weekday ?? p.weekday;
  const val = (id: string, cur: number) => amounts[id] ?? String(cur);
  const total = p.rows.reduce((a, r) => a + (Number(val(r.userId, r.weeklyAmount)) || 0), 0);
  const days = Array.from({ length: 7 }, (_, i) => new Date(Date.UTC(2024, 0, 1 + i)).toLocaleDateString(loc, { weekday: "long", timeZone: "UTC" }));
  const save = async () => {
    setError(""); setMsg("");
    try {
      await api("/api/accounting/payroll", { method: "PUT", body: { weekday: wd, amounts: p.rows.map((r) => ({ userId: r.userId, weekly: Number(val(r.userId, r.weeklyAmount)) || 0 })) } });
      setAmounts({}); setWeekday(null); setMsg(l("Enregistré", "Saved"));
      await qc.invalidateQueries({ queryKey: ["vp-payroll"] }); await qc.invalidateQueries({ queryKey: ["vp-forecast"] }); await qc.invalidateQueries({ queryKey: ["bills-calendar"] });
    } catch (e) { setError(errMsg(e, "Error")); }
  };
  return (
    <section className="glass max-w-2xl p-5">
      <p className="mb-4 text-sm text-muted">{l("Un montant par semaine et par personne, versé le même jour de la semaine. Il entre dans la prévision de trésorerie et le calendrier. Ces données sont réservées aux RH.", "One amount per week and per person, paid on the same weekday. It goes into the cash forecast and the calendar. This data is for HR only.")}</p>
      <label className="mb-4 block max-w-xs"><span className="label">{l("Jour de paie", "Payday")}</span><select className="input capitalize" value={wd} onChange={(e) => setWeekday(Number(e.target.value))}>{days.map((d, i) => <option key={i} value={i}>{d}</option>)}</select></label>
      <table className="grid"><thead><tr><th>{l("Employé", "Employee")}</th><th>{l("Montant par semaine ($)", "Weekly amount ($)")}</th></tr></thead>
        <tbody>{p.rows.map((r) => <tr key={r.userId}><td className="font-medium">{r.name}</td><td><input className="input !w-40" type="number" min="0" step="0.01" value={val(r.userId, r.weeklyAmount)} onChange={(e) => setAmounts({ ...amounts, [r.userId]: e.target.value })} /></td></tr>)}</tbody></table>
      <div className="mt-4 grid grid-cols-2 gap-3"><Stat label={l("Total par semaine", "Total per week")} value={money(total, loc)} /><Stat label={l("Environ par mois", "About per month")} value={money((total * 52) / 12, loc)} /></div>
      {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
      <div className="mt-4 flex items-center gap-3"><button className="btn btn-primary" onClick={() => void save()}>{l("Enregistrer", "Save")}</button>{msg && <span role="status" className="text-sm text-muted">{msg}</span>}</div>
    </section>
  );
}
