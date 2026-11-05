import { Hono } from "hono";
import { z } from "zod";
import { roundCents } from "@nexo/shared/billing";
import { pool } from "../db.ts";
import { audit } from "../auth/access.ts";
import { requirePermission, requireReady, type Env } from "../auth/session.ts";
import { config } from "../config.ts";
import { allCustomers, authorizeUrl, completeConnect, createCustomer, disconnect, invoiceBalance, normName, pushInvoice, QB_CALLBACK, qbConn, qbState } from "../lib/quickbooks.ts";
import { loadIntegration, patchIntegration, redirectUri, ServiceError } from "../lib/services.ts";
import { settings } from "./accounting.ts";
import { auth, body, isUuid } from "./util.ts";

// QuickBooks Online: connect with the firm's Intuit app, match clients with customers (reviewed first), send invoices
// (sent again = updated, never doubled), and bring payments back so the balances here follow QuickBooks.
export const quickbooksRoutes = new Hono<Env>();
quickbooksRoutes.use("*", requireReady);
quickbooksRoutes.onError((e, c) => {
  if (e instanceof ServiceError) return c.json({ error: e.code, detail: e.detail }, e.status as 400);
  throw e;
});
const ADMIN = requirePermission("admin.integrations.manage");
const SEE = requirePermission("admin.integrations.view", "admin.integrations.manage", "accounting.invoices.view", "accounting.invoices.manage");
const BILL = requirePermission("accounting.invoices.manage");

quickbooksRoutes.get("/status", SEE, async (c) => {
  const conn = await qbConn();
  const m = await loadIntegration("quickbooks");
  const counts = (await pool.query("select count(*) filter (where quickbooks_id is not null)::int as linked, count(*)::int as total from clients where status <> 'inactive'")).rows[0];
  return c.json({
    configured: Boolean(conn), connected: Boolean(conn?.connected), needsReauth: conn?.needsReauth ?? false, environment: conn?.environment ?? "sandbox", realmId: m.config.realmId ?? null,
    connectedAt: m.config.connectedAt ?? null, lastPull: m.config.lastPull ?? null, autoSync: m.config.autoSync === "1", redirectUri: config.publicUrl ? redirectUri(QB_CALLBACK) : null, linkedClients: counts.linked, clients: counts.total,
  });
});

quickbooksRoutes.get("/connect", ADMIN, async (c) => c.json({ url: await authorizeUrl(auth(c).user.id) }));

/** The return trip from Intuit (code and company id). */
quickbooksRoutes.get("/callback", ADMIN, async (c) => {
  const back = (q: string) => c.redirect(`/admin/integrations/quickbooks?${q}`);
  const code = c.req.query("code"), realm = c.req.query("realmId");
  if (c.req.query("error")) return back(`error=${encodeURIComponent(c.req.query("error")!)}`);
  if (!code || !realm || qbState.read(c.req.query("state") ?? "") !== auth(c).user.id) return back("error=state");
  try {
    await completeConnect(code, realm);
    await audit("quickbooks.connected", { userId: auth(c).user.id, target: realm });
    return back("connected=1");
  } catch (e) { return back(`error=${encodeURIComponent(e instanceof ServiceError ? e.code : "failed")}`); }
});

quickbooksRoutes.post("/disconnect", ADMIN, async (c) => {
  await disconnect();
  await audit("quickbooks.disconnected", { userId: auth(c).user.id });
  return c.json({ ok: true });
});

quickbooksRoutes.put("/settings", ADMIN, async (c) => {
  const d = await body(c, z.object({ autoSync: z.boolean() }));
  await patchIntegration("quickbooks", { config: { autoSync: d.autoSync ? "1" : "0" } });
  return c.json({ ok: true });
});

// ------------------------------------------------------------------ Clients and customers (reviewed, then applied)
quickbooksRoutes.get("/customers/plan", ADMIN, async (c) => {
  const customers = await allCustomers();
  const byName = new Map(customers.map((x) => [normName(x.DisplayName), x]));
  const clients = (await pool.query("select id, name, quickbooks_id from clients where status <> 'inactive' order by lower(name)")).rows;
  const taken = new Set(clients.filter((x) => x.quickbooks_id).map((x) => x.quickbooks_id as string));
  return c.json({
    rows: clients.map((cl) => {
      if (cl.quickbooks_id) return { clientId: cl.id, name: cl.name, action: "linked", customer: customers.find((x) => x.Id === cl.quickbooks_id) ?? { Id: cl.quickbooks_id, DisplayName: "?" } };
      const m = byName.get(normName(cl.name));
      return m && !taken.has(m.Id) ? { clientId: cl.id, name: cl.name, action: "link", customer: m } : { clientId: cl.id, name: cl.name, action: "create", customer: null };
    }),
  });
});

quickbooksRoutes.post("/customers/sync", ADMIN, async (c) => {
  const d = await body(c, z.object({ clientIds: z.array(z.string().uuid()).min(1).max(500) }));
  const customers = await allCustomers();
  const byName = new Map(customers.map((x) => [normName(x.DisplayName), x]));
  let linked = 0, created = 0;
  const errors: { name: string; error: string }[] = [];
  for (const id of d.clientIds) {
    const cl = (await pool.query("select * from clients where id = $1", [id])).rows[0];
    if (!cl || cl.quickbooks_id) continue;
    try {
      let cu = byName.get(normName(cl.name));
      if (cu && (await pool.query("select 1 from clients where quickbooks_id = $1", [cu.Id])).rowCount) cu = undefined; // already tied to another client
      if (cu) linked++;
      else { cu = await createCustomer({ name: cl.name, email: cl.billing_email || cl.email, address: cl.address, city: cl.city, province: cl.province, postalCode: cl.postal_code, phone: cl.phone }); created++; }
      await pool.query("update clients set quickbooks_id = $2 where id = $1", [id, cu.Id]);
    } catch (e) { errors.push({ name: cl.name, error: e instanceof ServiceError ? `${e.code}${e.detail ? `: ${e.detail}` : ""}` : "failed" }); }
  }
  await audit("quickbooks.customers", { userId: auth(c).user.id, detail: { linked, created, errors: errors.length } });
  await patchIntegration("quickbooks", { config: { lastCustomerSync: new Date().toISOString() } });
  return c.json({ linked, created, errors });
});

// ------------------------------------------------------------------ Invoices out, payments back
quickbooksRoutes.post("/invoices/:id", BILL, async (c) => {
  const id = c.req.param("id");
  if (!isUuid(id)) throw new ServiceError(404, "not_found");
  const inv = (await pool.query("select i.*, cl.name as client_name, cl.quickbooks_id as customer_id, cl.billing_email, cl.email as client_email, cl.address, cl.city, cl.province, cl.postal_code, cl.phone from invoices i join clients cl on cl.id = i.client_id where i.id = $1", [id])).rows[0];
  if (!inv) throw new ServiceError(404, "not_found");
  if (inv.status === "draft" || inv.status === "void") throw new ServiceError(409, "invoice_not_sent");
  let customerId = inv.customer_id as string | null;
  if (!customerId) {
    // The client is not a QuickBooks customer yet: make it (or tie it to the customer of the same name).
    const found = (await allCustomers()).find((x) => normName(x.DisplayName) === normName(inv.client_name));
    const cu = found ?? await createCustomer({ name: inv.client_name, email: inv.billing_email || inv.client_email, address: inv.address, city: inv.city, province: inv.province, postalCode: inv.postal_code, phone: inv.phone });
    customerId = cu.Id;
    await pool.query("update clients set quickbooks_id = $2 where id = $1", [inv.client_id, customerId]);
  }
  const lines = (await pool.query("select description, quantity, unit_price from invoice_lines where invoice_id = $1 order by position", [id])).rows;
  const rates = await settings();
  try {
    const r = await pushInvoice({
      number: inv.number, customerId, issueDate: String(inv.issue_date).slice(0, 10), dueDate: String(inv.due_date).slice(0, 10), note: [inv.po_number ? `PO: ${inv.po_number}` : "", inv.notes].filter(Boolean).join("\n"),
      email: inv.billing_email || inv.client_email || "", lines: lines.map((l) => ({ description: l.description, quantity: Number(l.quantity), unitPrice: Number(l.unit_price) })),
      gst: Number(inv.gst), qst: Number(inv.qst), gstRate: rates.gst, qstRate: rates.qst, existing: inv.quickbooks_id ? { id: inv.quickbooks_id } : undefined,
    });
    // After each send the totals are compared: a difference keeps the link but is shown, never hidden.
    const mismatch = Math.abs(r.total - Number(inv.total)) > 0.005;
    await pool.query("update invoices set quickbooks_id = $2, quickbooks_synced_at = now(), quickbooks_error = $3 where id = $1", [id, r.id, mismatch ? `total_mismatch: QuickBooks ${r.total.toFixed(2)} vs ${Number(inv.total).toFixed(2)}` : ""]);
    await audit("quickbooks.invoice", { userId: auth(c).user.id, target: inv.number, detail: { qbId: r.id, updated: Boolean(inv.quickbooks_id) } });
    return c.json({ ok: true, quickbooksId: r.id, updated: Boolean(inv.quickbooks_id), warning: mismatch ? "total_mismatch" : null });
  } catch (e) {
    await pool.query("update invoices set quickbooks_error = $2 where id = $1", [id, e instanceof ServiceError ? `${e.code}${e.detail ? `: ${e.detail}` : ""}`.slice(0, 300) : "failed"]);
    throw e;
  }
});

/** A payment entered in QuickBooks becomes a payment here (the difference between the two balances). */
export async function pullPayments(userId: string | null): Promise<{ checked: number; recorded: number; cents: number; errors: number }> {
  const rows = (await pool.query(
    `select i.id, i.total, i.number, coalesce((select sum(p.amount_cents) from invoice_payments p where p.invoice_id = i.id), 0) as paid_cents, i.quickbooks_id
       from invoices i where i.status = 'sent' and i.quickbooks_id is not null`)).rows;
  let recorded = 0, cents = 0, errors = 0;
  for (const i of rows) {
    try {
      const qb = await invoiceBalance(i.quickbooks_id);
      if (!qb) continue;
      const ours = Math.round(Number(i.total) * 100) - Number(i.paid_cents);
      const theirs = Math.round(qb.balance * 100);
      if (ours > 0 && theirs < ours) {
        const diff = ours - theirs;
        await pool.query("insert into invoice_payments (invoice_id, amount_cents, method, reference, note, created_by) values ($1,$2,'quickbooks',$3,'brought from QuickBooks',$4)", [i.id, diff, i.quickbooks_id, userId]);
        if (theirs === 0) await pool.query("update invoices set status = 'paid', paid_at = now() where id = $1", [i.id]);
        recorded++; cents += diff;
      }
    } catch { errors++; }
  }
  await patchIntegration("quickbooks", { config: { lastPull: new Date().toISOString() } });
  return { checked: rows.length, recorded, cents, errors };
}

quickbooksRoutes.post("/payments/pull", BILL, async (c) => {
  const r = await pullPayments(auth(c).user.id);
  await audit("quickbooks.payments_pulled", { userId: auth(c).user.id, detail: r });
  return c.json({ ...r, amount: roundCents(r.cents / 100) });
});

/** Every 15 minutes when connected and automatic sync is on. */
export async function quickbooksTick(): Promise<void> {
  const conn = await qbConn();
  if (!conn?.connected || conn.needsReauth) return;
  if ((await loadIntegration("quickbooks")).config.autoSync !== "1") return;
  await pullPayments(null);
}
