import { describe, expect, it } from "vitest";
import { fill, nextRun, planCustom, type CustomRule } from "../apps/instance/src/lib/customRulesPlan.ts";
import type { ClientRow } from "../apps/instance/src/lib/autoTasksPlan.ts";

const rule = (o: Partial<CustomRule> = {}): CustomRule => ({
  id: "r1", name: "R", enabled: true, titleTemplate: "{client} — {period}", descriptionTemplate: "", bullets: [], cadence: "monthly", weekday: null, dayOfMonth: 1, month: null,
  dueAfterDays: null, dueDayOfMonth: null, scope: "all", scopeClassKey: null, clientIds: [], assigneeMode: "resource", assigneeUserId: null, ...o,
});
const client = (o: Partial<ClientRow> = {}): ClientRow => ({ id: "c1", name: "Acme", ...o });
const plan = (r: CustomRule[], today: string, c: ClientRow[] = [client()]) => planCustom(r, c, today);

describe("cadences", () => {
  it("weekly: the weekday of this week, period = Monday, catches up later in the week", () => {
    const r = rule({ cadence: "weekly", weekday: 3, dayOfMonth: null });
    expect(plan([r], "2026-11-10")).toEqual([]);            // Tuesday, Wednesday not yet
    const [t] = plan([r], "2026-11-12");                    // Thursday: caught up
    expect(t).toMatchObject({ rule: "custom:r1", period: "2026-11-09", start: "2026-11-11", title: "Acme — semaine du 2026-11-09" });
    expect(plan([r], "2026-11-16")).toEqual([]);            // next Monday: Wednesday not reached
    expect(plan([r], "2026-11-18")[0]).toMatchObject({ period: "2026-11-16" });
  });
  it("weekly Sunday (7) is the end of the week", () => {
    const r = rule({ cadence: "weekly", weekday: 7, dayOfMonth: null });
    expect(plan([r], "2026-11-14")).toEqual([]);
    expect(plan([r], "2026-11-15")[0]).toMatchObject({ start: "2026-11-15", period: "2026-11-09" });
  });
  it("monthly: on the day or later in the month, period YYYY-MM, once per month key", () => {
    const r = rule({ dayOfMonth: 15 });
    expect(plan([r], "2026-11-14")).toEqual([]);
    expect(plan([r], "2026-11-15")[0]).toMatchObject({ period: "2026-11", start: "2026-11-15", title: "Acme — novembre 2026" });
    expect(plan([r], "2026-11-30")[0]).toMatchObject({ period: "2026-11" });
    expect(plan([r], "2026-12-15")[0]).toMatchObject({ period: "2026-12" });
  });
  it("day 31 is the last day: 30-day month, 31-day month, Feb, leap Feb", () => {
    const r = rule({ dayOfMonth: 31 });
    expect(plan([r], "2026-11-29")).toEqual([]);
    expect(plan([r], "2026-11-30")[0]).toMatchObject({ start: "2026-11-30" });
    expect(plan([r], "2026-12-30")).toEqual([]);
    expect(plan([r], "2026-12-31")[0]).toMatchObject({ start: "2026-12-31" });
    expect(plan([r], "2027-02-28")[0]).toMatchObject({ start: "2027-02-28" });
    expect(plan([r], "2028-02-28")).toEqual([]);
    expect(plan([r], "2028-02-29")[0]).toMatchObject({ start: "2028-02-29" });
  });
  it("quarterly: month of the quarter, period YYYY-Qn", () => {
    const r = rule({ cadence: "quarterly", dayOfMonth: 10, month: 1 });
    expect(plan([r], "2026-11-12")).toEqual([]);            // Q4 starts in October: window (30 days) already over
    expect(plan([r], "2026-10-12")[0]).toMatchObject({ period: "2026-Q4", start: "2026-10-10", title: "Acme — T4 2026" });
    expect(plan([r], "2027-01-10")[0]).toMatchObject({ period: "2027-Q1" });
    const r2 = rule({ cadence: "quarterly", dayOfMonth: 5, month: 2 });
    expect(plan([r2], "2026-11-05")[0]).toMatchObject({ period: "2026-Q4", start: "2026-11-05" });
  });
  it("yearly: the chosen month and day, period YYYY, never months later", () => {
    const r = rule({ cadence: "yearly", month: 11, dayOfMonth: 20 });
    expect(plan([r], "2026-11-19")).toEqual([]);
    expect(plan([r], "2026-11-20")[0]).toMatchObject({ period: "2026", start: "2026-11-20", title: "Acme — 2026" });
    expect(plan([r], "2026-12-25")).toEqual([]);            // outside the 30-day window
    expect(plan([rule({ cadence: "yearly", month: 3, dayOfMonth: 1 })], "2026-11-11")).toEqual([]);   // March is in the past
  });
  it("incomplete rules plan nothing", () => {
    expect(plan([rule({ cadence: "weekly", weekday: null })], "2026-11-11")).toEqual([]);
    expect(plan([rule({ cadence: "yearly", month: null })], "2026-11-11")).toEqual([]);
    expect(plan([rule({ dayOfMonth: null })], "2026-11-11")).toEqual([]);
  });
});

describe("due dates", () => {
  it("days after the start", () => {
    expect(plan([rule({ dayOfMonth: 1, dueAfterDays: 10 })], "2026-11-03")[0]).toMatchObject({ start: "2026-11-01", due: "2026-11-11" });
  });
  it("no due setting: due the same day as the start", () => {
    expect(plan([rule({ dayOfMonth: 1 })], "2026-11-03")[0]).toMatchObject({ due: "2026-11-01" });
  });
  it("a given day of the month: same month, next month when already past, 31 = last day", () => {
    expect(plan([rule({ dayOfMonth: 1, dueDayOfMonth: 20 })], "2026-11-03")[0]).toMatchObject({ due: "2026-11-20" });
    expect(plan([rule({ dayOfMonth: 25, dueDayOfMonth: 5 })], "2026-11-25")[0]).toMatchObject({ due: "2026-12-05" });
    expect(plan([rule({ dayOfMonth: 1, dueDayOfMonth: 31 })], "2026-11-03")[0]).toMatchObject({ due: "2026-11-30" });
    expect(plan([rule({ dayOfMonth: 25, dueDayOfMonth: 31 })], "2028-02-25")[0]).toMatchObject({ due: "2028-02-29" });
    expect(plan([rule({ dayOfMonth: 31, dueDayOfMonth: 15 })], "2026-12-31")[0]).toMatchObject({ due: "2027-01-15" });
  });
  it("never created once its due date is past", () => {
    expect(plan([rule({ dayOfMonth: 1, dueAfterDays: 5 })], "2026-11-07")).toEqual([]);
    expect(plan([rule({ dayOfMonth: 1, dueAfterDays: 5 })], "2026-11-06")).toHaveLength(1);
  });
});

describe("scope and assignee", () => {
  const clients = [client({ id: "a", name: "A", class_key: "gold", resource_id: "u1" }), client({ id: "b", name: "B", class_key: "silver", resource_id: "u2" }), client({ id: "c", name: "C" })];
  it("all clients", () => expect(plan([rule()], "2026-11-03", clients).map((t) => t.clientId)).toEqual(["a", "b", "c"]));
  it("one class", () => {
    expect(plan([rule({ scope: "class", scopeClassKey: "gold" })], "2026-11-03", clients).map((t) => t.clientId)).toEqual(["a"]);
    expect(plan([rule({ scope: "class", scopeClassKey: null })], "2026-11-03", clients)).toEqual([]);
  });
  it("selected clients only", () => {
    expect(plan([rule({ scope: "clients", clientIds: ["b", "zzz"] })], "2026-11-03", clients).map((t) => t.clientId)).toEqual(["b"]);
    expect(plan([rule({ scope: "clients", clientIds: [] })], "2026-11-03", clients)).toEqual([]);
  });
  it("assignee: client's resource, a fixed user, nobody", () => {
    expect(plan([rule()], "2026-11-03", clients).map((t) => t.assigneeId)).toEqual(["u1", "u2", null]);
    expect(plan([rule({ assigneeMode: "user", assigneeUserId: "u9" })], "2026-11-03", clients).map((t) => t.assigneeId)).toEqual(["u9", "u9", "u9"]);
    expect(plan([rule({ assigneeMode: "none" })], "2026-11-03", clients).map((t) => t.assigneeId)).toEqual([null, null, null]);
  });
  it("disabled rules create nothing", () => expect(plan([rule({ enabled: false })], "2026-11-03", clients)).toEqual([]));
  it("carries bullets and the custom tags and rule key", () => {
    const [t] = plan([rule({ id: "abc", bullets: ["x", "y"] })], "2026-11-03");
    expect(t).toMatchObject({ rule: "custom:abc", bullets: ["x", "y"], tags: ["auto", "automatisation"] });
  });
});

describe("templates", () => {
  const vars = { client: "Acme", period: "novembre 2026", month: "novembre", year: "2026" };
  it("replaces the four placeholders", () => expect(fill("{client} / {period} / {month} / {year}", vars)).toBe("Acme / novembre 2026 / novembre / 2026"));
  it("leaves unknown or malformed placeholders alone", () => expect(fill("{foo} {client {year", vars)).toBe("{foo} {client {year"));
  it("does not re-scan substituted values (a client named {year})", () => expect(fill("{client}", { ...vars, client: "{year}" })).toBe("{year}"));
  it("does not evaluate anything", () => expect(fill("${1+1} {{client}} constructor", vars)).toBe("${1+1} {Acme} constructor"));
  it("fills title and description from the occurrence", () => {
    const [t] = plan([rule({ titleTemplate: "Bilan {month} {year} — {client}", descriptionTemplate: "Période : {period}" })], "2026-11-03");
    expect(t).toMatchObject({ title: "Bilan novembre 2026 — Acme", description: "Période : novembre 2026" });
  });
});

describe("nextRun", () => {
  it("finds the next start day", () => {
    expect(nextRun(rule({ dayOfMonth: 15 }), "2026-11-20")).toBe("2026-12-15");
    expect(nextRun(rule({ cadence: "weekly", weekday: 1, dayOfMonth: null }), "2026-11-11")).toBe("2026-11-16");
    expect(nextRun(rule({ cadence: "yearly", month: 3, dayOfMonth: 1 }), "2026-11-11")).toBe("2027-03-01");
    expect(nextRun(rule({ cadence: "weekly", weekday: null }), "2026-11-11")).toBeNull();
  });
});
