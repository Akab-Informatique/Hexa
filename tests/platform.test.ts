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
        { id: "acme", name: "Acme's Portal", domain: "portal.acme.com", pinnedVersion: "1.0.0", appPort: 3100, licenseKey: "KEY123", branding: { appName: "Acme's Portal" } },
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
    expect(env).toContain("Acme\u0027s Portal"); // apostrophe escaped inside single-quoted value
    for (const body of Object.values(zip)) expect(strFromU8(body)).not.toMatch(/\{\{\w+\}\}/);
    expect(strFromU8(zip["nexo-acme/nginx/portal.acme.com.conf"]!)).toContain("127.0.0.1:3100");
  });
});
