import { pool } from "../db.ts";
import { open } from "../auth/secrets.ts";
import { URLS } from "./services.ts";
import { PROFILES } from "../seed/profiles.ts";

// SharePoint through Microsoft Graph with the firm's own app registration (application permissions,
// Sites.ReadWrite.All). Users never talk to SharePoint directly: every call goes through the portal,
// which decides per folder what each person may do (see routes/docs.ts).
export interface Library { id: string; name: string }
export interface Item { name: string; path: string; folder: boolean; size: number; modifiedAt: string | null; webUrl: string | null }

export interface Provider {
  mock: boolean;
  libraries(): Promise<Library[]>;
  list(drive: string, path: string): Promise<Item[]>;
  download(drive: string, path: string): Promise<{ data: ArrayBuffer; contentType: string }>;
  upload(drive: string, path: string, name: string, data: ArrayBuffer): Promise<void>;
  mkdir(drive: string, path: string, name: string): Promise<void>;
  remove(drive: string, path: string): Promise<void>;
}

export class SpError extends Error { constructor(public status: number, message: string) { super(message); } }

export const joinPath = (a: string, b: string) => [a, b].filter(Boolean).join("/");
/** Rejects traversal and odd characters; a path is "folder/sub" with no leading slash. */
export function cleanPath(p: string): string {
  const parts = p.split("/").filter((x) => x !== "");
  for (const s of parts) if (s === "." || s === ".." || /[\\<>:"|?*\u0000-\u001f]/.test(s)) throw new SpError(400, "invalid path");
  return parts.join("/");
}

// ------------------------------------------------------------------ Graph
let tokenCache: { key: string; token: string; exp: number } | null = null;
let siteCache: { url: string; id: string } | null = null;

type Creds = { tenantId: string; clientId: string; clientSecret: string; siteUrl: string };

async function creds(): Promise<Creds | null> {
  const r = await pool.query("select provider, config, secret_enc, enabled from integrations where provider in ('o365','sharepoint')");
  const o = r.rows.find((x) => x.provider === "o365");
  const s = r.rows.find((x) => x.provider === "sharepoint");
  const secrets = open(o?.secret_enc);
  if (!o?.config?.tenantId || !o?.config?.clientId || !secrets.clientSecret || !s?.config?.siteUrl || !s.enabled) return null;
  return { tenantId: o.config.tenantId as string, clientId: o.config.clientId as string, clientSecret: secrets.clientSecret as string, siteUrl: (s.config.siteUrl as string).trim() };
}

async function token(c: Creds): Promise<string> {
  const key = `${c.tenantId}:${c.clientId}`;
  if (tokenCache && tokenCache.key === key && tokenCache.exp > Date.now() + 60_000) return tokenCache.token;
  const res = await fetch(`${URLS.msLogin()}/${encodeURIComponent(c.tenantId)}/oauth2/v2.0/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" }),
  });
  if (!res.ok) throw new SpError(502, "Microsoft sign-in failed: check the Microsoft 365 app credentials");
  const j = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache = { key, token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return j.access_token;
}

const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");

function graphProvider(c: Creds): Provider {
  const call = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const res = await fetch(path.startsWith("http") ? path : URLS.graph() + path, { ...init, headers: { authorization: `Bearer ${await token(c)}`, ...(init.headers ?? {}) } });
    if (!res.ok) {
      if (res.status === 404) throw new SpError(404, "not found");
      if (res.status === 409) throw new SpError(409, "already exists");
      throw new SpError(502, `SharePoint error (${res.status})`);
    }
    return res;
  };
  const siteId = async () => {
    if (siteCache?.url === c.siteUrl) return siteCache.id;
    let u: URL;
    try { u = new URL(c.siteUrl); } catch { throw new SpError(400, "invalid SharePoint site address"); }
    const j = (await (await call(`/sites/${u.hostname}:${u.pathname.replace(/\/$/, "")}`)).json()) as { id: string };
    siteCache = { url: c.siteUrl, id: j.id };
    return j.id;
  };
  const base = (drive: string, path: string) => `/drives/${encodeURIComponent(drive)}/root${path ? `:/${enc(path)}:` : ""}`;
  return {
    mock: false,
    async libraries() {
      const j = (await (await call(`/sites/${await siteId()}/drives`)).json()) as { value: { id: string; name: string }[] };
      return j.value.map((d) => ({ id: d.id, name: d.name }));
    },
    async list(drive, path) {
      const out: Item[] = [];
      let next: string | null = `${base(drive, path)}/children?$top=200`;
      while (next) {
        const j = (await (await call(next)).json()) as { value: Record<string, any>[]; "@odata.nextLink"?: string };
        for (const x of j.value) out.push({ name: x.name, path: joinPath(path, x.name), folder: Boolean(x.folder), size: x.size ?? 0, modifiedAt: x.lastModifiedDateTime ?? null, webUrl: x.webUrl ?? null });
        next = j["@odata.nextLink"] ?? null;
      }
      return out;
    },
    async download(drive, path) {
      const res = await call(`${base(drive, path)}/content`);
      return { data: await res.arrayBuffer(), contentType: res.headers.get("content-type") ?? "application/octet-stream" };
    },
    async upload(drive, path, name, data) {
      if (data.byteLength > 4 * 1024 * 1024) throw new SpError(413, "file too large (4 MB maximum)");
      await call(`/drives/${encodeURIComponent(drive)}/root:/${enc(joinPath(path, name))}:/content`, { method: "PUT", body: data, headers: { "content-type": "application/octet-stream" } });
    },
    async mkdir(drive, path, name) {
      const parent = path ? `/drives/${encodeURIComponent(drive)}/root:/${enc(path)}:/children` : `/drives/${encodeURIComponent(drive)}/root/children`;
      await call(parent, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, folder: {}, "@microsoft.graph.conflictBehavior": "fail" }) });
    },
    async remove(drive, path) {
      if (!path) throw new SpError(400, "cannot delete a library");
      await call(base(drive, path), { method: "DELETE" });
    },
  };
}

// ------------------------------------------------------------------ Local stand-in (development only)
// Lets the whole feature be tried without a Microsoft tenant. Enabled by SHAREPOINT_MOCK=1; never in production.
function mockProvider(): Provider {
  const files = new Map<string, { data: ArrayBuffer; type: string }>();
  const folders = new Set<string>();
  // One library, like a real site: client files and HR are folders inside it, protected by the portal's folder rules.
  const L = [{ id: "lib-docs", name: "Documents" }];
  const D = "lib-docs";
  const key = (d: string, p: string) => `${d}::${p}`;
  const text = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
  const CL = "Dossiers clients", HR = "RH (confidentiel)";
  for (const d of ["Politiques", "Modèles", "Formation", CL, HR]) folders.add(key(D, d));
  files.set(key(D, "Politiques/Code de conduite.txt"), { data: text("Code de conduite (exemple)"), type: "text/plain" });
  files.set(key(D, "Modèles/Lettre de mission.txt"), { data: text("Lettre de mission (exemple)"), type: "text/plain" });
  for (const d of ["Acme Corp", "Acme Corp/2025", "Acme Corp/2025/T4", "Boulangerie Dupont", "Boulangerie Dupont/2025"]) folders.add(key(D, `${CL}/${d}`));
  files.set(key(D, `${CL}/Acme Corp/2025/Bilan.txt`), { data: text("Bilan 2025 (exemple)"), type: "text/plain" });
  files.set(key(D, `${CL}/Boulangerie Dupont/2025/Déclaration TPS-TVQ.txt`), { data: text("Déclaration (exemple)"), type: "text/plain" });
  // The demo profile of the tenant adds one folder per sample client, so each demo tenant looks different.
  for (const c of PROFILES[process.env.SEED_PROFILE ?? ""]?.clients ?? []) { folders.add(key(D, `${CL}/${c.name}`)); folders.add(key(D, `${CL}/${c.name}/${new Date().getFullYear() - 1}`)); }
  for (const d of ["Dossiers employés", "Évaluations"]) folders.add(key(D, `${HR}/${d}`));
  files.set(key(D, `${HR}/Évaluations/Gabarit.txt`), { data: text("Gabarit d'évaluation"), type: "text/plain" });
  const now = new Date().toISOString();
  return {
    mock: true,
    async libraries() { return L; },
    async list(d, p) {
      const out: Item[] = [];
      const prefix = p ? p + "/" : "";
      const direct = (kp: string) => kp.startsWith(prefix) && kp.length > prefix.length && !kp.slice(prefix.length).includes("/");
      for (const k of folders) { const [kd = "", kp = ""] = k.split("::"); if (kd === d && direct(kp)) out.push({ name: kp.slice(prefix.length), path: kp, folder: true, size: 0, modifiedAt: now, webUrl: null }); }
      for (const [k, v] of files) { const [kd = "", kp = ""] = k.split("::"); if (kd === d && direct(kp)) out.push({ name: kp.slice(prefix.length), path: kp, folder: false, size: v.data.byteLength, modifiedAt: now, webUrl: null }); }
      return out;
    },
    async download(d, p) { const f = files.get(key(d, p)); if (!f) throw new SpError(404, "not found"); return { data: f.data, contentType: f.type }; },
    async upload(d, p, name, data) { if (data.byteLength > 4 * 1024 * 1024) throw new SpError(413, "file too large (4 MB maximum)"); files.set(key(d, joinPath(p, name)), { data, type: "application/octet-stream" }); },
    async mkdir(d, p, name) { const k = key(d, joinPath(p, name)); if (folders.has(k)) throw new SpError(409, "already exists"); folders.add(k); },
    async remove(d, p) {
      if (!p) throw new SpError(400, "cannot delete a library");
      files.delete(key(d, p)); folders.delete(key(d, p));
      for (const k of [...files.keys()]) if (k.startsWith(key(d, p + "/"))) files.delete(k);
      for (const k of [...folders]) if (k.startsWith(key(d, p + "/"))) folders.delete(k);
    },
  };
}

let mock: Provider | null = null;
/** Null when SharePoint is not configured: the page then tells the admin what to set up. */
export async function getProvider(): Promise<Provider | null> {
  if (process.env.SHAREPOINT_MOCK === "1" && process.env.NODE_ENV !== "production") return (mock ??= mockProvider());
  const c = await creds();
  return c ? graphProvider(c) : null;
}
