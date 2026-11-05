// Invoice math, shared by the API (authoritative) and the web UI (live preview).
// Rule taken from the reference portal: taxes are computed line by line and rounded half-up to the
// cent, so the totals always match what QuickBooks computes.

export interface TaxRates { gst: number; qst: number } // percentages, e.g. 5 and 9.975
export interface LineInput { quantity: number; unitPrice: number; taxable: boolean }
export interface LineResult extends LineInput { amount: number; gst: number; qst: number }

/** Round half away from zero to cents, immune to binary float noise (1.005 -> 1.01). */
export const roundCents = (n: number): number => Math.sign(n) * Math.round(Math.abs(n) * 100 + 1e-9) / 100;

export function computeInvoice(lines: LineInput[], rates: TaxRates) {
  const out: LineResult[] = lines.map((l) => {
    const amount = roundCents(l.quantity * l.unitPrice);
    return {
      ...l,
      amount,
      gst: l.taxable ? roundCents((amount * rates.gst) / 100) : 0,
      qst: l.taxable ? roundCents((amount * rates.qst) / 100) : 0,
    };
  });
  const sum = (f: (l: LineResult) => number) => roundCents(out.reduce((a, l) => a + f(l), 0));
  const subtotal = sum((l) => l.amount);
  const gst = sum((l) => l.gst);
  const qst = sum((l) => l.qst);
  return { lines: out, subtotal, gst, qst, total: roundCents(subtotal + gst + qst) };
}

export const DEFAULT_RATES: TaxRates = { gst: 5, qst: 9.975 };

// ---- Dates (all "date" values travel as YYYY-MM-DD strings, never as timestamps) ----
export const toISODate = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
export const parseISODate = (s: string) => new Date(`${s}T00:00:00Z`);
export const addDays = (s: string, n: number) => { const d = parseISODate(s); d.setUTCDate(d.getUTCDate() + n); return toISODate(d); };
/** Monday of the week containing the given date. */
export const mondayOf = (s: string) => { const d = parseISODate(s); const dow = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - dow); return toISODate(d); };
export const todayISO = () => toISODate(new Date());

export function addRecurrence(date: string, r: { every: number; unit: "day" | "week" | "month" | "year" }): string {
  const d = parseISODate(date);
  if (r.unit === "day") d.setUTCDate(d.getUTCDate() + r.every);
  else if (r.unit === "week") d.setUTCDate(d.getUTCDate() + 7 * r.every);
  else if (r.unit === "month") {
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + r.every);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last)); // Jan 31 + 1 month = Feb 28/29, not Mar 3
  } else d.setUTCFullYear(d.getUTCFullYear() + r.every);
  return toISODate(d);
}

/**
 * An invoice goes out as soon as it is finalized, so its due day counts from the day it is sent:
 * sent day + terms + 1 day (terms 0 = on receipt, due the next day). Reference rule.
 */
export const dueAfterSent = (sentDay: string, termsDays: number): string => addDays(sentDay, termsDays + 1);

/** Days late (0 when not late yet) and the aging bucket of an unpaid invoice. */
export function aging(dueDate: string, today: string): { daysLate: number; bucket: "notDue" | "d1_30" | "d31_60" | "d61_90" | "d90" } {
  const late = Math.round((parseISODate(today).getTime() - parseISODate(dueDate).getTime()) / 86_400_000);
  if (late <= 0) return { daysLate: 0, bucket: "notDue" };
  return { daysLate: late, bucket: late <= 30 ? "d1_30" : late <= 60 ? "d31_60" : late <= 90 ? "d61_90" : "d90" };
}
