import { describe, expect, it } from "vitest";
import { composeEnv } from "../apps/updater/src/composeEnv.ts";

describe("updater compose environment", () => {
  const envFile = "# comment\nAPP_VERSION=0.2.1\nINSTANCE_IMAGE=ghcr.io/x/hexa-instance\nexport APP_PORT=3001\n\nPOSTGRES_PASSWORD='a=b'\n";

  it("drops every key the .env defines, so compose reads the file and not the stale copy loaded at start", () => {
    const base = { APP_VERSION: "0.1.0", INSTANCE_IMAGE: "old", APP_PORT: "3000", POSTGRES_PASSWORD: "old", PATH: "/usr/bin", HOME: "/root", DOCKER_HOST: "unix:///x" };
    const env = composeEnv(base, envFile);
    expect(env.APP_VERSION).toBeUndefined();
    expect(env.INSTANCE_IMAGE).toBeUndefined();
    expect(env.APP_PORT).toBeUndefined();
    expect(env.POSTGRES_PASSWORD).toBeUndefined();
  });

  it("keeps everything else (PATH, HOME, Docker settings)", () => {
    const env = composeEnv({ PATH: "/usr/bin", HOME: "/root", DOCKER_HOST: "unix:///x", APP_VERSION: "0.1.0" }, envFile);
    expect(env).toMatchObject({ PATH: "/usr/bin", HOME: "/root", DOCKER_HOST: "unix:///x" });
  });

  it("does not change the environment it was given", () => {
    const base = { APP_VERSION: "0.1.0" };
    composeEnv(base, envFile);
    expect(base.APP_VERSION).toBe("0.1.0");
  });

  it("copes with an empty file", () => {
    expect(composeEnv({ A: "1" }, "")).toEqual({ A: "1" });
  });
});
