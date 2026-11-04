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
