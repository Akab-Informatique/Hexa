// Contract charge schedule: what a recurring-services contract charges, when, and how a part period is prorated.
// Same function on the server (work to bill) and in the contract window (preview). Dates are YYYY-MM-DD strings.

const D = (s: string) => new Date(`${s}T00:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);
export const diffDays = (a: string, b: string) => Math.round((D(b).getTime() - D(a).getTime()) / 86_400_000);
export const addDaysISO = (s: string, n: number) => { const d = D(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const daysInMonth = (y: number, m0: number) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
const monthStart = (s: string) => `${s.slice(0, 7)}-01`;
const monthEnd = (s: string) => `${s.slice(0, 7)}-${String(daysInMonth(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1)).padStart(2, "0")}`;
/** First day of the calendar period (1 month, or 3 months = calendar quarter) holding `s`. */
const periodStart = (s: string, months: 1 | 3) => (months === 1 ? monthStart(s) : `${s.slice(0, 4)}-${String(Math.floor((Number(s.slice(5, 7)) - 1) / 3) * 3 + 1).padStart(2, "0")}-01`);
const periodEnd = (ps: string, months: 1 | 3) => (months === 1 ? monthEnd(ps) : monthEnd(`${ps.slice(0, 4)}-${String(Number(ps.slice(5, 7)) + 2).padStart(2, "0")}-01`));
/** Same month and day `n` years later (29 Feb falls back to 28 Feb). */
export const addYearsISO = (s: string, n: number) => {
  const y = Number(s.slice(0, 4)) + n, m = Number(s.slice(5, 7)), day = Number(s.slice(8, 10));
  return `${y}-${String(m).padStart(2, "0")}-${String(Math.min(day, daysInMonth(y, m - 1))).padStart(2, "0")}`;
};
const maxD = (a: string, b: string) => (a > b ? a : b);
const minD = (a: string, b: string) => (a < b ? a : b);

export interface ContractLike { billingPeriod: "monthly" | "yearly"; startsOn: string; endsOn: string | null }
export type ServiceKind = "monthly" | "quarterly" | "yearly" | "one_time";
/** `endsOn` (optional) stops the service on that day, inclusive; the contract's own end still applies. */
export interface ServiceLine { id: string; name: string; kind: ServiceKind; priceCents: number; quantity: number; addedOn: string; endsOn?: string | null }
export interface Charge {
  lineId: string; name: string; date: string; periodStart: string; periodEnd: string; cents: number; days: number; periodDays: number; prorated: boolean; description: string;
}

/** Price x days left in the period / days in the period, to the cent. */
export const prorataCents = (fullCents: number, days: number, periodDays: number) => Math.round((fullCents * days) / periodDays);

/**
 * Every charge dated on or before `until`.
 * - monthly service on a monthly contract: one per calendar month, the first (and last) part month prorated by days;
 * - quarterly service on a monthly contract: one per calendar quarter (Jan/Apr/Jul/Oct), part quarters prorated by days;
 * - yearly service, or a monthly service on a yearly contract (x12): one per contract year, anchored on the start day;
 * - one-time service: once, on its day.
 */
export function chargesFor(contract: ContractLike, lines: ServiceLine[], until: string): Charge[] {
  const out: Charge[] = [];
  for (const ln of lines) {
    const start = maxD(ln.addedOn, contract.startsOn);
    const end = minD(contract.endsOn ?? "9999-12-31", ln.endsOn ?? "9999-12-31");
    const unit = ln.priceCents * ln.quantity;
    if (start > end) continue;
    if (ln.kind === "one_time") {
      if (start <= until) out.push({ lineId: ln.id, name: ln.name, date: start, periodStart: start, periodEnd: start, cents: Math.round(unit), days: 1, periodDays: 1, prorated: false, description: ln.name });
      continue;
    }
    const months: 1 | 3 | 0 = contract.billingPeriod === "monthly" ? (ln.kind === "monthly" ? 1 : ln.kind === "quarterly" ? 3 : 0) : 0;
    if (months) {
      for (let ps = periodStart(start, months); ps <= until && ps <= end; ps = addDaysISO(periodEnd(ps, months), 1)) {
        const pe = periodEnd(ps, months), from = maxD(start, ps), to = minD(end, pe);
        const days = diffDays(from, to) + 1, periodDays = diffDays(ps, pe) + 1;
        if (from > until) break;
        out.push({ lineId: ln.id, name: ln.name, date: from, periodStart: ps, periodEnd: pe, cents: prorataCents(unit, days, periodDays), days, periodDays, prorated: days < periodDays, description: months === 1 ? `${ln.name} (${ps.slice(0, 7)})` : `${ln.name} (${ps.slice(0, 7)} → ${pe.slice(0, 7)})` });
      }
    } else {
      // Yearly service, or a monthly/quarterly one on a yearly contract (x12 / x4): one charge per contract year.
      const factor = ln.kind === "monthly" ? 12 : ln.kind === "quarterly" ? 4 : 1;
      for (let k = 0; ; k++) {
        const ps = addYearsISO(contract.startsOn, k), pe = addDaysISO(addYearsISO(contract.startsOn, k + 1), -1);
        if (ps > until || ps > end) break;
        if (pe < start) continue;
        const from = maxD(start, ps), to = minD(end, pe);
        if (from > until) break;
        const days = diffDays(from, to) + 1, periodDays = diffDays(ps, pe) + 1;
        out.push({ lineId: ln.id, name: ln.name, date: from, periodStart: ps, periodEnd: pe, cents: prorataCents(unit * factor, days, periodDays), days, periodDays, prorated: days < periodDays, description: `${ln.name} (${ps} → ${pe})` });
      }
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
}

/** What a contract charges per month, for lists: monthly lines in full, yearly ones as a twelfth. */
export function monthlyEquivalentCents(lines: Pick<ServiceLine, "kind" | "priceCents" | "quantity">[], period: "monthly" | "yearly"): number {
  let t = 0;
  for (const l of lines) {
    const full = l.priceCents * l.quantity;
    if (l.kind === "monthly") t += full;
    else if (l.kind === "quarterly") t += full / 3;
    else if (l.kind === "yearly") t += full / 12;
  }
  void period;
  return Math.round(t);
}
