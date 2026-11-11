// Pure helpers for the timesheet / payroll work (no database, so they can be unit tested).

export const QUEBEC_TZ = "America/Toronto";
export const DAY_CAP_MINUTES = 1440;

// ------------------------------------------------------------------ Dates
const pad = (n: number) => String(n).padStart(2, "0");
const toISO = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const parseISO = (s: string) => new Date(`${s}T00:00:00Z`);

/** True for a real calendar date written YYYY-MM-DD (2025-02-30 is refused). */
export function isRealDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = parseISO(s);
  return !Number.isNaN(d.getTime()) && toISO(d) === s;
}

export function addDaysISO(s: string, n: number): string {
  const d = parseISO(s);
  d.setUTCDate(d.getUTCDate() + n);
  return toISO(d);
}

export const daysBetween = (a: string, b: string): number => Math.round((parseISO(b).getTime() - parseISO(a).getTime()) / 86_400_000);

const partsFmt = new Intl.DateTimeFormat("en-CA", { timeZone: QUEBEC_TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** Quebec calendar date (YYYY-MM-DD) of an instant. */
export function quebecDay(d: Date): string {
  const p = Object.fromEntries(partsFmt.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

/** Offset of Quebec from UTC at an instant, in ms (negative: behind UTC). */
function offsetMs(t: number): number {
  const p = Object.fromEntries(partsFmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - Math.floor(t / 1000) * 1000;
}

/** The instant (ms) at which a Quebec calendar day starts. */
export function quebecMidnight(day: string): number {
  const base = Date.parse(`${day}T00:00:00Z`);
  let guess = base - offsetMs(base);
  guess = base - offsetMs(guess); // second pass settles the daylight-saving shift
  return guess;
}

// ------------------------------------------------------------------ Minutes from timestamps
/**
 * Rounding rule (payroll): elapsed time is measured from SERVER timestamps in whole seconds, then ROUNDED UP to the next
 * whole minute, with a minimum of 1 minute. Rounding up per stretch favours the employee by less than a minute per stretch.
 */
export function minutesFromSeconds(seconds: number): number {
  const s = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  return Math.max(1, Math.ceil(s / 60));
}

export const minutesBetween = (start: Date, stop: Date): number => minutesFromSeconds(Math.floor((stop.getTime() - start.getTime()) / 1000));

export interface Chunk { workDate: string; minutes: number; startMs: number; endMs: number }

/**
 * Cuts a stretch at Quebec midnights so each timesheet day gets only its own time (a timer left on overnight never
 * produces a day over 24 h). work_date of a chunk = Quebec date of its start. A chunk is never above 1440 minutes
 * (a 25 h daylight-saving day is split in two entries of the same day, so no minute is lost).
 */
export function splitByQuebecDay(start: Date, stop: Date): Chunk[] {
  let cur = start.getTime();
  const end = stop.getTime();
  if (!(end > cur)) return [{ workDate: quebecDay(start), minutes: 1, startMs: cur, endMs: cur }];
  const out: Chunk[] = [];
  while (cur < end) {
    const day = quebecDay(new Date(cur));
    const next = quebecMidnight(addDaysISO(day, 1));
    const upTo = next > cur ? Math.min(end, next) : end;
    let seconds = Math.floor((upTo - cur) / 1000);
    let from = cur;
    let left = minutesFromSeconds(seconds);
    while (left > DAY_CAP_MINUTES) {
      out.push({ workDate: day, minutes: DAY_CAP_MINUTES, startMs: from, endMs: from + DAY_CAP_MINUTES * 60_000 });
      from += DAY_CAP_MINUTES * 60_000; seconds -= DAY_CAP_MINUTES * 60; left -= DAY_CAP_MINUTES;
    }
    out.push({ workDate: day, minutes: left, startMs: from, endMs: upTo });
    cur = upTo;
  }
  return out;
}

/** True when adding minutes to a day that already has `existing` keeps it within 24 h. */
export const fitsDayCap = (existing: number, add: number, cap = DAY_CAP_MINUTES): boolean => Number.isFinite(existing) && Number.isFinite(add) && add >= 0 && existing + add <= cap;

// ------------------------------------------------------------------ Pay periods
export interface PayConfig { type: "weekly" | "biweekly"; anchor: string }
/** Default: weekly periods starting on Mondays (2024-01-01 is a Monday). */
export const DEFAULT_PAY: PayConfig = { type: "weekly", anchor: "2024-01-01" };

export function normalizePayConfig(v: unknown): PayConfig {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const type = o.type === "biweekly" ? "biweekly" : "weekly";
  const anchor = typeof o.anchor === "string" && isRealDate(o.anchor) ? o.anchor : DEFAULT_PAY.anchor;
  return { type, anchor };
}

export interface PayPeriod { start: string; end: string; days: number; type: PayConfig["type"] }

/** The pay period that contains `date` (works before the anchor too, and across year ends). */
export function payPeriodOf(date: string, cfg: PayConfig): PayPeriod {
  const len = cfg.type === "biweekly" ? 14 : 7;
  const k = Math.floor(daysBetween(cfg.anchor, date) / len);
  const start = addDaysISO(cfg.anchor, k * len);
  return { start, end: addDaysISO(start, len - 1), days: len, type: cfg.type };
}

// ------------------------------------------------------------------ CSV
/**
 * One CSV cell. Text starting with = + - @ tab or CR (or spaces followed by one of = + - @) gets an apostrophe in front
 * so a spreadsheet never runs it as a formula. Every cell is quoted and quotes are doubled. Numbers are our own values
 * and are written as is.
 */
export function csvCell(v: unknown): string {
  if (v == null) return '""';
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  let s = typeof v === "string" ? v : String(v);
  if (/^[=+\-@\t\r]/.test(s) || /^\s+[=+\-@]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export const csvRow = (cells: unknown[]): string => cells.map(csvCell).join(",");

/** UTF-8 text with a byte order mark (Excel reads accents right), CRLF line ends. */
export const toCsv = (rows: unknown[][]): string => `﻿${rows.map(csvRow).join("\r\n")}\r\n`;

export const hoursOf = (minutes: number): string => (Math.round((minutes / 60) * 100) / 100).toFixed(2);
