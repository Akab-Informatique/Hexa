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

export async function disconnect(): Promise<void> {
  await patchIntegration("quickbooks", {}, ["qbAccess", "qbRefresh", "qbExpires", "realmId", "connectedAt", "qbNeedsReauth", "itemId", "lastPull", "lastCustomerSync"]);
}

async function access(force = false): Promise<{ token: string; conn: QbConn }> {
  const conn = await qbConn();
  if (!conn) throw new ServiceError(409, "quickbooks_not_configured");
  const m = await loadIntegration("quickbooks");
  if (!conn.connected || !m.secrets.qbRefresh) throw new ServiceError(409, "quickbooks_not_connected");
  if (m.config.qbNeedsReauth === "1") throw new ServiceError(401, "qb_reauth");
  if (!force && m.secrets.qbAccess && Number(m.secrets.qbExpires) > Date.now() + 60_000) return { token: m.secrets.qbAccess, conn };
  try {
    const t = await tokenCall(conn, { grant_type: "refresh_token", refresh_token: m.secrets.qbRefresh });
    await storeTokens(t);
    return { token: t.access_token, conn };
  } catch (e) {
    if (e instanceof ServiceError && e.code === "qb_reauth") await patchIntegration("quickbooks", { config: { qbNeedsReauth: "1" } });
    throw e;
  }
}

/** One call to the accounting API (JSON in and out). A 401 gets one retry with a fresh token. */
export async function qbo<T = any>(method: "GET" | "POST", path: string, payload?: unknown): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { token, conn } = await access(attempt > 0);
    const url = `${URLS.qbo(conn.environment)}/v3/company/${encodeURIComponent(conn.realmId!)}${path}${path.includes("?") ? "&" : "?"}minorversion=75`;
    const res = await http(url, { method, headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(payload ? { "content-type": "application/json" } : {}) }, body: payload ? JSON.stringify(payload) : undefined });
    if (res.status === 401 && attempt === 0) continue;
    const j = (await res.json().catch(() => null)) as any;
    if (!res.ok) {
      const f = j?.Fault?.Error?.[0];
      throw new ServiceError(res.status === 401 ? 401 : res.status === 404 ? 404 : 502, f?.code === "6240" ? "qb_duplicate" : res.status === 404 ? "not_found" : "quickbooks_error", f ? `${f.Message}${f.Detail ? `: ${f.Detail}` : ""}`.slice(0, 300) : `HTTP ${res.status}`);
    }
    return j as T;
  }
  throw new ServiceError(401, "qb_reauth");
}

const q = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
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
  const body = { DisplayName: c.name.slice(0, 100), ...(c.email ? { PrimaryEmailAddr: { Address: c.email } } : {}), ...(c.phone ? { PrimaryPhone: { FreeFormNumber: c.phone } } : {}),
    ...(c.address || c.city ? { BillAddr: { Line1: c.address ?? "", City: c.city ?? "", CountrySubDivisionCode: c.province ?? "", PostalCode: c.postalCode ?? "" } } : {}) };
  try { return (await qbo<{ Customer: QbCustomer }>("POST", "/customer", body)).Customer; }
  catch (e) {
    // The name exists already (a duplicate): use that customer rather than failing.
    if (e instanceof ServiceError && e.code === "qb_duplicate") { const f = await qboQuery<QbCustomer>(`select Id, DisplayName, SyncToken from Customer where DisplayName = '${q(c.name.slice(0, 100))}'`); if (f[0]) return f[0]; }
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
 * Taxes go as their own lines so the QuickBooks total equals the portal's; mapping to QuickBooks tax codes is a later step.
 */
export async function pushInvoice(i: PushInvoice): Promise<{ id: string; total: number }> {
  const item = await serviceItemId();
  const line = (description: string, qty: number, price: number) => ({ Amount: Math.round(qty * price * 100) / 100, DetailType: "SalesItemLineDetail", Description: description.slice(0, 4000), SalesItemLineDetail: { ItemRef: { value: item }, Qty: qty, UnitPrice: price } });
  const lines = [...i.lines.map((l) => line(l.description, l.quantity, l.unitPrice)), ...(i.gst ? [line(`TPS/GST (${i.gstRate}%)`, 1, i.gst)] : []), ...(i.qst ? [line(`TVQ/QST (${i.qstRate}%)`, 1, i.qst)] : [])];
  const body: Record<string, unknown> = { CustomerRef: { value: i.customerId }, TxnDate: i.issueDate, DueDate: i.dueDate, DocNumber: i.number.slice(0, 21), PrivateNote: i.note.slice(0, 4000), Line: lines, ...(i.email ? { BillEmail: { Address: i.email } } : {}) };
  if (i.existing) {
    const cur = (await qbo<{ Invoice: { SyncToken: string } }>("GET", `/invoice/${encodeURIComponent(i.existing.id)}`)).Invoice;
    const r = await qbo<{ Invoice: { Id: string; TotalAmt: number } }>("POST", "/invoice", { ...body, Id: i.existing.id, SyncToken: cur.SyncToken, sparse: true });
    return { id: r.Invoice.Id, total: Number(r.Invoice.TotalAmt) };
  }
  const r = await qbo<{ Invoice: { Id: string; TotalAmt: number } }>("POST", "/invoice", body);
  return { id: r.Invoice.Id, total: Number(r.Invoice.TotalAmt) };
}

export async function invoiceBalance(id: string): Promise<{ balance: number; total: number } | null> {
  try { const r = (await qbo<{ Invoice: { Balance: number; TotalAmt: number } }>("GET", `/invoice/${encodeURIComponent(id)}`)).Invoice; return { balance: Number(r.Balance), total: Number(r.TotalAmt) }; }
  catch (e) { if (e instanceof ServiceError && e.code === "not_found") return null; throw e; }
}
