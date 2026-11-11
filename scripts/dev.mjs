// Local look-and-feel stack with NO Docker/Postgres: embedded PGlite databases + console + instance.
//   npm run dev        -> console http://localhost:8080 (admin / admin)   instance http://localhost:3000
// Data persists in .data/ (delete it to reset). Dev only: never used in production images.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { unzipSync, strFromU8 } from "fflate";

// Another app on the machine may already hold a port (e.g. camera software on 8080): take the next free one.
const inUse = (port) =>
  new Promise((resolve) => {
    const s = net.connect({ port, host: "127.0.0.1" });
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => resolve(false));
  });
async function freePort(preferred, avoid = []) {
  for (let p = preferred; p < preferred + 50; p++) {
    if (!avoid.includes(p) && !(await inUse(p))) {
      if (p !== preferred) console.log(`[dev] port ${preferred} is taken, using ${p}`);
      return p;
    }
  }
  throw new Error(`no free port near ${preferred}`);
}

const CONSOLE_PORT = await freePort(8080);
const SITE_PORT = await freePort(8081, [CONSOLE_PORT]);
const INSTANCE_PORT = 3000;
const auth = "Basic " + Buffer.from("admin:admin").toString("base64");
const children = [];

async function startDb(name, port) {
  fs.mkdirSync(`.data/${name}`, { recursive: true });
  const db = await PGlite.create(`.data/${name}`);
  const server = new PGLiteSocketServer({ db, port, host: "127.0.0.1", maxConnections: 20 });
  await server.start();
  console.log(`[dev] ${name} database on :${port}`);
}

function run(name, file, env) {
  const p = spawn(process.execPath, ["--import", "tsx", file], { env: { ...process.env, ...env }, stdio: "inherit" });
  p.on("exit", (code) => console.log(`[dev] ${name} exited (${code})`));
  children.push(p);
}

async function waitFor(url, label) {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${label} did not start`);
}

const api = (path, body) =>
  fetch(`http://127.0.0.1:${CONSOLE_PORT}${path}`, {
    method: "POST", headers: { authorization: auth, "content-type": "application/json" }, body: JSON.stringify(body),
  });

await startDb("dev-console", 5433);
await startDb("dev-instance", 5434);

run("console", "apps/console/src/index.ts", {
  PORT: String(CONSOLE_PORT),
  DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5433/postgres",
  ADMIN_PASSWORD: "admin",
  CONSOLE_SECRET: "dev-secret-dev-secret-dev-secret-00",
  PUBLIC_URL: `http://127.0.0.1:${CONSOLE_PORT}`,
});
await waitFor(`http://127.0.0.1:${CONSOLE_PORT}/api/ping`, "console");

// Seed: two releases and a demo client pinned to the newer one, so the "Update available" card shows.
await api("/api/releases", { version: "0.1.0", notes: "First release" });
await api("/api/releases", { version: "0.2.0", notes: "Demo update" });
await api("/api/clients", {
  id: "demo", name: "A Bezeau", domain: "portal.abezeau.test", adminEmail: "admin@abezeau.test", seedProfile: "accounting", pinnedVersion: "0.2.0",
  maxUsers: 25, modules: ["example-hello"],
  // Deliberately not Hexa's purple/blue: this is how a different firm's theme looks. For a real firm the client
  // chooses these; here they follow abezeau.com (burgundy and warm sand) and its white logo, for testing only.
  branding: { appName: "A Bezeau", primaryColor: "#942e2d", accentColor: "#c8a47e", logoUrl: "https://abezeau.com/wp-content/uploads/sites/103/2026/02/Components.png" },
});

// Use the real generated bundle to get this client's credentials (exercises the bundle generator too).
const zipRes = await fetch(`http://127.0.0.1:${CONSOLE_PORT}/api/clients/demo/bundle`, { headers: { authorization: auth } });
const files = unzipSync(new Uint8Array(await zipRes.arrayBuffer()));
const envText = strFromU8(files["hexa-demo/.env"]);
const get = (k) => envText.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1];

// Local stand-in for Mailjet, Microsoft and Intuit, so the integrations can be tried without any account.
run("mock-services", "scripts/mock-services.mjs", {});
await waitFor("http://127.0.0.1:9099/_mock/mail", "mock services");

run("instance", "apps/instance/src/index.ts", {
  PUBLIC_URL: "http://localhost:5173", // where the browser reaches the app: OAuth sign-ins come back here
  MAILJET_URL: "http://127.0.0.1:9099", GRAPH_URL: "http://127.0.0.1:9099/graph/v1.0", MS_LOGIN_URL: "http://127.0.0.1:9099/mslogin",
  INTUIT_AUTH_URL: "http://127.0.0.1:9099/intuit/connect/oauth2", INTUIT_TOKEN_URL: "http://127.0.0.1:9099/intuit/oauth2/v1/tokens/bearer", QBO_API_URL: "http://127.0.0.1:9099/qbo",
  PORT: String(INSTANCE_PORT),
  DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5434/postgres",
  CLIENT_ID: get("CLIENT_ID"),
  LICENSE_KEY: get("LICENSE_KEY"),
  CONSOLE_URL: `http://127.0.0.1:${CONSOLE_PORT}`,
  APP_VERSION: "0.1.0",
  INITIAL_ADMIN_EMAIL: get("INITIAL_ADMIN_EMAIL"),
  INITIAL_ADMIN_PASSWORD: get("INITIAL_ADMIN_PASSWORD"),
  APP_SECRET: get("APP_SECRET"),
  DEV_ORIGINS: "http://localhost:5173,http://127.0.0.1:5173",
  SEED_PROFILE: "accounting", // demo data for the A Bezeau demo tenant (the console puts this in real bundles)
  SHAREPOINT_MOCK: "1", // local stand-in for SharePoint (never honored in production)
});
await waitFor(`http://127.0.0.1:${INSTANCE_PORT}/api/health`, "instance");

// Web app (Vite dev server, proxies /api to the instance) and the marketing page (static).
const viteBin = "apps/web/node_modules/vite/bin/vite.js";
const vite = spawn(process.execPath, [fs.existsSync(viteBin) ? path.resolve(viteBin) : path.resolve("node_modules/vite/bin/vite.js")], {
  cwd: "apps/web", stdio: "inherit", env: { ...process.env, API_URL: `http://127.0.0.1:${INSTANCE_PORT}` },
});
children.push(vite);
http.createServer((req, res) => {
  const js = req.url === "/config.js";
  res.writeHead(200, { "content-type": js ? "text/javascript" : "text/html; charset=utf-8" });
  res.end(fs.readFileSync(js ? "apps/site/config.js" : "apps/site/index.html"));
}).listen(SITE_PORT, "127.0.0.1");
await waitFor("http://localhost:5173/", "web app");

console.log(`
[dev] ready
  web app:  http://localhost:5173   sign in: ${get("INITIAL_ADMIN_EMAIL")} / ${get("INITIAL_ADMIN_PASSWORD")}  (first login forces a new password)
  site:     http://localhost:${SITE_PORT}   (marketing page; firm id "demo")
  console:  http://localhost:${CONSOLE_PORT}   (admin / admin)
  api:      http://localhost:${INSTANCE_PORT}
`);

const stop = () => { children.forEach((c) => c.kill()); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
