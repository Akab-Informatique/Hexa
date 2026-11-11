import { describe, expect, it } from "vitest";
import {
  csvCell, csvRow, fitsDayCap, isRealDate, minutesBetween, minutesFromSeconds, normalizePayConfig, payPeriodOf, quebecDay, splitByQuebecDay, toCsv, DEFAULT_PAY,
} from "../apps/instance/src/lib/timesheetPayroll.ts";

describe("minutes from timestamps", () => {
  it("rounds up to the minute, minimum 1", () => {
    expect(minutesFromSeconds(0)).toBe(1);
    expect(minutesFromSeconds(1)).toBe(1);
    expect(minutesFromSeconds(60)).toBe(1);
    expect(minutesFromSeconds(61)).toBe(2);
    expect(minutesFromSeconds(3600)).toBe(60);
    expect(minutesFromSeconds(3601)).toBe(61);
  });
  it("never trusts bad numbers", () => {
    expect(minutesFromSeconds(-50)).toBe(1);
    expect(minutesFromSeconds(Number.NaN)).toBe(1);
  });
  it("measures between two instants", () => {
    expect(minutesBetween(new Date("2025-03-03T14:00:00Z"), new Date("2025-03-03T14:30:30Z"))).toBe(31);
    expect(minutesBetween(new Date("2025-03-03T14:00:00Z"), new Date("2025-03-03T13:00:00Z"))).toBe(1); // clock going back: still 1, never negative
  });
});

describe("Quebec days", () => {
  it("uses the Quebec date, not UTC", () => {
    expect(quebecDay(new Date("2025-01-15T03:30:00Z"))).toBe("2025-01-14"); // 22:30 the evening before
    expect(quebecDay(new Date("2025-07-15T03:30:00Z"))).toBe("2025-07-14"); // 23:30 (summer time)
  });
  it("keeps a same-day stretch in one chunk", () => {
    const c = splitByQuebecDay(new Date("2025-03-03T15:00:00Z"), new Date("2025-03-03T16:30:10Z"));
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ workDate: "2025-03-03", minutes: 91 });
  });
  it("cuts at Quebec midnight and loses no minute", () => {
    // 23:30 to 00:30 Quebec (winter, UTC-5): 04:30Z -> 05:30Z next day
    const c = splitByQuebecDay(new Date("2025-01-15T04:30:00Z"), new Date("2025-01-15T05:30:00Z"));
    expect(c.map((x) => [x.workDate, x.minutes])).toEqual([["2025-01-14", 30], ["2025-01-15", 30]]);
  });
  it("cuts a stretch of several days with no day above 24 h", () => {
    const c = splitByQuebecDay(new Date("2025-01-10T17:00:00Z"), new Date("2025-01-13T17:00:00Z"));
    expect(c.length).toBe(4);
    expect(c.reduce((a, x) => a + x.minutes, 0)).toBe(72 * 60);
    expect(Math.max(...c.map((x) => x.minutes))).toBeLessThanOrEqual(1440);
  });
  it("splits the 25 hour fall-back day without losing time", () => {
    // 2025-11-02 has 25 hours in Quebec; a timer running the whole day
    const c = splitByQuebecDay(new Date("2025-11-02T04:00:00Z"), new Date("2025-11-03T05:00:00Z"));
    expect(c.reduce((a, x) => a + x.minutes, 0)).toBe(25 * 60);
    expect(Math.max(...c.map((x) => x.minutes))).toBeLessThanOrEqual(1440);
    expect(c.every((x) => x.workDate === "2025-11-02")).toBe(true);
  });
  it("a stop before the start still gives one minute", () => {
    expect(splitByQuebecDay(new Date("2025-03-03T15:00:00Z"), new Date("2025-03-03T14:00:00Z"))).toHaveLength(1);
  });
});

describe("day total cap", () => {
  it("allows up to 24 h, refuses more", () => {
    expect(fitsDayCap(0, 1440)).toBe(true);
    expect(fitsDayCap(1000, 440)).toBe(true);
    expect(fitsDayCap(1000, 441)).toBe(false);
    expect(fitsDayCap(1440, 1)).toBe(false);
  });
  it("refuses nonsense", () => {
    expect(fitsDayCap(0, -5)).toBe(false);
    expect(fitsDayCap(Number.NaN, 5)).toBe(false);
  });
});

describe("dates", () => {
  it("accepts only real calendar dates", () => {
    expect(isRealDate("2024-02-29")).toBe(true);
    expect(isRealDate("2025-02-29")).toBe(false);
    expect(isRealDate("2025-13-01")).toBe(false);
    expect(isRealDate("2025-1-1")).toBe(false);
  });
});

describe("pay periods", () => {
  const weekly = { type: "weekly", anchor: "2024-01-01" } as const;
  const bi = { type: "biweekly", anchor: "2024-01-01" } as const;
  it("weekly periods start on the anchor weekday", () => {
    expect(payPeriodOf("2025-03-05", weekly)).toEqual({ start: "2025-03-03", end: "2025-03-09", days: 7, type: "weekly" });
    expect(payPeriodOf("2025-03-03", weekly).start).toBe("2025-03-03");
    expect(payPeriodOf("2025-03-09", weekly).start).toBe("2025-03-03");
    expect(payPeriodOf("2025-03-10", weekly).start).toBe("2025-03-10");
  });
  it("biweekly periods are 14 days from the anchor", () => {
    expect(payPeriodOf("2024-01-14", bi)).toMatchObject({ start: "2024-01-01", end: "2024-01-14" });
    expect(payPeriodOf("2024-01-15", bi)).toMatchObject({ start: "2024-01-15", end: "2024-01-28" });
    expect(payPeriodOf("2025-03-05", bi).days).toBe(14);
  });
  it("rolls over a year end", () => {
    const p = payPeriodOf("2025-01-02", bi);
    expect(p.start).toBe("2024-12-30");
    expect(p.end).toBe("2025-01-12");
    expect(payPeriodOf("2024-12-29", bi)).toMatchObject({ start: "2024-12-16", end: "2024-12-29" });
    expect(payPeriodOf("2025-01-01", weekly)).toMatchObject({ start: "2024-12-30", end: "2025-01-05" });
  });
  it("works before the anchor", () => {
    expect(payPeriodOf("2023-12-31", weekly)).toMatchObject({ start: "2023-12-25", end: "2023-12-31" });
    expect(payPeriodOf("2023-12-31", bi)).toMatchObject({ start: "2023-12-18", end: "2023-12-31" });
  });
  it("another anchor weekday (Sunday-Saturday)", () => {
    expect(payPeriodOf("2025-03-05", { type: "weekly", anchor: "2025-01-05" })).toMatchObject({ start: "2025-03-02", end: "2025-03-08" });
  });
  it("normalizes a bad setting to the default", () => {
    expect(normalizePayConfig(undefined)).toEqual(DEFAULT_PAY);
    expect(normalizePayConfig({ type: "monthly", anchor: "nope" })).toEqual(DEFAULT_PAY);
    expect(normalizePayConfig({ type: "biweekly", anchor: "2025-02-03" })).toEqual({ type: "biweekly", anchor: "2025-02-03" });
  });
});

describe("csv", () => {
  it("neutralizes formula injection", () => {
    for (const bad of ["=1+1", "+cmd", "-2+3", "@SUM(A1)", "\tx", "\rx", "  =HYPERLINK(1)"]) expect(csvCell(bad)).toBe(`"'${bad}"`);
  });
  it("leaves normal text alone", () => {
    expect(csvCell("Tenue de livres")).toBe('"Tenue de livres"');
    expect(csvCell("a=b")).toBe('"a=b"');
  });
  it("quotes commas, quotes and line breaks", () => {
    expect(csvCell('dit "oui", puis\nnon')).toBe('"dit ""oui"", puis\nnon"');
  });
  it("writes numbers and empty values", () => {
    expect(csvCell(90)).toBe("90");
    expect(csvCell(null)).toBe('""');
    expect(csvCell(undefined)).toBe('""');
  });
  it("builds rows with a BOM and CRLF", () => {
    expect(csvRow(["a", 1, "=x"])).toBe(`"a",1,"'=x"`);
    const t = toCsv([["h1", "h2"], ["é", 2]]);
    expect(t.charCodeAt(0)).toBe(0xfeff);
    expect(t).toBe('﻿"h1","h2"\r\n"é",2\r\n');
  });
});
