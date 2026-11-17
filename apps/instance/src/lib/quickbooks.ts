import { createHash, randomUUID } from "node:crypto";
import { roundCents } from "@hexa/shared/billing";
import { config } from "../config.ts";
import { readState, signState } from "./oauthState.ts";
import { http, loadIntegration, patchIntegration, redirectUri, ServiceError, URLS } from "./services.ts";

// QuickBooks Online through the firm's own Intuit app (OAuth 2.0 authorization code). Access tokens last an hour and are
// refreshed on demand; Intuit rotates the refresh token on every refresh, so the new one is always kept.
export const QB_CALLBACK = "/api/accounting/quickbooks/callback";
const SCOPE = "com.intuit.quickbooks.accounting";
export const qbState = { sign: (userId: string) => signState("qb", userId), read: (state: string) => readState("qb", state) };

export interface QbConn { environment: string; clientId: string; clientSecret: string; realmId: string | null; connected: boolean; needsReauth: boolean }

export async function qbConn(): Promise<QbConn | null> {
  const m = await loadIntegration("quickbooks");
  if (!m.enabled || !m.config.clientId || !m.secrets.clientSecret) return null;
  return { environment: m.config.environment || "sandbox", clientId: m.config.clientId, clientSecret: m.secrets.clientSecret, realmId: m.config.realmId || null, connected: Boolean(m.secrets.qbRefresh && m.config.realmId), needsReauth: m.config.qbNeedsReauth === "1" };
}

export async function authorizeUrl(userId: string): Promise<string> {
  const c = await qbConn();
  if (!c) throw new ServiceError(409, "quickbooks_not_configured");
  if (!config.publicUrl) throw new ServiceError(409, "public_url_missing");
  const q = new URLSearchParams({ client_id: c.clientId, scope: SCOPE, redirect_uri: redirectUri(QB_CALLBACK), response_type: "code", state: qbState.sign(userId) });
  return `${URLS.intuitAuth()}?${q}`;
}

interface Tokens { access_token: string; refresh_token: string; expires_in: number }
async function tokenCall(c: QbConn, params: Record<string, string>): Promise<Tokens> {
  const res = await http(URLS.intuitToken(), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", authorization: `Basic ${Buffer.from(`${c.clientId}:${c.clientSecret}`).toString("base64")}` },
    body: new URLSearchParams(params),
  });
  const j = (await res.json().catch(() => null)) as (Tokens & { error?: string }) | null;
  if (!res.ok || !j?.access_token) throw new ServiceError(res.status === 400 || res.status === 401 ? 401 : 502, j?.error === "invalid_grant" ? "qb_reauth" : "intuit_refused", j?.error);
  return j;
}

async function storeTokens(t: Tokens, extra: Record<string, string> = {}) {
  await patchIntegration("quickbooks", { secrets: { qbAccess: t.access_token, qbRefresh: t.refresh_token, qbExpires: String(Date.now() + t.expires_in * 1000) }, config: { qbNeedsReauth: "0", ...extra } });
}

/** Finishes the connection: the code and the company (realm) id come back from Intuit. */
export async function completeConnect(code: string, realmId: string): Promise<void> {
  const c = await qbConn();
  if (!c) throw new ServiceError(409, "quickbooks_not_configured");
  const t = await tokenCall(c, { grant_type: "authorization_code", code, redirect_uri: redirectUri(QB_CALLBACK) });
  await storeTokens(t, { realmId, connectedAt: new Date().toISOString() });
}

/** Disconnect: the tokens are revoked at Intuit (best effort) and then wiped here. */
export async function disconnect(): Promise<void> {
  const m = await loadIntegration("quickbooks");
  const c = await qbConn();
  const tok = m.secrets.qbRefresh;
  if (c && tok) {
    try { await http(URLS.intuitRevoke(), { method: "POST", headers: { "content-type": "application/json", accept: "application/json", authorization: `Basic ${Buffer.from(`${c.clientId}:${c.clientSecret}`).toString("base64")}` }, body: JSON.stringify({ token: tok }) }, 10_000); }
    catch { /* Intuit unreachable: the tokens are still wiped here and expire on their own. */ }
  }
  await patchIntegration("quickbooks", {}, ["qbAccess", "qbRefresh", "qbExpires", "realmId", "connectedAt", "qbNeedsReauth", "itemId", "lastPull", "lastCustomerSync"]);
}

// ---- pure helpers (unit-tested)
/** The access token is good if it has more than a minute left. */
export const tokenFresh = (expires: string | number | undefined, now = Date.now()) => Number(expires) > now + 60_000;
/** Retry on throttling (429), Intuit trouble (500 to 504); never on other 4xx. */
export const retryable = (status: number) => status === 429 || (status >= 500 && status <= 504);
/** Wait before retry n (0-based): Retry-After (seconds, capped at 10 s) when given, else 0.5 s, 1 s, 2 s plus jitter. */
export const backoffMs = (attempt: number, retryAfter?: string | null, rand = Math.random()) => {
  const ra = Number(retryAfter);
  if (retryAfter && Number.isFinite(ra) && ra >= 0) return Math.min(ra, 10) * 1000;
  return 500 * 2 ** attempt + Math.floor(rand * 250);
};
export const MAX_ATTEMPTS = 4;
/** Escapes a value for a QuickBooks query string literal (backslash first, then the quote). */
export const qEscape = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
/** QuickBooks refuses colons, tabs and line breaks in names and caps them at 100 characters. */
export const cleanName = (s: string) => s.replace(/[:\t\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
/** The same invoice content always gives the same request id, so a retried or doubled send is answered with the first result. */
export const requestIdFor = (kind: string, key: string, body: unknown) => createHash("sha256").update(`${kind}|${key}|${JSON.stringify(body)}`).digest("hex").slice(0, 40);
export const money = (qty: number, price: number) => roundCents(qty * price);
/** Intuit error (HTTP status + Fault) to a stable code. Missing objects come back as 400 + code 610, not 404. */
export function faultCode(status: number, f?: { code?: string }): string {
  const code = f?.code;
  if (code === "6240") return "qb_duplicate";
  if (code === "610" || status === 404) return "not_found";
  if (code === "5010") return "qb_stale";
  if (status === 401 || code === "3200" || code === "100") return "qb_auth";
  if (status === 429 || code === "3001") return "qb_throttled";
  if (status === 400 || status === 403) return "qb_validation";
  return "quickbooks_error";
}

// One refresh at a time: Intuit rotates the refresh token, so two parallel refreshes would burn it and force a reconnect.
let refreshing: Promise<string> | null = null;

async function access(force = false, failedToken?: string): Promise<{ token: string; conn: QbConn }> {
  const conn = await qbConn();
  if (!conn) throw new ServiceError(409, "quickbooks_not_configured");
  const m = await loadIntegration("quickbooks");
  if (!conn.connected || !m.secrets.qbRefresh) throw new ServiceError(409, "quickbooks_not_connected");
  if (m.config.qbNeedsReauth === "1") throw new ServiceError(401, "qb_reauth");
  // Fresh, and not the one that just got a 401 (another call may already have renewed it).
  if (m.secrets.qbAccess && tokenFresh(m.secrets.qbExpires) && (!force || m.secrets.qbAccess !== failedToken)) return { token: m.secrets.qbAccess, conn };
  if (!refreshing) {
    const refresh = m.secrets.qbRefresh;
    refreshing = (async () => {
      try {
        const t = await tokenCall(conn, { grant_type: "refresh_token", refresh_token: refresh });
        await storeTokens(t);
        return t.access_token;
      } catch (e) {
        if (e instanceof ServiceError && e.code === "qb_reauth") await patchIntegration("quickbooks", { config: { qbNeedsReauth: "1" } });
        throw e;
      } finally { refreshing = null; }
    })();
  }
  return { token: await refreshing, conn };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One call to the accounting API (JSON in and out). A 401 gets one retry with a fresh token; throttling and 5xx are retried
 * with backoff. Every POST carries a requestid (same on each retry), so a retry never creates a second object.
 */
export async function qbo<T = any>(method: "GET" | "POST", path: string, payload?: unknown, requestId?: string): Promise<T> {
  const rid = method === "POST" ? (requestId ?? randomUUID()) : null;
  let refreshed = false, token: string | undefined;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const a = await access(refreshed, token);
    token = a.token;
    const url = `${URLS.qbo(a.conn.environment)}/v3/company/${encodeURIComponent(a.conn.realmId!)}${path}${path.includes("?") ? "&" : "?"}minorversion=75${rid ? `&requestid=${rid}` : ""}`;
    let res: Response;
    try { res = await http(url, { method, headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(payload ? { "content-type": "application/json" } : {}) }, body: payload ? JSON.stringify(payload) : undefined }, 30_000); }
    catch (e) { if (attempt < MAX_ATTEMPTS - 1) { await sleep(backoffMs(attempt)); continue; } throw e; }
    if (res.status === 401 && !refreshed) { refreshed = true; attempt--; continue; }
    if (retryable(res.status) && attempt < MAX_ATTEMPTS - 1) { await sleep(backoffMs(attempt, res.headers.get("retry-after"))); continue; }
    const j = (await res.json().catch(() => null)) as any;
    if (!res.ok) {
      const f = j?.Fault?.Error?.[0];
      const code = faultCode(res.status, f);
      console.error(`[quickbooks] ${method} ${path.split("?")[0]} -> ${res.status} ${code}${f?.code ? ` (${f.code})` : ""}`);
      throw new ServiceError(code === "qb_auth" ? 401 : code === "not_found" ? 404 : code === "qb_validation" ? 422 : 502, code, f ? `${f.Message}${f.Detail ? `: ${f.Detail}` : ""}`.slice(0, 300) : `HTTP ${res.status}`);
    }
    return j as T;
  }
  throw new ServiceError(502, "quickbooks_error", "retries exhausted");
}

const q = qEscape;
export const qboQuery = async <T = any>(sql: string): Promise<T[]> => {
  const j = await qbo<{ QueryResponse?: Record<string, T[]> }>("GET", `/query?query=${encodeURIComponent(sql)}`);
  const resp = j.QueryResponse ?? {};
  return (Object.values(resp).find(Array.isArray) as T[] | undefined) ?? [];
};

export const normName = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\b(inc|ltee|ltd|corp|enr|senc|s\.e\.n\.c)\b\.?/g, "").replace(/[^a-z0-9]+/g, " ").trim();

export interface QbCustomer { Id: string; DisplayName: string; SyncToken?: string }
export async function allCustomers(): Promise<QbCustomer[]> {
  const out: QbCustomer[] = [];
  for (let start = 1; start < 5000; start += 1000) {
    const page = await qboQuery<QbCustomer>(`select Id, DisplayName, SyncToken from Customer where Active in (true, false) startposition ${start} maxresults 1000`);
    out.push(...page);
    if (page.length < 1000) break;
  }
  return out;
}

export async function createCustomer(c: { name: string; email?: string; address?: string; city?: string; province?: string; postalCode?: string; phone?: string }): Promise<QbCustomer> {
  const name = cleanName(c.name);
  const body = { DisplayName: name, ...(c.email ? { PrimaryEmailAddr: { Address: c.email } } : {}), ...(c.phone ? { PrimaryPhone: { FreeFormNumber: c.phone } } : {}),
    ...(c.address || c.city ? { BillAddr: { Line1: c.address ?? "", City: c.city ?? "", CountrySubDivisionCode: c.province ?? "", PostalCode: c.postalCode ?? "" } } : {}) };
  try { return (await qbo<{ Customer: QbCustomer }>("POST", "/customer", body, requestIdFor("customer", name, body))).Customer; }
  catch (e) {
    // The name exists already (a duplicate): use that customer rather than failing.
    if (e instanceof ServiceError && e.code === "qb_duplicate") { const f = await qboQuery<QbCustomer>(`select Id, DisplayName, SyncToken from Customer where DisplayName = '${q(name)}'`); if (f[0]) return f[0]; }
    throw e;
  }
}

/** The service item invoice lines are sold under (made once: it needs an income account). */
export async function serviceItemId(): Promise<string> {
  const m = await loadIntegration("quickbooks");
  if (m.config.itemId) return m.config.itemId;
  let item = (await qboQuery<{ Id: string }>("select Id from Item where Name = 'Services' and Type = 'Service'"))[0];
  if (!item) {
    const acct = (await qboQuery<{ Id: string }>("select Id from Account where AccountType = 'Income' maxresults 1"))[0];
    if (!acct) throw new ServiceError(409, "qb_no_income_account");
    item = (await qbo<{ Item: { Id: string } }>("POST", "/item", { Name: "Services", Type: "Service", IncomeAccountRef: { value: acct.Id } })).Item;
  }
  await patchIntegration("quickbooks", { config: { itemId: item.Id } });
  return item.Id;
}

export interface PushInvoice { number: string; customerId: string; issueDate: string; dueDate: string; note: string; email: string; lines: { description: string; quantity: number; unitPrice: number }[]; gst: number; qst: number; gstRate: number; qstRate: number; existing?: { id: string } }

/**
 * Creates the invoice in QuickBooks (or updates it, sparse, if it was sent before: never doubled).
 * Duplicates are blocked three ways: the request id (same content = same id), a look-up by invoice number before creating,
 * and the saved QuickBooks id on the portal invoice.
 * Taxes: with a QuickBooks tax code chosen in the integration ("Tax code id"), lines carry it (TaxExcluded) and QuickBooks
 * computes GST/QST, so its tax reports are right. Without one, taxes go as their own lines so the total still equals the portal's.
 */
export async function pushInvoice(i: PushInvoice): Promise<{ id: string; total: number }> {
  const item = await serviceItemId();
  const taxCode = (await loadIntegration("quickbooks")).config.taxCodeId?.trim() || "";
  const line = (description: string, qty: number, price: number) => ({ Amount: money(qty, price), DetailType: "SalesItemLineDetail", Description: description.slice(0, 4000), SalesItemLineDetail: { ItemRef: { value: item }, Qty: qty, UnitPrice: price, ...(taxCode ? { TaxCodeRef: { value: taxCode } } : {}) } });
  const lines = [...i.lines.map((l) => line(l.description, l.quantity, l.unitPrice)), ...(!taxCode && i.gst ? [line(`TPS/GST (${i.gstRate}%)`, 1, i.gst)] : []), ...(!taxCode && i.qst ? [line(`TVQ/QST (${i.qstRate}%)`, 1, i.qst)] : [])];
  const body: Record<string, unknown> = { CustomerRef: { value: i.customerId }, TxnDate: i.issueDate, DueDate: i.dueDate, DocNumber: i.number.slice(0, 21), PrivateNote: i.note.slice(0, 4000), Line: lines, ...(taxCode ? { GlobalTaxCalculation: "TaxExcluded" } : {}), ...(i.email ? { BillEmail: { Address: i.email } } : {}) };
  let existingId = i.existing?.id;
  // Lost answer on an earlier send (the invoice exists in QuickBooks but the portal never saved its id): adopt it, do not create another.
  if (!existingId) existingId = (await qboQuery<{ Id: string }>(`select Id from Invoice where DocNumber = '${q(String(body.DocNumber))}' and CustomerRef = '${q(i.customerId)}'`))[0]?.Id;
  if (existingId) {
    const cur = (await qbo<{ Invoice: { SyncToken: string } }>("GET", `/invoice/${encodeURIComponent(existingId)}`)).Invoice;
    const upd = { ...body, Id: existingId, SyncToken: cur.SyncToken, sparse: true };
    const r = await qbo<{ Invoice: { Id: string; TotalAmt: number } }>("POST", "/invoice", upd, requestIdFor("invoice-update", existingId, upd));
    return { id: r.Invoice.Id, total: Number(r.Invoice.TotalAmt) };
  }
  const r = await qbo<{ Invoice: { Id: string; TotalAmt: number } }>("POST", "/invoice", body, requestIdFor("invoice", i.number, body));
  return { id: r.Invoice.Id, total: Number(r.Invoice.TotalAmt) };
}

/** QuickBooks tax codes (id and name), so the firm can pick the GST/QST one. */
export const taxCodes = () => qboQuery<{ Id: string; Name: string; Active?: boolean }>("select Id, Name, Active from TaxCode maxresults 200");

/**
 * Voids the invoice in QuickBooks: reads it for its SyncToken, then POST /invoice?operation=void { Id, SyncToken }.
 * Already gone (not found) or already voided (zero total with a "Voided" note) counts as done. Any other failure throws.
 */
export async function voidInvoice(id: string): Promise<{ alreadyVoid: boolean }> {
  let cur: { SyncToken: string; TotalAmt?: number; PrivateNote?: string };
  try { cur = (await qbo<{ Invoice: typeof cur }>("GET", `/invoice/${encodeURIComponent(id)}`)).Invoice; }
  catch (e) { if (e instanceof ServiceError && e.code === "not_found") return { alreadyVoid: true }; throw e; }
  if (Number(cur.TotalAmt) === 0 && /void/i.test(cur.PrivateNote ?? "")) return { alreadyVoid: true };
  const b = { Id: id, SyncToken: cur.SyncToken };
  await qbo("POST", "/invoice?operation=void", b, requestIdFor("void", id, b));
  return { alreadyVoid: false };
}

export async function invoiceBalance(id: string): Promise<{ balance: number; total: number } | null> {
  try { const r = (await qbo<{ Invoice: { Balance: number; TotalAmt: number } }>("GET", `/invoice/${encodeURIComponent(id)}`)).Invoice; return { balance: Number(r.Balance), total: Number(r.TotalAmt) }; }
  catch (e) { if (e instanceof ServiceError && e.code === "not_found") return null; throw e; }
}
