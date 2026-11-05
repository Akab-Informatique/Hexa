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

/** Easter Sunday (Gregorian), as YYYY-MM-DD. */
export function easterSunday(year: number): string {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** The nth Monday (1-based) of a month, or the last Monday strictly before a given day when `before` is set. */
const nthMonday = (year: number, month: number, n: number) => {
  const first = parseISODate(`${year}-${String(month).padStart(2, "0")}-01`);
  const shift = (8 - first.getUTCDay()) % 7; // days to the first Monday
  return addDays(toISODate(first), shift + 7 * (n - 1));
};

/** Quebec statutory holidays of a year: date and name (FR, EN). Easter Monday stands for the Good Friday / Easter Monday choice. */
export function quebecHolidays(year: number): { date: string; fr: string; en: string }[] {
  const easter = easterSunday(year);
  const may25 = parseISODate(`${year}-05-25`);
  const back = (may25.getUTCDay() + 6) % 7; // days since Monday
  const patriots = addDays(toISODate(may25), back === 0 ? -7 : -back); // the Monday strictly before May 25
  return [
    { date: `${year}-01-01`, fr: "Jour de l'An", en: "New Year's Day" },
    { date: addDays(easter, 1), fr: "Lundi de Pâques", en: "Easter Monday" },
    { date: patriots, fr: "Journée nationale des patriotes", en: "National Patriots' Day" },
    { date: `${year}-06-24`, fr: "Fête nationale du Québec", en: "Quebec National Day" },
    { date: `${year}-07-01`, fr: "Fête du Canada", en: "Canada Day" },
    { date: nthMonday(year, 9, 1), fr: "Fête du Travail", en: "Labour Day" },
    { date: nthMonday(year, 10, 2), fr: "Action de grâce", en: "Thanksgiving" },
    { date: `${year}-12-25`, fr: "Noël", en: "Christmas Day" },
  ];
}

/** Friday that ends the working week of a day: this week's Friday, or the coming one on a weekend. */
export function fridayOf(day: string): string {
  const dow = (parseISODate(day).getUTCDay() + 6) % 7; // Monday = 0
  return dow >= 5 ? addDays(day, 7 - dow + 4) : addDays(day, 4 - dow);
}
