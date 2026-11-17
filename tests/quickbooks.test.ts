import { describe, expect, it } from "vitest";
import { backoffMs, cleanName, faultCode, money, qEscape, requestIdFor, retryable, tokenFresh } from "../apps/instance/src/lib/quickbooks.ts";

describe("QuickBooks helpers", () => {
  it("escapes quotes and backslashes in query literals", () => {
    expect(qEscape("O'Brien")).toBe("O\\'Brien");
    expect(qEscape("x' or Id > '0")).toBe("x\\' or Id > \\'0");
    expect(qEscape("a\\'b")).toBe("a\\\\\\'b"); // a trailing backslash cannot swallow the closing quote
  });
  it("cleans customer names", () => {
    expect(cleanName("A: B\tC\nD")).toBe("A B C D");
    expect(cleanName("x".repeat(150))).toHaveLength(100);
  });
  it("decides when to retry and how long to wait", () => {
    expect([429, 500, 502, 503, 504].every(retryable)).toBe(true);
    expect([400, 401, 404, 422, 200].some(retryable)).toBe(false);
    expect(backoffMs(0, null, 0)).toBe(500);
    expect(backoffMs(2, null, 0)).toBe(2000);
    expect(backoffMs(0, "3")).toBe(3000);
    expect(backoffMs(0, "999")).toBe(10_000);
    expect(backoffMs(1, "junk", 0)).toBe(1000);
  });
  it("knows when the access token needs a refresh", () => {
    expect(tokenFresh(String(10_000 + 61_000), 10_000)).toBe(true);
    expect(tokenFresh(String(10_000 + 59_000), 10_000)).toBe(false);
    expect(tokenFresh(undefined, 10_000)).toBe(false);
    expect(tokenFresh("abc", 10_000)).toBe(false);
  });
  it("gives the same request id for the same invoice and another for a changed one", () => {
    const a = requestIdFor("invoice", "F-1", { x: 1 });
    expect(requestIdFor("invoice", "F-1", { x: 1 })).toBe(a);
    expect(requestIdFor("invoice", "F-1", { x: 2 })).not.toBe(a);
    expect(a.length).toBeLessThanOrEqual(50);
  });
  it("rounds line amounts half-up to the cent", () => {
    expect(money(1, 1.005)).toBe(1.01);
    expect(money(2.5, 133.33)).toBe(333.33);
    expect(money(0.1, 0.2)).toBe(0.02);
  });
  it("maps Intuit faults to stable codes", () => {
    expect(faultCode(400, { code: "610" })).toBe("not_found");
    expect(faultCode(400, { code: "6240" })).toBe("qb_duplicate");
    expect(faultCode(400, { code: "5010" })).toBe("qb_stale");
    expect(faultCode(401)).toBe("qb_auth");
    expect(faultCode(429)).toBe("qb_throttled");
    expect(faultCode(400, { code: "2020" })).toBe("qb_validation");
    expect(faultCode(500)).toBe("quickbooks_error");
  });
});
