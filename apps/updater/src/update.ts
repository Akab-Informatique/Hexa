import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { UpdaterStatus } from "@hexa/shared";
import { getEnv, setEnv } from "./envfile.ts";

const run = promisify(execFile);
const e = process.env;

const COMPOSE_DIR = e.COMPOSE_DIR ?? "/deploy";
const BACKUP_DIR = e.BACKUP_DIR ?? "/backups";
const HEALTH_URL = e.HEALTH_URL ?? "http://app:3000/api/health";
const HEALTH_TIMEOUT_MS = Number(e.HEALTH_TIMEOUT_SECONDS ?? 180) * 1000;
const KEEP_BACKUPS = Number(e.KEEP_BACKUPS ?? 5);
const ENV_FILE = path.join(COMPOSE_DIR, ".env");

let status: UpdaterStatus = { state: "idle" };
export const getStatus = () => status;
const set = (patch: Partial<UpdaterStatus>) => (status = { ...status, ...patch });

const compose = (...args: string[]) =>
  run("docker", ["compose", "--project-directory", COMPOSE_DIR, ...args], { cwd: COMPOSE_DIR, maxBuffer: 20 * 1024 * 1024 });

async function registryLogin(): Promise<void> {
  const { GHCR_USER, GHCR_TOKEN } = e;
  if (!GHCR_USER || !GHCR_TOKEN) return;
  await new Promise<void>((resolve, reject) => {
    const p = spawn("docker", ["login", "ghcr.io", "-u", GHCR_USER, "--password-stdin"]);
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("registry login failed"))));
    p.stdin.end(GHCR_TOKEN);
  });
}

async function backup(version: string): Promise<string> {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const env = fs.readFileSync(ENV_FILE, "utf8");
  const user = getEnv(env, "POSTGRES_USER") ?? "hexa";
  const db = getEnv(env, "POSTGRES_DB") ?? "hexa";
  const file = path.join(BACKUP_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}_v${version}.dump`);
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(file);
    const p = spawn("docker", ["compose", "--project-directory", COMPOSE_DIR, "exec", "-T", "db", "pg_dump", "-U", user, "-Fc", db], { cwd: COMPOSE_DIR });
    p.stdout.pipe(out);
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`pg_dump exited ${code}`))));
  });
  if (fs.statSync(file).size < 100) throw new Error("backup file is empty");
  const all = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith(".dump")).sort();
  for (const old of all.slice(0, Math.max(0, all.length - KEEP_BACKUPS))) fs.rmSync(path.join(BACKUP_DIR, old));
  return file;
}

async function restore(file: string): Promise<void> {
  const env = fs.readFileSync(ENV_FILE, "utf8");
  const user = getEnv(env, "POSTGRES_USER") ?? "hexa";
  const db = getEnv(env, "POSTGRES_DB") ?? "hexa";
  await new Promise<void>((resolve, reject) => {
    const p = spawn("docker", ["compose", "--project-directory", COMPOSE_DIR, "exec", "-T", "db", "pg_restore", "-U", user, "-d", db, "--clean", "--if-exists", "--no-owner"], { cwd: COMPOSE_DIR });
    fs.createReadStream(file).pipe(p.stdin);
    p.on("error", reject);
    // pg_restore exits 1 on harmless warnings (e.g. dropping objects that don't exist).
    p.on("exit", (code) => (code === 0 || code === 1 ? resolve() : reject(new Error(`pg_restore exited ${code}`))));
  });
}

async function waitHealthy(version: string): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let last = "no response";
  while (Date.now() < deadline) {
    try {
      const r = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(5000) });
      const body = (await r.json()) as { ok?: boolean; version?: string };
      if (r.ok && body.ok && body.version === version) return;
      last = `status ${r.status}, version ${body.version}`;
    } catch (err) {
      last = (err as Error).message;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`new version did not become healthy (${last})`);
}

/**
 * Backup -> pull -> restart (the app runs its own migrations on boot) -> health check.
 * On any failure after the switch: put the old image back and restore the database dump,
 * because a half-applied migration may be incompatible with the old code.
 */
export async function applyUpdate(version: string): Promise<void> {
  const original = fs.readFileSync(ENV_FILE, "utf8");
  const from = getEnv(original, "APP_VERSION") ?? "unknown";
  status = { state: "running", from, to: version, step: "starting", startedAt: new Date().toISOString() };
  let dump: string | undefined;
  let switched = false;
  try {
    set({ step: "backing up database" });
    dump = await backup(from);

    set({ step: "pulling new image" });
    await registryLogin();
    fs.writeFileSync(ENV_FILE, setEnv(original, "APP_VERSION", version));
    await compose("pull", "app");

    set({ step: "restarting application" });
    switched = true;
    await compose("up", "-d", "app");

    set({ step: "waiting for health check" });
    await waitHealthy(version);
    set({ state: "success", step: "done", finishedAt: new Date().toISOString() });
  } catch (err) {
    const message = (err as Error).message;
    set({ step: "rolling back", error: message });
    try {
      fs.writeFileSync(ENV_FILE, original);
      if (switched && dump) {
        await compose("stop", "app");
        await restore(dump);
      }
      await compose("up", "-d", "app");
      set({ state: "rolled_back", step: "rolled back", finishedAt: new Date().toISOString() });
    } catch (rollbackErr) {
      set({ state: "failed", error: `${message}; rollback also failed: ${(rollbackErr as Error).message}`, finishedAt: new Date().toISOString() });
    }
  }
}
