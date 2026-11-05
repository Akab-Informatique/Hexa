import { describe, expect, it } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { compareVersions, VERSION_RE } from "@nexo/shared";
import { getEnv, setEnv } from "../apps/updater/src/envfile.ts";
import { decrypt, encrypt } from "../apps/console/src/crypto.ts";
import { buildBundle, newSecrets } from "../apps/console/src/bundle.ts";

describe("versions", () => {
  it("orders semver and pre-releases", () => {
    expect(compareVersions("1.5.0", "1.2.9")).toBeGreaterThan(0);
    expect(compareVersions("1.2.0", "1.2.0")).toBe(0);
    expect(compareVersions("1.2.0-beta.1", "1.2.0")).toBeLessThan(0);
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
  });
  it("rejects unsafe version strings", () => {
    expect(VERSION_RE.test("1.2.3")).toBe(true);
    expect(VERSION_RE.test("1.2.3; rm -rf /")).toBe(false);
    expect(VERSION_RE.test("latest")).toBe(false);
  });
});

describe(".env editing", () => {
  const env = "A=1\nAPP_VERSION=1.0.0\nB=two words\n";
  it("replaces only the target key", () => {
    expect(setEnv(env, "APP_VERSION", "1.1.0")).toBe("A=1\nAPP_VERSION=1.1.0\nB=two words\n");
    expect(getEnv(env, "B")).toBe("two words");
  });
  it("appends a missing key", () => expect(setEnv("A=1", "X", "9")).toBe("A=1\nX=9\n"));
});

describe("console crypto", () => {
  it("round-trips and rejects tampering", () => {
    const secret = "s".repeat(32);
    const enc = encrypt("license-key", secret);
    expect(decrypt(enc, secret)).toBe("license-key");
    expect(() => decrypt(enc, "x".repeat(32))).toThrow();
  });
});

describe("bundle generator", () => {
  it("produces a complete, fully-rendered install package", () => {
    const zip = unzipSync(
      buildBundle(
        { id: "acme", name: "Acme's Portal", domain: "portal.acme.com", pinnedVersion: "1.0.0", appPort: 3100, licenseKey: "KEY123", branding: { appName: "Acme's Portal" }, adminEmail: "boss@acme.com", initialAdminPassword: "pw-pw-pw-pw-pw-pw", appSecret: "s".repeat(48) },
        { templatesDir: "deploy/client-bundle", consoleUrl: "https://console.example.com", instanceImage: "ghcr.io/x/nexo-instance", updaterImage: "ghcr.io/x/nexo-updater", ghcrUser: "u", ghcrToken: "t", secrets: newSecrets() },
      ),
    );
    expect(Object.keys(zip).sort()).toEqual([
      "nexo-acme/.env", "nexo-acme/README.md", "nexo-acme/docker-compose.yml",
      "nexo-acme/install.sh", "nexo-acme/nginx/portal.acme.com.conf",
    ]);
    const env = strFromU8(zip["nexo-acme/.env"]!);
    expect(env).toContain("LICENSE_KEY=KEY123");
    expect(env).toContain("APP_VERSION=1.0.0");
    expect(env).toContain("COMPOSE_PROJECT_NAME=nexo_acme");
    expect(env).toContain("INITIAL_ADMIN_EMAIL=boss@acme.com");
    expect(env).toContain("Acme\u0027s Portal"); // apostrophe escaped inside single-quoted value
    for (const body of Object.values(zip)) expect(strFromU8(body)).not.toMatch(/\{\{\w+\}\}/);
    expect(strFromU8(zip["nexo-acme/nginx/portal.acme.com.conf"]!)).toContain("127.0.0.1:3100");
  });
});

import { effectivePermissions, isKnownPermission, permissionsFor, ungrantable, MODULES } from "@nexo/shared/permissions";
import { hashPassword, verifyPassword, seal, unseal } from "../apps/instance/src/auth/crypto.ts";

describe("permissions", () => {
  const base = { audience: "staff" as const, master: false, groupPermissions: [["tasks.view"], ["tasks.edit", "clients.view"]], allow: [] as string[], deny: [] as string[] };
  it("unions groups, then applies per-user allow and deny (deny wins)", () => {
    expect(effectivePermissions(base)).toEqual(["clients.view", "tasks.edit", "tasks.view"]);
    expect(effectivePermissions({ ...base, allow: ["hr.view"], deny: ["tasks.edit", "hr.view"] })).toEqual(["clients.view", "tasks.view"]);
  });
  it("gives a master user every right of their audience, and never cross-audience rights", () => {
    expect(effectivePermissions({ ...base, master: true })).toEqual(permissionsFor("staff"));
    expect(effectivePermissions({ ...base, audience: "client", groupPermissions: [["tasks.view", "clientportal.view"]] })).toEqual(["clientportal.view"]);
  });
  it("drops unknown keys and prevents privilege escalation", () => {
    expect(isKnownPermission("nope.view")).toBe(false);
    expect(effectivePermissions({ ...base, allow: ["nope.view"] })).not.toContain("nope.view");
    expect(ungrantable(["tasks.view"], false, ["tasks.view", "admin.groups.manage"])).toEqual(["admin.groups.manage"]);
    expect(ungrantable([], true, ["admin.groups.manage"])).toEqual([]);
  });
  it("has unique, well-formed keys", () => {
    const keys = MODULES.flatMap((m) => m.permissions.map((p) => p.key));
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k).toMatch(/^[a-z]+(\.[a-z]+){1,2}$/);
  });
});

describe("instance crypto", () => {
  it("verifies only the right password", async () => {
    const h = await hashPassword("correct horse battery");
    expect(await verifyPassword("correct horse battery", h)).toBe(true);
    expect(await verifyPassword("wrong", h)).toBe(false);
  });
  it("seals and unseals secrets", () => {
    const s = "k".repeat(32);
    expect(unseal(seal("totp-secret", s), s)).toBe("totp-secret");
    expect(() => unseal(seal("x", s), "z".repeat(32))).toThrow();
  });
});

import { computeInvoice, roundCents, addRecurrence, mondayOf } from "@nexo/shared/billing";

describe("billing and dates", () => {
  it("rounds half-up per line so totals match QuickBooks", () => {
    expect(roundCents(1.005)).toBe(1.01);
    const r = computeInvoice([{ quantity: 2, unitPrice: 100.5, taxable: true }, { quantity: 1, unitPrice: 10, taxable: false }], { gst: 5, qst: 9.975 });
    expect(r.subtotal).toBe(211);
    expect(r.gst).toBe(10.05);
    expect(r.qst).toBe(20.05);
    expect(r.total).toBe(241.1);
  });
  it("recurrence keeps month ends valid and finds the week's Monday", () => {
    expect(addRecurrence("2026-01-31", { every: 1, unit: "month" })).toBe("2026-02-28");
    expect(addRecurrence("2026-11-30", { every: 1, unit: "month" })).toBe("2026-12-30");
    expect(addRecurrence("2026-11-04", { every: 2, unit: "week" })).toBe("2026-11-18");
    expect(mondayOf("2026-11-04")).toBe("2026-11-02");
    expect(mondayOf("2026-11-08")).toBe("2026-11-02");
  });
});

import { leadsToAccess, levelOn } from "../apps/instance/src/lib/docRules.ts";
import { cleanPath } from "../apps/instance/src/lib/sharepoint.ts";

describe("documentation folder rules", () => {
  const rules = [{ path: "Acme Corp", level: "view" as const }, { path: "Acme Corp/2025", level: "edit" as const }];
  it("inherits down the tree and takes the highest level", () => {
    expect(levelOn(rules, "Acme Corp")).toBe("view");
    expect(levelOn(rules, "Acme Corp/2024")).toBe("view");
    expect(levelOn(rules, "Acme Corp/2025/T4")).toBe("edit");
    expect(levelOn(rules, "acme corp/2025")).toBe("edit");
  });
  it("gives nothing elsewhere, and a library-root rule covers all", () => {
    expect(levelOn(rules, "Boulangerie Dupont")).toBeNull();
    expect(levelOn(rules, "Acme Corporation")).toBeNull();
    expect(levelOn([{ path: "", level: "view" }], "Any/Thing")).toBe("view");
  });
  it("keeps the way to an allowed folder visible", () => {
    expect(leadsToAccess([{ path: "A/B/C", level: "view" }], "A")).toBe(true);
    expect(leadsToAccess([{ path: "A/B/C", level: "view" }], "A/B")).toBe(true);
    expect(leadsToAccess([{ path: "A/B/C", level: "view" }], "X")).toBe(false);
  });
  it("refuses path traversal", () => {
    expect(cleanPath("/a//b/")).toBe("a/b");
    expect(() => cleanPath("a/../b")).toThrow();
    expect(() => cleanPath("a/b:c")).toThrow();
  });
});

import { accruablePaidMinutes, centsOf, holidayBasisMinutes, holidayPayCents, paidMinutes, workdayMinutes } from "../packages/shared/src/workday.ts";

describe("work day and paid hours", () => {
  it("takes the unpaid half of lunch off only on days of five hours or more without lunch", () => {
    expect(workdayMinutes("08:00", "16:00")).toEqual({ span: 480, lunchTaken: 30, paid: 450 });
    expect(workdayMinutes("08:00", "13:00")?.paid).toBe(300);
    expect(workdayMinutes("08:00", "14:00")?.paid).toBe(330); // 6 h span: 5 h without lunch, so 30 min off
    expect(workdayMinutes("16:00", "08:00")).toBeNull();
    expect(workdayMinutes("8:00", "25:00")).toBeNull();
  });
  it("pays work days less the bank, plus vacation, sick, holiday and payouts", () => {
    const e = [{ kind: "workday" as const, minutes: 450, bankMinutes: 60 }, { kind: "vacation" as const, minutes: 480 }, { kind: "work" as const, minutes: 120 }, { kind: "other" as const, minutes: 60 }];
    expect(paidMinutes(e)).toBe(390 + 480);
    expect(accruablePaidMinutes(e)).toBe(390);
  });
  it("works holiday pay out as a twentieth of four weeks, capped per week", () => {
    const basis = [holidayBasisMinutes([{ kind: "workday", minutes: 3000 }], 40), 1200, 1200, 0];
    expect(basis[0]).toBe(2400);
    expect(holidayPayCents(basis, 3000)).toBe(Math.round(((2400 + 1200 + 1200) / 60) * 3000 / 20));
    expect(centsOf(90, 3000)).toBe(4500);
  });
});

import { chargesFor, monthlyEquivalentCents } from "../packages/shared/src/contractCharges.ts";

describe("contract charge schedule", () => {
  const monthly = { billingPeriod: "monthly" as const, startsOn: "2026-01-10", endsOn: null };
  const svc = { id: "a", name: "Tenue de livres", kind: "monthly" as const, priceCents: 10000, quantity: 1, addedOn: "2026-01-10" };
  it("prorates the first month by days and then charges full months", () => {
    const c = chargesFor(monthly, [svc], "2026-03-31");
    expect(c.map((x) => x.cents)).toEqual([7097, 10000, 10000]); // 22 of 31 days in January
    expect(c[0]).toMatchObject({ date: "2026-01-10", prorated: true, days: 22, periodDays: 31 });
    expect(c[1]).toMatchObject({ date: "2026-02-01", prorated: false });
  });
  it("prorates the last part month when the contract ends inside it", () => {
    const c = chargesFor({ ...monthly, endsOn: "2026-02-14" }, [svc], "2026-12-31");
    expect(c).toHaveLength(2);
    expect(c[1]!.cents).toBe(Math.round((10000 * 14) / 28));
  });
  it("charges a yearly service once per contract year, prorated when added late", () => {
    const y = { id: "b", name: "Déclaration annuelle", kind: "yearly" as const, priceCents: 120000, quantity: 1, addedOn: "2026-07-11" };
    const c = chargesFor(monthly, [y], "2027-12-31");
    expect(c).toHaveLength(2);
    expect(c[0]).toMatchObject({ date: "2026-07-11", prorated: true });
    expect(c[0]!.cents).toBe(Math.round((120000 * c[0]!.days) / c[0]!.periodDays));
    expect(c[1]).toMatchObject({ date: "2027-01-10", cents: 120000, prorated: false });
  });
  it("charges a monthly service of a yearly contract twelve-fold, and a one-time service once", () => {
    const yearly = { billingPeriod: "yearly" as const, startsOn: "2026-01-01", endsOn: null };
    expect(chargesFor(yearly, [{ ...svc, addedOn: "2026-01-01" }], "2026-12-31")[0]!.cents).toBe(120000);
    const once = chargesFor(monthly, [{ ...svc, kind: "one_time" as const, priceCents: 5000, quantity: 2 }], "2030-01-01");
    expect(once).toHaveLength(1);
    expect(once[0]!.cents).toBe(10000);
  });
  it("gives a monthly equivalent for lists", () => {
    expect(monthlyEquivalentCents([{ kind: "monthly", priceCents: 10000, quantity: 2 }, { kind: "yearly", priceCents: 12000, quantity: 1 }, { kind: "one_time", priceCents: 999, quantity: 1 }], "monthly")).toBe(21000);
  });
});

import { aging, dueAfterSent } from "../packages/shared/src/billing.ts";

describe("invoice due day and aging", () => {
  it("counts the due day from the day the invoice is sent: terms + 1", () => {
    expect(dueAfterSent("2026-03-10", 30)).toBe("2026-04-10");
    expect(dueAfterSent("2026-03-10", 0)).toBe("2026-03-11");
    expect(dueAfterSent("2026-12-30", 15)).toBe("2027-01-15");
  });
  it("puts an unpaid invoice in an aging bucket", () => {
    expect(aging("2026-03-10", "2026-03-10")).toEqual({ daysLate: 0, bucket: "notDue" });
    expect(aging("2026-03-10", "2026-03-11").bucket).toBe("d1_30");
    expect(aging("2026-03-10", "2026-04-09").bucket).toBe("d1_30");
    expect(aging("2026-03-10", "2026-04-10").bucket).toBe("d31_60");
    expect(aging("2026-01-01", "2026-04-15").bucket).toBe("d90");
  });
});

import { easterSunday, fridayOf, quebecHolidays } from "../packages/shared/src/billing.ts";

describe("Quebec holidays and the working week", () => {
  it("works out Easter", () => {
    expect(easterSunday(2026)).toBe("2026-04-05");
    expect(easterSunday(2027)).toBe("2027-03-28");
  });
  it("lists the statutory holidays of 2026", () => {
    const h = Object.fromEntries(quebecHolidays(2026).map((x) => [x.fr, x.date]));
    expect(h["Lundi de Pâques"]).toBe("2026-04-06");
    expect(h["Journée nationale des patriotes"]).toBe("2026-05-18");
    expect(h["Fête du Travail"]).toBe("2026-09-07");
    expect(h["Action de grâce"]).toBe("2026-10-12");
    expect(h["Noël"]).toBe("2026-12-25");
  });
  it("finds the Friday that ends the working week (the next one on a weekend)", () => {
    expect(fridayOf("2026-06-02")).toBe("2026-06-05"); // Tuesday
    expect(fridayOf("2026-06-05")).toBe("2026-06-05"); // Friday
    expect(fridayOf("2026-06-06")).toBe("2026-06-12"); // Saturday
    expect(fridayOf("2026-06-07")).toBe("2026-06-12"); // Sunday
  });
});

import { buildForecast, recurrenceDates } from "../packages/shared/src/billing.ts";

describe("recurring payments and the cash forecast", () => {
  it("counts monthly dates from the anchor so the day never drifts", () => {
    expect(recurrenceDates("2026-01-31", "monthly", "2026-01-01", "2026-04-30")).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
    expect(recurrenceDates("2026-01-05", "weekly", "2026-01-10", "2026-01-31")).toEqual(["2026-01-12", "2026-01-19", "2026-01-26"]);
    expect(recurrenceDates("2025-03-01", "yearly", "2026-01-01", "2027-12-31")).toEqual(["2026-03-01", "2027-03-01"]);
  });
  const base = { today: "2026-06-01", days: 10, balanceCents: 100000, payDelayDays: 0, lateDelayDays: 5, bills: [], invoices: [], recurring: [], payrollWeekday: null, payrollWeeklyCents: 0 };
  it("runs the balance day by day: invoices in, bills out", () => {
    const f = buildForecast({ ...base, bills: [{ vendor: "A", dueDate: "2026-06-03", amountCents: 30000 }], invoices: [{ client: "C", dueDate: "2026-06-02", balanceCents: 50000 }] });
    expect(f.rows).toHaveLength(10);
    expect(f.rows[2]!.balanceCents).toBe(70000);
    expect(f.rows[6]!.balanceCents).toBe(120000);
    expect(f.firstShortfall).toBeNull();
  });
  it("counts overdue amounts from today and finds the first shortfall", () => {
    const f = buildForecast({ ...base, balanceCents: 10000, bills: [{ vendor: "Late", dueDate: "2026-05-01", amountCents: 50000 }, { vendor: "None", dueDate: null, amountCents: 1000 }] });
    expect(f.rows[0]!.outCents).toBe(51000);
    expect(f.firstShortfall).toEqual({ date: "2026-06-01", balanceCents: -41000 });
    expect(f.lowest.balanceCents).toBe(-41000);
  });
  it("adds recurring payments and a weekly payroll on its weekday", () => {
    const f = buildForecast({ ...base, days: 14, recurring: [{ label: "Loyer", anchor: "2026-06-05", freq: "weekly", amountCents: 1000 }], payrollWeekday: 4, payrollWeeklyCents: 20000 });
    // 2026-06-05 and 06-12 are Fridays: rent and payroll both fall on them
    expect(f.rows[4]!.items.map((i) => i.kind).sort()).toEqual(["payroll", "recurring"]);
    expect(f.rows[11]!.items.map((i) => i.kind).sort()).toEqual(["payroll", "recurring"]);
    expect(f.endBalanceCents).toBe(100000 - 2 * 21000);
  });
  it("delays payment of bills by the pay delay", () => {
    const f = buildForecast({ ...base, payDelayDays: 3, bills: [{ vendor: "A", dueDate: "2026-06-02", amountCents: 100 }] });
    expect(f.rows[4]!.items.some((i) => i.kind === "bill")).toBe(true);
    expect(f.rows[1]!.items.some((i) => i.kind === "bill")).toBe(false);
  });
});

import { readState, signState } from "../apps/instance/src/lib/oauthState.ts";
import { invoiceMail, boardMail, validEmail } from "../apps/instance/src/lib/mail.ts";
import { normName } from "../apps/instance/src/lib/quickbooks.ts";

describe("integrations helpers", () => {
  it("signs an OAuth state for one person and one provider, valid ten minutes", () => {
    const s = signState("ms", "user-1", 1_000);
    expect(readState("ms", s, 2_000)).toBe("user-1");
    expect(readState("qb", s, 2_000)).toBeNull(); // another provider cannot use it
    expect(readState("ms", s, 1_000 + 11 * 60_000)).toBeNull(); // expired
    expect(readState("ms", s.slice(0, -2) + "xx", 2_000)).toBeNull(); // tampered
    expect(readState("ms", "garbage", 2_000)).toBeNull();
  });
  it("checks email addresses", () => {
    expect(validEmail("a@b.co")).toBe(true);
    expect(validEmail("not an email")).toBe(false);
    expect(validEmail(null)).toBe(false);
  });
  it("writes invoice emails in both languages and escapes client text", () => {
    const d = { firm: "Acme <b>", number: "F-1001", client: "A & B", total: 114.98, balance: 100, issueDate: "2026-01-05", dueDate: "2026-02-04", poNumber: "PO-7", daysLate: 12 };
    const fr = invoiceMail(d, "fr", "reminder");
    expect(fr.subject).toContain("Rappel");
    expect(fr.subject).toContain("12");
    expect(fr.html).toContain("A &amp; B");
    expect(fr.html).toContain("Acme &lt;b&gt;");
    expect(fr.text).toContain("Solde dû");
    expect(invoiceMail(d, "en", "sent").subject).toBe("Invoice F-1001");
    expect(boardMail("Acme", "Titre <x>", "ligne1\nligne2", "fr").html).toContain("ligne1<br>ligne2");
  });
  it("matches company names ignoring case, accents and legal endings", () => {
    expect(normName("Boulangerie Dupont inc.")).toBe(normName("BOULANGERIE DUPONT"));
    expect(normName("Café Le Matin")).toBe(normName("Cafe le matin"));
    expect(normName("Autre Client Ltée")).toBe("autre client");
  });
});
