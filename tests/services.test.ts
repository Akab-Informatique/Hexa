import { describe, expect, it } from "vitest";
import { chargesFor, monthlyEquivalentCents, type ServiceLine } from "../packages/shared/src/contractCharges.ts";
import { canAttach, centsToDecimal, chargeKeyText, checkSale, isValidDay, kindFor, lineTotalCents, MAX_LINE_CENTS, parseCents, periodOf, quantityHundredths, typeOf } from "../packages/shared/src/productSale.ts";
import { uuidFromKey } from "../apps/instance/src/lib/billingKeys.ts";

const contract = (o: Partial<{ billingPeriod: "monthly" | "yearly"; startsOn: string; endsOn: string | null }> = {}) => ({ billingPeriod: "monthly" as const, startsOn: "2026-01-01", endsOn: null, ...o });
const line = (o: Partial<ServiceLine> = {}): ServiceLine => ({ id: "l1", name: "Tenue de livres", kind: "monthly", priceCents: 15000, quantity: 1, addedOn: "2026-01-01", ...o });

describe("catalogue type", () => {
  it("maps type and period to the stored kind and back", () => {
    expect(kindFor("product")).toBe("one_time");
    expect(kindFor("recurring", "quarterly")).toBe("quarterly");
    expect(kindFor("recurring")).toBe("monthly");
    expect(typeOf("one_time")).toBe("product");
    expect(typeOf("yearly")).toBe("recurring");
    expect(periodOf("one_time")).toBeNull();
    expect(periodOf("monthly")).toBe("monthly");
  });
  it("inactive or product services cannot be newly attached", () => {
    expect(canAttach({ active: true, kind: "monthly" })).toBe(true);
    expect(canAttach({ active: false, kind: "monthly" })).toBe(false);
    expect(canAttach({ active: true, kind: "one_time" })).toBe(false);
  });
});

describe("cents arithmetic", () => {
  it("formats cents as exact decimals", () => {
    expect(centsToDecimal(15000)).toBe("150.00");
    expect(centsToDecimal(5)).toBe("0.05");
    expect(centsToDecimal(123456)).toBe("1234.56");
    expect(() => centsToDecimal(-1)).toThrow();
    expect(() => centsToDecimal(1.5)).toThrow();
  });
  it("rounds half up with integers", () => {
    expect(lineTotalCents(1999, 100)).toBe(1999);
    expect(lineTotalCents(1999, 250)).toBe(4998);
    expect(lineTotalCents(1, 50)).toBe(1);
    expect(lineTotalCents(1, 49)).toBe(0);
    expect(lineTotalCents(33333, 33)).toBe(11000);
  });
  it("accepts quantities with at most 2 decimals", () => {
    expect(quantityHundredths(1)).toBe(100);
    expect(quantityHundredths(2.5)).toBe(250);
    expect(quantityHundredths(0.07)).toBe(7);
    expect(quantityHundredths(1.005)).toBeNull();
    expect(quantityHundredths(0)).toBeNull();
    expect(quantityHundredths(-1)).toBeNull();
    expect(quantityHundredths(1001)).toBeNull();
    expect(quantityHundredths(Number.NaN)).toBeNull();
    expect(quantityHundredths("2")).toBeNull();
  });
  it("monthly equivalent of quarterly and yearly lines", () => {
    expect(monthlyEquivalentCents([{ kind: "monthly", priceCents: 15000, quantity: 1 }, { kind: "quarterly", priceCents: 30000, quantity: 1 }, { kind: "yearly", priceCents: 120000, quantity: 1 }, { kind: "one_time", priceCents: 99999, quantity: 1 }], "monthly")).toBe(15000 + 10000 + 10000);
  });
});

describe("typed amounts", () => {
  it("parses to integer cents", () => {
    expect(parseCents("150")).toBe(15000);
    expect(parseCents("150.5")).toBe(15050);
    expect(parseCents("1 234,50 $")).toBe(123450);
    expect(parseCents("0.07")).toBe(7);
    expect(parseCents("-5")).toBeNull();
    expect(parseCents("1.234")).toBeNull();
    expect(parseCents("abc")).toBeNull();
    expect(parseCents("")).toBeNull();
    expect(parseCents("2000000")).toBeNull();
  });
});

describe("product sale checks", () => {
  const prod = { active: true, kind: "one_time" as const };
  it("prices a sale: unit x quantity", () => {
    expect(checkSale(prod, 25000, 2)).toEqual({ unitCents: 25000, qtyHundredths: 200, totalCents: 50000 });
  });
  it("refuses inactive services and non-products", () => {
    expect(checkSale({ active: false, kind: "one_time" }, 100, 1)).toEqual({ error: "service_inactive" });
    expect(checkSale({ active: true, kind: "monthly" }, 100, 1)).toEqual({ error: "not_a_product" });
  });
  it("refuses negative, fractional-cent, absurd and zero amounts", () => {
    expect(checkSale(prod, -1, 1)).toEqual({ error: "price_invalid" });
    expect(checkSale(prod, 10.5, 1)).toEqual({ error: "price_invalid" });
    expect(checkSale(prod, 100_000_001, 1)).toEqual({ error: "price_invalid" });
    expect(checkSale(prod, 0, 1)).toEqual({ error: "total_zero" });
    expect(checkSale(prod, 100, -2)).toEqual({ error: "quantity_invalid" });
    expect(checkSale(prod, MAX_LINE_CENTS, 2)).toEqual({ error: "total_too_large" });
    expect(checkSale(prod, MAX_LINE_CENTS, 1)).toMatchObject({ totalCents: MAX_LINE_CENTS });
  });
  it("validates days", () => {
    expect(isValidDay("2026-02-28")).toBe(true);
    expect(isValidDay("2026-02-30")).toBe(false);
    expect(isValidDay("2026-2-3")).toBe(false);
  });
});

describe("recurring charges", () => {
  it("monthly 150 $: one charge per month, full months not prorated", () => {
    const ch = chargesFor(contract(), [line()], "2026-03-15");
    expect(ch.map((c) => [c.date, c.cents, c.prorated])).toEqual([["2026-01-01", 15000, false], ["2026-02-01", 15000, false], ["2026-03-01", 15000, false]]);
  });
  it("a start in mid-month prorates the first month by days, to the cent", () => {
    const [first, second] = chargesFor(contract({ startsOn: "2026-01-01" }), [line({ addedOn: "2026-01-16" })], "2026-02-10");
    expect(first).toMatchObject({ date: "2026-01-16", days: 16, periodDays: 31, cents: Math.round((15000 * 16) / 31), prorated: true });
    expect(second).toMatchObject({ date: "2026-02-01", cents: 15000, prorated: false });
  });
  it("service end date stops the charges and prorates the last month", () => {
    const ch = chargesFor(contract(), [line({ endsOn: "2026-03-10" })], "2026-12-31");
    expect(ch.map((c) => c.date)).toEqual(["2026-01-01", "2026-02-01", "2026-03-01"]);
    expect(ch[2]).toMatchObject({ days: 10, periodDays: 31, cents: Math.round((15000 * 10) / 31) });
  });
  it("contract end date also stops the service", () => {
    expect(chargesFor(contract({ endsOn: "2026-02-28" }), [line()], "2026-12-31")).toHaveLength(2);
  });
  it("nothing before the start date and nothing when the end is before the start", () => {
    expect(chargesFor(contract(), [line({ addedOn: "2026-06-01" })], "2026-05-31")).toEqual([]);
    expect(chargesFor(contract(), [line({ addedOn: "2026-06-01", endsOn: "2026-05-01" })], "2026-12-31")).toEqual([]);
  });
  it("quarterly: one charge per calendar quarter, price per quarter", () => {
    const ch = chargesFor(contract(), [line({ kind: "quarterly", priceCents: 45000 })], "2026-08-01");
    expect(ch.map((c) => [c.date, c.periodEnd, c.cents])).toEqual([["2026-01-01", "2026-03-31", 45000], ["2026-04-01", "2026-06-30", 45000], ["2026-07-01", "2026-09-30", 45000]]);
  });
  it("quarterly starting mid quarter is prorated over the quarter", () => {
    const [first] = chargesFor(contract(), [line({ kind: "quarterly", priceCents: 90000, addedOn: "2026-02-15" })], "2026-03-01");
    expect(first).toMatchObject({ date: "2026-02-15", periodStart: "2026-01-01", periodEnd: "2026-03-31", days: 45, periodDays: 90, cents: 45000, prorated: true });
  });
  it("yearly service: one charge per contract year", () => {
    const ch = chargesFor(contract({ startsOn: "2026-03-01" }), [line({ kind: "yearly", priceCents: 120000, addedOn: "2026-03-01" })], "2027-06-01");
    expect(ch.map((c) => [c.date, c.cents])).toEqual([["2026-03-01", 120000], ["2027-03-01", 120000]]);
  });
  it("quantity multiplies the price", () => {
    expect(chargesFor(contract(), [line({ quantity: 3 })], "2026-01-31")[0]!.cents).toBe(45000);
  });
  it("price override: the line price, not the catalogue, is what is charged", () => {
    expect(chargesFor(contract(), [line({ priceCents: 12345 })], "2026-01-31")[0]!.cents).toBe(12345);
  });
  it("one-time line charges once, on its day", () => {
    const ch = chargesFor(contract(), [line({ kind: "one_time", priceCents: 25000, addedOn: "2026-02-10" })], "2026-12-31");
    expect(ch).toHaveLength(1);
    expect(ch[0]).toMatchObject({ date: "2026-02-10", cents: 25000 });
  });
  it("february leap year period length", () => {
    expect(chargesFor(contract({ startsOn: "2028-02-01" }), [line({ addedOn: "2028-02-15" })], "2028-02-28")[0]).toMatchObject({ days: 15, periodDays: 29 });
  });
});

describe("idempotent charge keys", () => {
  it("running the schedule twice gives the same keys", () => {
    const keys = (until: string) => chargesFor(contract(), [line()], until).map((c) => uuidFromKey(chargeKeyText("k1", c.lineId, c.date)));
    const a = keys("2026-03-31"), b = keys("2026-03-31");
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(3);
    expect(keys("2026-04-30").slice(0, 3)).toEqual(a);
  });
  it("keys are uuids and differ per contract, line and date", () => {
    const k = uuidFromKey(chargeKeyText("k1", "l1", "2026-01-01"));
    expect(k).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(k).not.toBe(uuidFromKey(chargeKeyText("k2", "l1", "2026-01-01")));
    expect(k).not.toBe(uuidFromKey(chargeKeyText("k1", "l2", "2026-01-01")));
    expect(k).not.toBe(uuidFromKey(chargeKeyText("k1", "l1", "2026-02-01")));
  });
  it("sale keys: the same client and key is the same sale, another key is another sale", () => {
    expect(uuidFromKey("product:c1:abcdefgh")).toBe(uuidFromKey("product:c1:abcdefgh"));
    expect(uuidFromKey("product:c1:abcdefgh")).not.toBe(uuidFromKey("product:c1:abcdefgi"));
    expect(uuidFromKey("product:c1:abcdefgh")).not.toBe(uuidFromKey("product:c2:abcdefgh"));
  });
});
