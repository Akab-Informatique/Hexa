import { describe, expect, it } from "vitest";
import { planFrom, type ClientRow, type DoneFiling } from "../apps/instance/src/lib/autoTasksPlan.ts";

const client = (o: Partial<ClientRow> = {}): ClientRow => ({ id: "c1", name: "Acme", ...o });
const plan = (clients: ClientRow[], today: string, doneFilings: DoneFiling[] = []) => planFrom({ clients, doneFilings }, today);
const rules = (p: ReturnType<typeof plan>) => p.map((t) => t.rule);

describe("taxes", () => {
  it("monthly client: previous month, due last day of this month", () => {
    const [t, ...rest] = plan([client({ tax_frequency: "monthly", resource_id: "r1" })], "2026-11-01");
    expect(rest).toEqual([]);
    expect(t).toMatchObject({ rule: "tax", period: "2026-10", title: "Taxes octobre 2026 — Acme", start: "2026-11-01", due: "2026-11-30", assigneeId: "r1", bullets: [] });
  });
  it("quarterly client: Oct period is created on Nov 1, due Nov 30", () => {
    const [t] = plan([client({ tax_frequency: "quarterly" })], "2026-11-01");
    expect(t).toMatchObject({ rule: "tax", period: "2026-10", due: "2026-11-30" });
  });
  it("quarterly client: only Jan/Apr/Jul/Oct periods", () => {
    expect(plan([client({ tax_frequency: "quarterly" })], "2026-12-01")).toEqual([]);
    expect(plan([client({ tax_frequency: "quarterly" })], "2027-01-04")).toEqual([]);
    for (const [today, period] of [["2027-02-01", "2027-01"], ["2026-05-01", "2026-04"], ["2026-08-03", "2026-07"]]) {
      expect(plan([client({ tax_frequency: "quarterly" })], today!)[0]).toMatchObject({ rule: "tax", period });
    }
  });
  it("monthly client on Jan 4 2027: period Dec 2026, due Jan 31", () => {
    const [t] = plan([client({ tax_frequency: "monthly" })], "2027-01-04");
    expect(t).toMatchObject({ period: "2026-12", title: "Taxes décembre 2026 — Acme", start: "2027-01-01", due: "2027-01-31" });
  });
  it("skipped when the previous period box is done or na, not when open", () => {
    const c = [client({ tax_frequency: "monthly" })];
    const f = (status: string): DoneFiling => ({ client_id: "c1", kind: "tax", period: "2026-10", item: "", status });
    expect(plan(c, "2026-11-01", [f("done")])).toEqual([]);
    expect(plan(c, "2026-11-01", [f("na")])).toEqual([]);
    expect(rules(plan(c, "2026-11-01", [f("open")]))).toEqual(["tax"]);
    expect(rules(plan(c, "2026-11-01", [{ ...f("done"), period: "2026-09" }]))).toEqual(["tax"]);
    expect(rules(plan(c, "2026-11-01", [{ ...f("done"), client_id: "other" }]))).toEqual(["tax"]);
  });
});

describe("DAS", () => {
  const das = (das_filer: string, today = "2026-11-01") => plan([client({ das_filer })], today);
  it("us: three bullets, due the 15th", () => {
    const [t, ...rest] = das("us");
    expect(rest).toEqual([]);
    expect(t).toMatchObject({ rule: "das", period: "2026-10", title: "DAS octobre 2026 — Acme", start: "2026-11-01", due: "2026-11-15", bullets: ["Fédéral", "Québec", "CCQ"] });
  });
  it("them_ccq_us: CCQ only", () => expect(das("them_ccq_us")[0]).toMatchObject({ rule: "das", bullets: ["CCQ"], due: "2026-11-15" }));
  it("them or empty: nothing", () => {
    expect(das("them")).toEqual([]);
    expect(das("")).toEqual([]);
  });
  it("custom label: nothing (not the firm's)", () => expect(das("Comptable externe")).toEqual([]));
  it("drops bullets already done/na, and the task when all are", () => {
    const f = (item: string, status = "done"): DoneFiling => ({ client_id: "c1", kind: "das", period: "2026-10", item, status });
    const c = [client({ das_filer: "us" })];
    expect(plan(c, "2026-11-01", [f("fed"), f("prov", "na")])[0]!.bullets).toEqual(["CCQ"]);
    expect(plan(c, "2026-11-01", [f("fed"), f("prov"), f("ccq")])).toEqual([]);
  });
});

describe("payroll", () => {
  const pay = (payroll_period: string, today: string) => plan([client({ payroll_period })], today);
  it("weekly: every Monday, due Thursday", () => {
    const [t, ...rest] = pay("weekly", "2026-01-12");
    expect(rest).toEqual([]);
    expect(t).toMatchObject({ rule: "payroll", period: "2026-01-12", title: "Paie — Acme", start: "2026-01-12", due: "2026-01-15" });
    expect(pay("weekly", "2026-01-13")[0]).toMatchObject({ period: "2026-01-12", due: "2026-01-15" });
  });
  it("biweekly: every second Monday counted from 2026-01-05", () => {
    expect(pay("biweekly", "2026-01-05")[0]).toMatchObject({ period: "2026-01-05", due: "2026-01-08" });
    expect(pay("biweekly", "2026-01-12")).toEqual([]);
    expect(pay("biweekly", "2026-01-19")[0]).toMatchObject({ period: "2026-01-19", due: "2026-01-22" });
    expect(pay("biweekly", "2026-01-26")).toEqual([]);
  });
  it("no payroll configured: nothing", () => expect(pay("", "2026-01-12")).toEqual([]));
});

describe("year-end", () => {
  const ye = (fiscal_month: number, today: string) => plan([client({ fiscal_month })], today);
  it("month 7: verification Aug 1, file task Sep 1 due Jan 31", () => {
    const [v, ...r1] = ye(7, "2026-08-01");
    expect(r1).toEqual([]);
    expect(v).toMatchObject({ rule: "ye_verify", period: "2026", title: "Vérification de fin d'année (juillet 2026) — Acme", start: "2026-08-01", due: "2026-08-31" });
    expect(v!.description).toContain("31 juillet 2026");
    const [f, ...r2] = ye(7, "2026-09-01");
    expect(r2).toEqual([]);
    expect(f).toMatchObject({ rule: "ye_file", period: "2026", title: "Dossier de fin d'année (juillet 2026) — Acme", start: "2026-09-01", due: "2027-01-31" });
  });
  it("month 7: nothing in other months", () => expect(ye(7, "2026-10-01")).toEqual([]));
  it("month 12: rolls into next year", () => {
    expect(ye(12, "2026-12-01")).toEqual([]);
    expect(ye(12, "2027-01-04")[0]).toMatchObject({ rule: "ye_verify", period: "2026", title: "Vérification de fin d'année (décembre 2026) — Acme", start: "2027-01-01", due: "2027-01-31" });
    expect(ye(12, "2027-02-01")[0]).toMatchObject({ rule: "ye_file", period: "2026", start: "2027-02-01", due: "2027-06-30" });
  });
  it("month 11: verification Dec 1, file task Jan 1 due May 31", () => {
    expect(ye(11, "2026-12-01")[0]).toMatchObject({ rule: "ye_verify", period: "2026", due: "2026-12-31" });
    const jan = ye(11, "2027-01-01");
    expect(jan.find((t) => t.rule === "ye_file")).toMatchObject({ period: "2026", title: "Dossier de fin d'année (novembre 2026) — Acme", start: "2027-01-01", due: "2027-05-31" });
  });
});

describe("T4 / RL-1", () => {
  const slips = (o: Partial<ClientRow>, today: string) => plan([client(o)], today);
  it("January 1 2027: due Feb 28, one bullet per slip that is on", () => {
    const [t, ...rest] = slips({ t4_on: true, rl1_on: true }, "2027-01-01");
    expect(rest).toEqual([]);
    expect(t).toMatchObject({ rule: "t4rl1", period: "2026", title: "T4 / RL-1 2026 — Acme", start: "2027-01-01", due: "2027-02-28", bullets: ["T4", "RL-1"] });
  });
  it("leap year: due Feb 29 2028", () => expect(slips({ rl1_on: true }, "2028-01-01")[0]).toMatchObject({ due: "2028-02-29", bullets: ["RL-1"] }));
  it("T4A bullet only when on", () => {
    expect(slips({ t4_on: true, t4a_on: true }, "2027-01-04")[0]!.bullets).toEqual(["T4", "T4A"]);
    expect(slips({ t4_on: true }, "2027-01-04")[0]!.bullets).toEqual(["T4"]);
  });
  it("only in January, and nothing without a slip", () => {
    expect(slips({ t4_on: true, rl1_on: true }, "2027-02-01")).toEqual([]);
    expect(slips({}, "2027-01-01")).toEqual([]);
  });
});

describe("unconfigured clients", () => {
  it("creates nothing for a client with no tracking settings", () => {
    for (const today of ["2026-11-01", "2026-12-01", "2027-01-01", "2027-01-04", "2026-08-03"]) {
      expect(plan([client({ tax_frequency: null, das_filer: "", payroll_period: "", fiscal_month: null })], today)).toEqual([]);
    }
  });
  it("inactive clients are filtered out by the query, so an empty list yields nothing", () => expect(plan([], "2026-11-01")).toEqual([]));
});
