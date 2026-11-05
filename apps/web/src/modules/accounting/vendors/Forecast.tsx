import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { api } from "../../../lib/api";
import { fmtDate, money, useL, useLocale } from "../../../lib/l";
import { errMsg, Stat } from "../../../components/kit";

interface Item { kind: "invoice" | "bill" | "recurring" | "payroll"; label: string; cents: number }
interface Row { date: string; inCents: number; outCents: number; balanceCents: number; items: Item[] }
interface Data {
  settings: { balance: number; payDelayDays: number; lateDelayDays: number }; days: number; payrollIncluded: boolean; payrollHidden: boolean;
  rows: Row[]; firstShortfall: { date: string; balanceCents: number } | null; lowest: { date: string; balanceCents: number }; endBalanceCents: number;
}

/** Day-by-day cash: the bank balance typed by hand, clients paying late, vendors paid after their due day, recurring payments and payroll. */
export function Forecast({ manage }: { manage: boolean }) {
  const l = useL();
  const loc = useLocale();
  const qc = useQueryClient();
  const [days, setDays] = useState(60);
  const [draft, setDraft] = useState<{ balance: string; pay: string; late: string } | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["vp-forecast", days], queryFn: () => api<Data>(`/api/accounting/forecast?days=${days}`) });
  const d = q.data;
  if (!d) return null;
  const f = draft ?? { balance: String(d.settings.balance), pay: String(d.settings.payDelayDays), late: String(d.settings.lateDelayDays) };
  const save = async () => {
    setError("");
    try { await api("/api/accounting/forecast/settings", { method: "PUT", body: { balance: Number(f.balance) || 0, payDelayDays: Number(f.pay) || 0, lateDelayDays: Number(f.late) || 0 } }); setDraft(null); await qc.invalidateQueries({ queryKey: ["vp-forecast"] }); }
    catch (e) { setError(errMsg(e, "Error")); }
  };
  const max = Math.max(1, ...d.rows.map((r) => Math.abs(r.balanceCents)));
  const kindLabel = (k: Item["kind"]) => ({ invoice: l("Facture client", "Client invoice"), bill: l("Facture fournisseur", "Vendor bill"), recurring: l("Récurrent", "Recurring"), payroll: l("Paie", "Payroll") }[k]);

  return (
    <section className="space-y-4">
      {d.firstShortfall ? (
        <div className="glass flex items-start gap-3 p-4" style={{ borderColor: "var(--danger)" }}><AlertTriangle className="mt-0.5 shrink-0" color="var(--danger)" />
          <div><b>{l("Manque de liquidités", "Cash shortfall")}</b><div className="text-sm text-muted">{l("Le solde passe sous zéro le", "The balance goes below zero on")} <b className="text-white">{fmtDate(d.firstShortfall.date, loc)}</b> ({money(d.firstShortfall.balanceCents / 100, loc)}). {l("Le point le plus bas :", "Lowest point:")} {money(d.lowest.balanceCents / 100, loc)} {l("le", "on")} {fmtDate(d.lowest.date, loc)}.</div></div></div>
      ) : (
        <div className="glass flex items-start gap-3 p-4" style={{ borderColor: "var(--ok)" }}><CheckCircle2 className="mt-0.5 shrink-0" color="var(--ok)" />
          <div><b>{l("Tout peut être payé", "Everything can be paid")}</b><div className="text-sm text-muted">{l(`Sur ${d.days} jours, le solde reste positif. Point le plus bas :`, `Over ${d.days} days the balance stays positive. Lowest point:`)} {money(d.lowest.balanceCents / 100, loc)} {l("le", "on")} {fmtDate(d.lowest.date, loc)}.</div></div></div>
      )}

      <div className="glass p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label><span className="label">{l("Solde bancaire aujourd'hui ($)", "Bank balance today ($)")}</span><input className="input !w-40" type="number" step="0.01" disabled={!manage} value={f.balance} onChange={(e) => setDraft({ ...f, balance: e.target.value })} /></label>
          <label><span className="label">{l("Nous payons après l'échéance (jours)", "We pay after the due day (days)")}</span><input className="input !w-32" type="number" min="0" disabled={!manage} value={f.pay} onChange={(e) => setDraft({ ...f, pay: e.target.value })} /></label>
          <label><span className="label">{l("Les clients paient après l'échéance (jours)", "Clients pay after the due day (days)")}</span><input className="input !w-32" type="number" min="0" disabled={!manage} value={f.late} onChange={(e) => setDraft({ ...f, late: e.target.value })} /></label>
          {manage && draft && <button className="btn btn-primary" onClick={() => void save()}>{l("Enregistrer", "Save")}</button>}
          <label className="ml-auto flex items-center gap-2 text-xs text-muted">{l("Jours", "Days")}: <b className="text-white">{days}</b><input type="range" min={14} max={120} value={days} onChange={(e) => setDays(Number(e.target.value))} className="accent-[var(--brand)]" /></label>
        </div>
        {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
        <p className="mt-3 text-xs text-muted">{l("Entrées : factures clients envoyées et non payées. Sorties : factures fournisseurs ouvertes, paiements récurrents (sauf ceux déjà dans QuickBooks)", "In: sent, unpaid client invoices. Out: open vendor bills, recurring payments (except those already in QuickBooks)")}{d.payrollIncluded ? l(" et la paie.", " and payroll.") : d.payrollHidden ? l(". La paie n'est pas incluse (droit RH requis).", ". Payroll is not included (HR right needed).") : "."}</p>
      </div>

      <div className="grid grid-cols-3 gap-3"><Stat label={l("Solde de départ", "Starting balance")} value={money(d.settings.balance, loc)} /><Stat label={l("Point le plus bas", "Lowest point")} value={money(d.lowest.balanceCents / 100, loc)} tone={d.lowest.balanceCents < 0 ? "danger" : undefined} /><Stat label={l(`Solde dans ${d.days} jours`, `Balance in ${d.days} days`)} value={money(d.endBalanceCents / 100, loc)} tone={d.endBalanceCents < 0 ? "danger" : undefined} /></div>

      <div className="glass p-4">
        <div className="mb-3 flex h-28 items-center gap-px" aria-hidden>{d.rows.map((r) => <div key={r.date} className="relative h-full flex-1" title={`${fmtDate(r.date, loc)}: ${money(r.balanceCents / 100, loc)}`}><div className="absolute left-0 right-0 rounded-sm" style={{ [r.balanceCents >= 0 ? "bottom" : "top"]: "50%", height: `${(Math.abs(r.balanceCents) / max) * 50}%`, background: r.balanceCents >= 0 ? "var(--ok)" : "var(--danger)" }} /></div>)}</div>
        <div className="max-h-[420px] overflow-auto"><table className="grid"><thead><tr><th>{l("Jour", "Day")}</th><th>{l("Entrées", "In")}</th><th>{l("Sorties", "Out")}</th><th>{l("Solde", "Balance")}</th></tr></thead>
          <tbody>{d.rows.filter((r) => r.items.length > 0 || r.date === d.rows[0]!.date).map((r) => (
            <tr key={r.date} className="cursor-pointer align-top" onClick={() => setOpen(open === r.date ? null : r.date)}>
              <td className="whitespace-nowrap">{fmtDate(r.date, loc)}{open === r.date && <ul className="mt-1 space-y-0.5 text-xs text-muted">{r.items.map((it, i) => <li key={i}>{kindLabel(it.kind)} · {it.kind === "payroll" ? l("Paie", "Payroll") : it.label} : {money(it.cents / 100, loc)}</li>)}</ul>}</td>
              <td style={{ color: r.inCents ? "var(--ok)" : undefined }}>{r.inCents ? money(r.inCents / 100, loc) : "—"}</td><td style={{ color: r.outCents ? "var(--danger)" : undefined }}>{r.outCents ? money(r.outCents / 100, loc) : "—"}</td>
              <td className="font-medium" style={{ color: r.balanceCents < 0 ? "var(--danger)" : undefined }}>{money(r.balanceCents / 100, loc)}</td></tr>))}</tbody></table></div>
      </div>
    </section>
  );
}
