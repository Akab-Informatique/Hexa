import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { api } from "../../../lib/api";
import { money, useL, useLocale } from "../../../lib/l";
import { Chip } from "../../../components/kit";

interface CalDay {
  date: string;
  bills: { id: string; vendorName: string; number: string; amount: number; status: string }[];
  recurring: { label: string; amount: number; inQuickbooks: boolean }[];
  payroll: number | null;
}

const shiftMonth = (m: string, n: number) => { const d = new Date(`${m}-15T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 7); };

/** A month, Monday first: what is due each day (total and count), red once past, with recurring payments and paydays marked. */
export function BillsCalendar({ manage, onAdd, onOpen }: { manage: boolean; onAdd: (day: string) => void; onOpen: (billId: string) => void }) {
  const l = useL();
  const loc = useLocale();
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [sel, setSel] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["bills-calendar", month], queryFn: () => api<{ days: CalDay[]; today: string }>(`/api/accounting/bills/calendar?month=${month}`) });
  const today = q.data?.today ?? new Date().toISOString().slice(0, 10);
  const byDate = new Map((q.data?.days ?? []).map((d) => [d.date, d]));
  // Monday-first grid: blanks before the 1st, then the days.
  const first = new Date(`${month}-01T12:00:00Z`);
  const lead = (first.getUTCDay() + 6) % 7;
  const count = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  const cells: (string | null)[] = [...Array(lead).fill(null), ...Array.from({ length: count }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`)];
  while (cells.length % 7) cells.push(null);
  const weekdays = Array.from({ length: 7 }, (_, i) => new Date(Date.UTC(2024, 0, 1 + i)).toLocaleDateString(loc, { weekday: "short", timeZone: "UTC" }));
  const cur = sel ? byDate.get(sel) ?? { date: sel, bills: [], recurring: [], payroll: null } : null;
  const open = (d: CalDay | undefined) => (d?.bills ?? []).filter((b) => b.status !== "paid");

  return (
    <section className="glass p-4">
      <div className="mb-3 flex items-center gap-2">
        <button className="btn !p-1.5" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="previous"><ChevronLeft size={15} /></button>
        <h2 className="min-w-[150px] text-center font-semibold capitalize">{new Date(`${month}-15T12:00:00Z`).toLocaleDateString(loc, { month: "long", year: "numeric", timeZone: "UTC" })}</h2>
        <button className="btn !p-1.5" onClick={() => setMonth(shiftMonth(month, 1))} aria-label="next"><ChevronRight size={15} /></button>
        <button className="btn !py-1 text-xs" onClick={() => { setMonth(today.slice(0, 7)); setSel(today); }}>{l("Aujourd'hui", "Today")}</button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-[11px] uppercase text-muted">{weekdays.map((w) => <div key={w}>{w}</div>)}</div>
      <div className="mt-1 grid grid-cols-7 gap-1">
        {cells.map((date, i) => {
          if (!date) return <div key={i} />;
          const d = byDate.get(date);
          const o = open(d);
          const total = o.reduce((a, b) => a + b.amount, 0);
          const past = date < today && o.length > 0;
          return (
            <button key={date} onClick={() => setSel(date)} className="glass-flat min-h-[74px] p-1.5 text-left transition hover:brightness-125" style={{ borderColor: date === sel ? "var(--brand)" : date === today ? "var(--warn)" : undefined }}>
              <div className="flex items-center justify-between text-xs"><span className={date === today ? "font-bold text-[var(--warn)]" : "text-muted"}>{Number(date.slice(8))}</span>{d?.payroll != null && <span title={l("Paie", "Payroll")}>💵</span>}</div>
              {o.length > 0 && <div className="mt-1 text-[11px] font-semibold" style={{ color: past ? "var(--danger)" : undefined }}>{money(total, loc)}</div>}
              {o.length > 0 && <div className="text-[10px] text-muted">{o.length} {l("fact.", "bill(s)")}</div>}
              {(d?.recurring.length ?? 0) > 0 && <div className="text-[10px] text-[var(--brand-2)]">↻ {d!.recurring.length}</div>}
            </button>);
        })}
      </div>
      {cur && (
        <div className="mt-4 space-y-2 text-sm">
          <div className="flex items-center gap-2"><b className="capitalize">{new Date(`${cur.date}T12:00:00Z`).toLocaleDateString(loc, { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" })}</b><div className="flex-1" />{manage && <button className="btn !py-1 text-xs" onClick={() => onAdd(cur.date)}><Plus size={13} />{l("Facture à cette date", "Bill on this date")}</button>}</div>
          {cur.bills.map((b) => (
            <button key={b.id} className="glass-flat flex w-full items-center justify-between gap-2 p-2 text-left" onClick={() => onOpen(b.id)}>
              <span><b>{b.vendorName}</b> <span className="text-xs text-muted">{b.number}</span></span><span className="flex items-center gap-2">{money(b.amount, loc)}<Chip tone={b.status === "paid" ? "ok" : b.status === "scheduled" ? "warn" : "off"}>{b.status === "paid" ? l("Payée", "Paid") : b.status === "scheduled" ? l("Planifiée", "Scheduled") : l("À payer", "Unpaid")}</Chip></span></button>))}
          {cur.recurring.map((r, i) => <div key={i} className="flex justify-between text-muted"><span>↻ {r.label}{r.inQuickbooks ? ` (${l("déjà dans QuickBooks", "already in QuickBooks")})` : ""}</span><span>{money(r.amount, loc)}</span></div>)}
          {cur.payroll != null && <div className="flex justify-between text-muted"><span>💵 {l("Paie", "Payroll")}</span><span>{money(cur.payroll, loc)}</span></div>}
          {!cur.bills.length && !cur.recurring.length && cur.payroll == null && <p className="text-muted">{l("Rien à payer ce jour-là.", "Nothing to pay that day.")}</p>}
        </div>)}
    </section>
  );
}
