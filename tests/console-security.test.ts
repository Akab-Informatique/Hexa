import { describe, expect, it } from "vitest";
import { SAFE_EMAIL_RE, csrfViolation, sanitizeName } from "../apps/console/src/security.ts";

const hdr = (o: Record<string, string>) => (n: string) => o[n.toLowerCase()];
const PUB = "https://console.example.com";

describe("sanitizeName", () => {
  it("strips newlines and control chars", () => {
    expect(sanitizeName("Acme\n. /tmp/x\r\n\u0000 inc")).toBe("Acme . /tmp/x inc");
  });
  it("keeps French names", () => {
    expect(sanitizeName("L'Atelier  Dupont & Fils inc.")).toBe("L'Atelier Dupont & Fils inc.");
  });
});

describe("SAFE_EMAIL_RE", () => {
  it("accepts normal, rejects shell metacharacters", () => {
    expect(SAFE_EMAIL_RE.test("a.b+c@firm.ca")).toBe(true);
    expect(SAFE_EMAIL_RE.test("a$(id)@firm.ca")).toBe(false);
    expect(SAFE_EMAIL_RE.test("a`id`@firm.ca")).toBe(false);
  });
});

describe("csrfViolation", () => {
  const json = { "content-type": "application/json", "content-length": "5" };
  it("allows GET and no-Origin JSON writes", () => {
    expect(csrfViolation("GET", hdr({ origin: "https://evil.com" }), PUB)).toBeNull();
    expect(csrfViolation("POST", hdr({ ...json, host: "x" }), PUB)).toBeNull();
  });
  it("allows same-origin and forwarded host", () => {
    expect(csrfViolation("PATCH", hdr({ ...json, host: "localhost:8080", origin: "http://localhost:8080" }), PUB)).toBeNull();
    expect(csrfViolation("POST", hdr({ ...json, host: "internal", "x-forwarded-host": "c.test", origin: "https://c.test" }), PUB)).toBeNull();
  });
  it("refuses cross-origin, cross-site, null origin, text/plain", () => {
    expect(csrfViolation("POST", hdr({ ...json, host: "a", origin: "https://evil.com" }), PUB)).not.toBeNull();
    expect(csrfViolation("POST", hdr({ ...json, "sec-fetch-site": "cross-site" }), PUB)).not.toBeNull();
    expect(csrfViolation("POST", hdr({ ...json, origin: "null" }), PUB)).not.toBeNull();
    expect(csrfViolation("POST", hdr({ "content-type": "text/plain", "content-length": "5" }), PUB)).not.toBeNull();
  });
  it("allows bodyless POST (rotate-key)", () => {
    expect(csrfViolation("POST", hdr({ "content-length": "0" }), PUB)).toBeNull();
  });
});
