import { Hono } from "hono";
import { z } from "zod";
import { computeInvoice, DEFAULT_RATES, addDays, todayISO, type TaxRates } from "@nexo/shared/billing";
import { pool } from "../db.ts";
import { audit } from "../auth/access.ts";
import { requirePermission, type Env } from "../auth/session.ts";
import { getSetting, setSetting } from "../db.ts";
import { auth, body, buildUpdate, camel, camelRows, isUuid } from "./util.ts";

export const accountingRoutes = new Hono<Env>();

interface AccountingSettings extends TaxRates { paymentTermsDays: number; invoicePrefix: string }
const DEFAULTS: AccountingSettings = { ...DEFAULT_RATES, paymentTermsDays: 30, invoicePrefix: "F-" };
const settings = async (): Promise<AccountingSettings> => ({ ...DEFAULTS, ...((await getSetting<Partial<AccountingSettings>>("accounting")) ?? {}) });

accountingRoutes.get("/settings", requirePermission("accounting.invoices.view", "accounting.approvals.view"), async (c) => c.json(await settings()));
accountingRoutes.put("/settings", requirePermission("accounting.invoices.manage"), async (c) => {
  const d = await body(c, z.object({ gst: z.number().min(0).max(30), qst: z.number().min(0).max(30), paymentTermsDays: z.number().int().min(0).max(365), invoicePrefix: z.string().max(10) }));
  await setSetting("accounting", d);
  await audit("accounting.settings", { userId: auth(c).user.id });
  return c.json({ ok: true });
});

// =============================== Work to bill ===============================
// Reference model: billable work (approved time, tasks, manual lines) becomes billing items. An approver
// approves, edits or excludes each one; approved items are then turned into invoices.
const ItemInput = z.object({
  clientId: z.string().uuid(), description: z.string().min(1).max(500), quantity: z.number().min(0.01).max(100000),
  unitPrice: z.number().min(0).max(1e7), workDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});

accountingRoutes.get("/billing-items", requirePermission("accounting.approvals.view", "accounting.approvals.manage"), async (c) => {
  const status = c.req.query("status") ?? "pending";
  const client = c.req.query("client");
  const r = await pool.query(
    `select b.*, cl.name as client_name, u.name as created_by_name from billing_items b join clients cl on cl.id = b.client_id left join users u on u.id = b.created_by
      where ($1 = 'all' or b.status = $1) and ($2::uuid is null or b.client_id = $2) order by cl.name, b.work_date nulls last, b.created_at limit 1000`,
    [["pending", "approved", "excluded", "invoiced", "all"].includes(status) ? status : "pending", client && isUuid(client) ? client : null],
  );
  return c.json(camelRows(r));
});

accountingRoutes.post("/billing-items", requirePermission("accounting.approvals.manage"), async (c) => {
  const d = await body(c, ItemInput);
  const r = await pool.query("insert into billing_items (client_id, source, description, quantity, unit_price, work_date, created_by) values ($1, 'manual', $2, $3, $4, $5, $6) returning id", [d.clientId, d.description, d.quantity, d.unitPrice, d.workDate ?? null, auth(c).user.id]);
  return c.json({ id: r.rows[0].id }, 201);
});

accountingRoutes.patch("/billing-items/:id", requirePermission("accounting.approvals.manage"), async (c) => {
  const d = await body(c, ItemInput.omit({ clientId: true }).partial());
  const { sets, values } = buildUpdate(d, { description: "description", quantity: "quantity", unitPrice: "unit_price", workDate: "work_date" }, 2);
  if (!sets.length) return c.json({ error: "nothing to update" }, 400);
  const r = await pool.query(`update billing_items set ${sets.join(", ")} where id = $1 and status in ('pending','approved','excluded') returning id`, [c.req.param("id"), ...values]);
  return r.rowCount ? c.json({ ok: true }) : c.json({ error: "not found or already invoiced" }, 409);
});

accountingRoutes.post("/billing-items/decision", requirePermission("accounting.approvals.manage"), async (c) => {
  const d = await body(c, z.object({ ids: z.array(z.string().uuid()).min(1).max(500), decision: z.enum(["approve", "exclude", "restore"]), reason: z.string().max(300).optional() }));
  const status = d.decision === "approve" ? "approved" : d.decision === "exclude" ? "excluded" : "pending";
  const r = await pool.query(
    "update billing_items set status = $2, reason = coalesce($3,''), decided_by = $4, decided_at = now() where id = any($1::uuid[]) and status <> 'invoiced' returning id",
    [d.ids, status, d.reason, auth(c).user.id]);
  return c.json({ updated: r.rowCount });
});

// =============================== Invoices ===============================
const LineInput = z.object({ description: z.string().min(1).max(500), quantity: z.number().min(0.01).max(100000), unitPrice: z.number().min(-1e7).max(1e7), taxable: z.boolean().default(true), billingItemId: z.string().uuid().nullable().optional() });

async function writeInvoiceLines(invoiceId: string, lines: z.infer<typeof LineInput>[]) {
  const s = await settings();
  const calc = computeInvoice(lines.map((l) => ({ quantity: l.quantity, unitPrice: l.unitPrice, taxable: l.taxable })), s);
  await pool.query("delete from invoice_lines where invoice_id = $1", [invoiceId]);
  for (const [i, l] of calc.lines.entries()) {
    await pool.query("insert into invoice_lines (invoice_id, position, description, quantity, unit_price, taxable, amount, billing_item_id) values ($1,$2,$3,$4,$5,$6,$7,$8)", [invoiceId, i, lines[i]!.description, l.quantity, l.unitPrice, l.taxable, l.amount, lines[i]!.billingItemId ?? null]);
  }
  await pool.query("update invoices set subtotal = $2, gst = $3, qst = $4, total = $5 where id = $1", [invoiceId, calc.subtotal, calc.gst, calc.qst, calc.total]);
}

async function newInvoice(clientId: string, userId: string, lines: z.infer<typeof LineInput>[], dates?: { issueDate?: string; dueDate?: string }, notes = ""): Promise<string> {
  const s = await settings();
  const issue = dates?.issueDate ?? todayISO();
  // Reference rule: the due date counts from the day the invoice is issued.
  const due = dates?.dueDate ?? addDays(issue, s.paymentTermsDays);
  const seq = (await pool.query("select nextval('invoice_number_seq') as n")).rows[0].n;
  const r = await pool.query("insert into invoices (number, client_id, issue_date, due_date, notes, created_by) values ($1, $2, $3, $4, $5, $6) returning id", [`${s.invoicePrefix}${seq}`, clientId, issue, due, notes, userId]);
  await writeInvoiceLines(r.rows[0].id, lines);
  return r.rows[0].id as string;
}

accountingRoutes.get("/invoices", requirePermission("accounting.invoices.view", "accounting.invoices.edit", "accounting.invoices.manage"), async (c) => {
  const status = c.req.query("status");
  const client = c.req.query("client");
  const r = await pool.query(
    `select i.*, cl.name as client_name from invoices i join clients cl on cl.id = i.client_id
      where ($1::text is null or i.status = $1) and ($2::uuid is null or i.client_id = $2) order by i.created_at desc limit 500`,
    [status && ["draft", "sent", "paid", "void"].includes(status) ? status : null, client && isUuid(client) ? client : null],
  );
  return c.json(camelRows(r));
});

accountingRoutes.get("/invoices/:id", requirePermission("accounting.invoices.view", "accounting.invoices.edit", "accounting.invoices.manage"), async (c) => {
  if (!isUuid(c.req.param("id"))) return c.json({ error: "not found" }, 404);
  const r = await pool.query("select i.*, cl.name as client_name, cl.address, cl.city, cl.province, cl.postal_code, cl.email as client_email from invoices i join clients cl on cl.id = i.client_id where i.id = $1", [c.req.param("id")]);
  if (!r.rows[0]) return c.json({ error: "not found" }, 404);
  const lines = await pool.query("select * from invoice_lines where invoice_id = $1 order by position", [c.req.param("id")]);
  return c.json({ ...camel(r.rows[0]), lines: camelRows(lines), rates: await settings() });
});

accountingRoutes.post("/invoices", requirePermission("accounting.invoices.edit", "accounting.invoices.manage"), async (c) => {
  const d = await body(c, z.object({ clientId: z.string().uuid(), lines: z.array(LineInput).min(1).max(200), issueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), notes: z.string().max(2000).optional() }));
  const id = await newInvoice(d.clientId, auth(c).user.id, d.lines, d, d.notes);
  return c.json({ id }, 201);
});

/** Turns approved work-to-bill into draft invoices, one per client. */
accountingRoutes.post("/invoices/from-items", requirePermission("accounting.invoices.edit", "accounting.invoices.manage"), async (c) => {
  const d = await body(c, z.object({ clientId: z.string().uuid().optional() }));
  const items = (await pool.query("select * from billing_items where status = 'approved' and ($1::uuid is null or client_id = $1) order by client_id, work_date nulls last, created_at", [d.clientId ?? null])).rows;
  const byClient = new Map<string, typeof items>();
  for (const it of items) byClient.set(it.client_id, [...(byClient.get(it.client_id) ?? []), it]);
  const created: string[] = [];
  for (const [clientId, rows] of byClient) {
    const id = await newInvoice(clientId, auth(c).user.id, rows.map((it) => ({
      description: it.work_date ? `${it.description} (${it.work_date})` : it.description, quantity: it.quantity, unitPrice: it.unit_price, taxable: true, billingItemId: it.id,
    })));
    await pool.query("update billing_items set status = 'invoiced', invoice_id = $2 where id = any($1::uuid[])", [rows.map((r) => r.id), id]);
    created.push(id);
  }
  return c.json({ created });
});

accountingRoutes.put("/invoices/:id", requirePermission("accounting.invoices.edit", "accounting.invoices.manage"), async (c) => {
  const inv = (await pool.query("select status from invoices where id = $1", [c.req.param("id")])).rows[0];
  if (!inv) return c.json({ error: "not found" }, 404);
  if (inv.status !== "draft") return c.json({ error: "only drafts can be edited" }, 409);
  const d = await body(c, z.object({ lines: z.array(LineInput).min(1).max(200), issueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), notes: z.string().max(2000).optional() }));
  await pool.query("update invoices set issue_date = coalesce($2, issue_date), due_date = coalesce($3, due_date), notes = coalesce($4, notes) where id = $1", [c.req.param("id"), d.issueDate ?? null, d.dueDate ?? null, d.notes ?? null]);
  await writeInvoiceLines(c.req.param("id"), d.lines);
  return c.json({ ok: true });
});

accountingRoutes.post("/invoices/:id/action", requirePermission("accounting.invoices.manage"), async (c) => {
  const { action } = await body(c, z.object({ action: z.enum(["send", "pay", "void"]) }));
  const id = c.req.param("id");
  const inv = (await pool.query("select status from invoices where id = $1", [id])).rows[0];
  if (!inv) return c.json({ error: "not found" }, 404);
  const allowed: Record<string, string[]> = { send: ["draft"], pay: ["sent"], void: ["draft", "sent"] };
  if (!allowed[action]!.includes(inv.status)) return c.json({ error: `cannot ${action} an invoice that is ${inv.status}` }, 409);
  if (action === "send") await pool.query("update invoices set status = 'sent', sent_at = now() where id = $1", [id]);
  if (action === "pay") await pool.query("update invoices set status = 'paid', paid_at = now() where id = $1", [id]);
  if (action === "void") {
    await pool.query("update invoices set status = 'void' where id = $1", [id]);
    // Voiding releases the work so it can be billed again.
    await pool.query("update billing_items set status = 'approved', invoice_id = null where invoice_id = $1", [id]);
  }
  await audit(`invoice.${action}`, { userId: auth(c).user.id, target: id });
  return c.json({ ok: true });
});

// =============================== Vendors and bills to pay ===============================
const VendorInput = z.object({ name: z.string().min(1).max(200), contact: z.string().max(200).optional(), email: z.string().max(200).optional(), phone: z.string().max(60).optional(), paymentTerms: z.string().max(200).optional(), notes: z.string().max(2000).optional(), active: z.boolean().optional() });

accountingRoutes.get("/vendors", requirePermission("accounting.vendors.view", "accounting.vendors.manage"), async (c) => {
  const r = await pool.query(
    `select v.*, coalesce(sum(b.amount) filter (where b.status <> 'paid'), 0) as owed from vendors v left join vendor_bills b on b.vendor_id = v.id group by v.id order by v.active desc, lower(v.name)`);
  return c.json(camelRows(r));
});
accountingRoutes.post("/vendors", requirePermission("accounting.vendors.manage"), async (c) => {
  const d = await body(c, VendorInput);
  const r = await pool.query("insert into vendors (name, contact, email, phone, payment_terms, notes) values ($1, coalesce($2,''), coalesce($3,''), coalesce($4,''), coalesce($5,''), coalesce($6,'')) returning id", [d.name, d.contact, d.email, d.phone, d.paymentTerms, d.notes]);
  return c.json({ id: r.rows[0].id }, 201);
});
accountingRoutes.patch("/vendors/:id", requirePermission("accounting.vendors.manage"), async (c) => {
  const d = await body(c, VendorInput.partial());
  const { sets, values } = buildUpdate(d, { name: "name", contact: "contact", email: "email", phone: "phone", paymentTerms: "payment_terms", notes: "notes", active: "active" }, 2);
  if (sets.length) await pool.query(`update vendors set ${sets.join(", ")} where id = $1`, [c.req.param("id"), ...values]);
  return c.json({ ok: true });
});

const BillInput = z.object({
  vendorId: z.string().uuid(), number: z.string().max(60).optional(), billDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amount: z.number().min(0).max(1e9), notes: z.string().max(1000).optional(), status: z.enum(["unpaid", "scheduled", "paid"]).optional(),
});

/** The "payments to do" list: unpaid bills by due date, with overdue and due-this-week totals. */
accountingRoutes.get("/bills", requirePermission("accounting.vendors.view", "accounting.vendors.manage"), async (c) => {
  const status = c.req.query("status") ?? "open";
  const r = await pool.query(
    `select b.*, v.name as vendor_name from vendor_bills b join vendors v on v.id = b.vendor_id
      where ($1 = 'all' or ($1 = 'open' and b.status <> 'paid') or b.status = $1) order by b.status = 'paid', b.due_date limit 500`,
    [["open", "all", "unpaid", "scheduled", "paid"].includes(status) ? status : "open"]);
  const today = todayISO();
  const rows = camelRows<{ dueDate: string; amount: number; status: string }>(r);
  const open = rows.filter((b) => b.status !== "paid");
  const sum = (xs: typeof rows) => Math.round(xs.reduce((a, b) => a + b.amount, 0) * 100) / 100;
  return c.json({
    bills: rows, today,
    totals: { open: sum(open), overdue: sum(open.filter((b) => b.dueDate < today)), dueThisWeek: sum(open.filter((b) => b.dueDate >= today && b.dueDate <= addDays(today, 7))) },
  });
});
accountingRoutes.post("/bills", requirePermission("accounting.vendors.manage"), async (c) => {
  const d = await body(c, BillInput);
  const r = await pool.query("insert into vendor_bills (vendor_id, number, bill_date, due_date, amount, notes, status) values ($1, coalesce($2,''), coalesce($3, current_date), $4, $5, coalesce($6,''), coalesce($7,'unpaid')) returning id", [d.vendorId, d.number, d.billDate, d.dueDate, d.amount, d.notes, d.status]);
  return c.json({ id: r.rows[0].id }, 201);
});
accountingRoutes.patch("/bills/:id", requirePermission("accounting.vendors.manage"), async (c) => {
  const d = await body(c, BillInput.partial());
  const { sets, values } = buildUpdate(d, { number: "number", billDate: "bill_date", dueDate: "due_date", amount: "amount", notes: "notes", status: "status" }, 2);
  if (d.status) sets.push(d.status === "paid" ? "paid_on = current_date" : "paid_on = null");
  if (sets.length) await pool.query(`update vendor_bills set ${sets.join(", ")} where id = $1`, [c.req.param("id"), ...values]);
  return c.json({ ok: true });
});
accountingRoutes.delete("/bills/:id", requirePermission("accounting.vendors.manage"), async (c) => {
  await pool.query("delete from vendor_bills where id = $1", [c.req.param("id")]);
  return c.json({ ok: true });
});
