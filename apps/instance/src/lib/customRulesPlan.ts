import { addDays, mondayOf } from "@hexa/shared/billing";
import type { ClientRow, Planned } from "./autoTasksPlan.ts";

/**
 * The firm's own recurring automatic tasks (pure planning, no database).
 *  - weekly:    the chosen weekday of the current week          (period = that week's Monday)
 *  - monthly:   the chosen day of the current month             (period = YYYY-MM)
 *  - quarterly: the chosen day of the chosen month (1-3) of the current quarter (period = YYYY-Qn)
 *  - yearly:    the chosen day of the chosen month of this year (period = YYYY)
 * Day 31 (or any day past the end of the month) means the last day of that month.
 * An occurrence is created on its day or later while still inside its window (the rest of its week/month/quarter/year,
 * at most 30 days) and while its due date is not past, so a server that was off catches up, and nothing is created for the past.
 */
export type Cadence = "weekly" | "monthly" | "quarterly" | "yearly";
export interface CustomRule {
  id: string; name: string; enabled: boolean; titleTemplate: string; descriptionTemplate: string; bullets: string[];
  cadence: Cadence; weekday: number | null; dayOfMonth: number | null; month: number | null;
  dueAfterDays: number | null; dueDayOfMonth: number | null;
  scope: "all" | "class" | "clients"; scopeClassKey: string | null; clientIds: string[];
  assigneeMode: "resource" | "user" | "none"; assigneeUserId: string | null;
}
export interface Occurrence { date: string; period: string; windowEnd: string; due: string | null; label: string; month: string; year: string }

const MONTHS_FR = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const pad = (n: number) => String(n).padStart(2, "0");
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const onDay = (y: number, m: number, dom: number) => iso(y, m, Math.min(Math.max(dom, 1), lastDay(y, m)));

/** The occurrence of `rule` whose window contains `today` (it may still be in the future), or null when the rule is incomplete. */
export function occurrenceOf(rule: CustomRule, today: string): Occurrence | null {
  const ty = Number(today.slice(0, 4)), tm = Number(today.slice(5, 7));
  let date: string, period: string, periodEnd: string, label: string;
  if (rule.cadence === "weekly") {
    if (!rule.weekday || rule.weekday < 1 || rule.weekday > 7) return null;
    const mon = mondayOf(today);
    date = addDays(mon, rule.weekday - 1); period = mon; periodEnd = addDays(mon, 6); label = `semaine du ${mon}`;
  } else if (rule.cadence === "monthly") {
    if (!rule.dayOfMonth) return null;
    date = onDay(ty, tm, rule.dayOfMonth); period = `${ty}-${pad(tm)}`; periodEnd = iso(ty, tm, lastDay(ty, tm)); label = `${MONTHS_FR[tm - 1]} ${ty}`;
  } else if (rule.cadence === "quarterly") {
    if (!rule.dayOfMonth) return null;
    const q = Math.floor((tm - 1) / 3), within = Math.min(Math.max(rule.month ?? 1, 1), 3);
    const m = q * 3 + within;
    date = onDay(ty, m, rule.dayOfMonth); period = `${ty}-Q${q + 1}`; periodEnd = iso(ty, q * 3 + 3, lastDay(ty, q * 3 + 3)); label = `T${q + 1} ${ty}`;
  } else {
    if (!rule.dayOfMonth || !rule.month || rule.month < 1 || rule.month > 12) return null;
    date = onDay(ty, rule.month, rule.dayOfMonth); period = String(ty); periodEnd = iso(ty, 12, 31); label = String(ty);
  }
  const y = Number(date.slice(0, 4)), m = Number(date.slice(5, 7));
  let due: string | null = null;
  if (rule.dueAfterDays != null) due = addDays(date, rule.dueAfterDays);
  else if (rule.dueDayOfMonth != null) {
    due = onDay(y, m, rule.dueDayOfMonth);
    if (due < date) { const n = new Date(Date.UTC(y, m, 1)); due = onDay(n.getUTCFullYear(), n.getUTCMonth() + 1, rule.dueDayOfMonth); }
  }
  const cap = addDays(date, 30);
  return { date, period, windowEnd: periodEnd < cap ? periodEnd : cap, due, label, month: MONTHS_FR[m - 1]!, year: String(y) };
}

/** The first day after `today` on which `rule` starts a new occurrence (for the preview), or null. */
export function nextRun(rule: CustomRule, today: string): string | null {
  for (let i = 1; i <= 400; i++) {
    const d = addDays(today, i);
    const o = occurrenceOf(rule, d);
    if (o && o.date === d) return d;
  }
  return null;
}

const KEYS = ["client", "period", "month", "year"] as const;
/** Replaces {client} {period} {month} {year} in one pass over a fixed whitelist: no evaluation, values are never re-scanned. */
export function fill(tpl: string, vars: Record<(typeof KEYS)[number], string>): string {
  let out = "";
  let i = 0;
  while (i < tpl.length) {
    if (tpl[i] === "{") {
      const key = KEYS.find((k) => tpl.startsWith(`{${k}}`, i));
      if (key) { out += vars[key]; i += key.length + 2; continue; }
    }
    out += tpl[i];
    i++;
  }
  return out;
}

/** Which tasks the enabled custom rules create on `today` for the given (active) clients. */
export function planCustom(rules: CustomRule[], clients: ClientRow[], today: string): Planned[] {
  const out: Planned[] = [];
  for (const r of rules) {
    if (!r.enabled) continue;
    const o = occurrenceOf(r, today);
    if (!o || o.date > today || o.windowEnd < today || (o.due !== null && o.due < today)) continue;
    const ids = r.scope === "clients" ? new Set(r.clientIds) : null;
    for (const c of clients) {
      if (r.scope === "class" ? !r.scopeClassKey || c.class_key !== r.scopeClassKey : ids ? !ids.has(c.id) : false) continue;
      const vars = { client: c.name, period: o.label, month: o.month, year: o.year };
      out.push({
        clientId: c.id, clientName: c.name, rule: `custom:${r.id}`, period: o.period,
        title: fill(r.titleTemplate, vars).slice(0, 300), description: fill(r.descriptionTemplate, vars).slice(0, 5000),
        due: o.due ?? o.date, start: o.date,
        assigneeId: r.assigneeMode === "resource" ? c.resource_id ?? null : r.assigneeMode === "user" ? r.assigneeUserId : null,
        bullets: r.bullets, tags: ["auto", "automatisation"],
      });
    }
  }
  return out;
}
