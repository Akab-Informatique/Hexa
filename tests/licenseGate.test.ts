import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const lic = vi.hoisted(() => ({ status: { usable: true } as { usable: boolean; reason?: string } }));
vi.mock("../apps/instance/src/license.ts", () => ({ status: () => lic.status }));

import { licenseGate, isGatedPath } from "../apps/instance/src/licenseGate.ts";

function appWithGate() {
  const app = new Hono();
  app.use("/api/*", licenseGate);
  for (const p of ["/api/health", "/api/config", "/api/auth/me", "/api/auth/logout", "/api/ping", "/api/auth/login", "/api/modules/x", "/api/clients"]) {
    app.get(p, (c) => c.json({ ok: true }));
    app.post(p, (c) => c.json({ ok: true }));
  }
  return app;
}

describe("licenseGate", () => {
  beforeEach(() => {
    lic.status = { usable: true };
  });

  it("lets everything through while the license is usable", async () => {
    const app = appWithGate();
    expect((await app.request("/api/clients")).status).toBe(200);
    expect((await app.request("/api/auth/login", { method: "POST" })).status).toBe(200);
  });

  it("refuses API calls with 402 and a stable body when suspended", async () => {
    lic.status = { usable: false, reason: "suspended" };
    const app = appWithGate();
    const res = await app.request("/api/clients");
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({
      error: "license",
      reason: "suspended",
      message: "Service suspendu. Contactez votre fournisseur.",
    });
  });

  it("passes the allow-list even when suspended", async () => {
    lic.status = { usable: false, reason: "expired" };
    const app = appWithGate();
    for (const p of ["/api/health", "/api/config", "/api/auth/me", "/api/auth/logout", "/api/ping"]) {
      expect((await app.request(p)).status, p).toBe(200);
    }
  });

  it("blocks sign-in when suspended", async () => {
    lic.status = { usable: false, reason: "suspended" };
    const app = appWithGate();
    const res = await app.request("/api/auth/login", { method: "POST" });
    expect(res.status).toBe(402);
    expect((await res.json()).reason).toBe("suspended");
  });

  it("ignores paths outside /api/", () => {
    expect(isGatedPath("/")).toBe(false);
    expect(isGatedPath("/assets/app.js")).toBe(false);
    expect(isGatedPath("/api/config/")).toBe(false);
  });
});
