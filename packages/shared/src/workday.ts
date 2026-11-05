// Work-day, paid-hours and holiday-pay rules shared by the API and the screens (same function both sides).
// Hours travel as whole minutes; money as integer cents. Employees only ever see hours.

export const minutesOfClock = (hhmm: string): number => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return NaN;
  const h = Number(m[1]), mi = Number(m[2]);
  return h > 23 || mi > 59 ? NaN : h * 60 + mi;
};

export const LUNCH_MINUTES = 60;
export const PAID_LUNCH_MINUTES = 30;

/**
 * Lunch is 1 h of which 30 min are paid. The 30 unpaid minutes come off only when the day without the lunch
 * hour is 5 h or more: 8:00-16:00 = 7.5 h, 8:00-13:00 = 5 h.
 */
export function workdayMinutes(start: string, end: string): { span: number; lunchTaken: number; paid: number } | null {
  const s = minutesOfClock(start), e = minutesOfClock(end);
  if (Number.isNaN(s) || Number.isNaN(e) || e <= s) return null;
  const span = e - s;
  const lunchTaken = span - LUNCH_MINUTES >= 300 ? LUNCH_MINUTES - PAID_LUNCH_MINUTES : 0;
  return { span, lunchTaken, paid: span - lunchTaken };
}

export type TimeKind = "work" | "workday" | "bankpay" | "other" | "travel" | "vacation" | "sick" | "holiday";

export interface PayEntry { kind: TimeKind; minutes: number; bankMinutes?: number }

/** Minutes the employee is paid for: work days less what goes to the bank, plus vacation, sick, holiday and bank payouts. */
export function paidMinutes(entries: PayEntry[]): number {
  let t = 0;
  for (const e of entries) {
    if (e.kind === "workday") t += e.minutes - (e.bankMinutes ?? 0);
    else if (e.kind === "vacation" || e.kind === "sick" || e.kind === "holiday" || e.kind === "bankpay") t += e.minutes;
  }
  return t;
}

/** Minutes that count as "gross pay" for the 4 % vacation accrual (vacation taken does not accrue). */
export function accruablePaidMinutes(entries: PayEntry[]): number {
  return paidMinutes(entries.filter((e) => e.kind !== "vacation"));
}

/** What a week counts for holiday pay: work days (less banked), vacation and sick, capped at the overtime threshold. */
export function holidayBasisMinutes(entries: PayEntry[], overtimeHours: number): number {
  let t = 0;
  for (const e of entries) {
    if (e.kind === "workday") t += e.minutes - (e.bankMinutes ?? 0);
    else if (e.kind === "vacation" || e.kind === "sick") t += e.minutes;
  }
  return Math.min(t, Math.round(overtimeHours * 60));
}

/** Holiday pay = 1/20 of the wages of the four complete weeks before the holiday's week. */
export function holidayPayCents(priorWeeksBasisMinutes: number[], wageCents: number): number {
  const total = priorWeeksBasisMinutes.slice(0, 4).reduce((a, b) => a + b, 0);
  return Math.round((total / 60) * wageCents / 20);
}

export const centsOf = (minutes: number, wageCents: number) => Math.round((minutes / 60) * wageCents);
export const VACATION_ACCRUAL = 0.04;
