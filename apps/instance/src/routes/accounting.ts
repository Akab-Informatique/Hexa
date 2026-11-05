import { Hono } from "hono";
import { z } from "zod";
import { computeInvoice, DEFAULT_RATES, addDays, todayISO, type TaxRates } from "@nexo/shared/billing";
import { pool } from "../db.ts";
import { audit } from "../auth/access.ts";
import { requirePermission, type Env } from "../auth/session.ts";
import { getSetting, setSetting } from "../db.ts";
import { auth, body, buildUpdate, camel, camelRows, isUuid } from "./util.ts";

export const accountingRoutes = new Hono<Env>();

export interface AccountingSettings extends TaxRates { paymentTermsDays: number; invoicePrefix: string }
const DEFAULTS: AccountingSettings = { ...DEFAULT_RATES, paymentTermsDays: 30, invoicePrefix: "F-" };
export const settings = async (): Promise<AccountingSettings> => ({ ...DEFAULTS, ...((await getSetting<Partial<AccountingSettings>>("accounting")) ?? {}) });

accountingRoutes.get("/settings", requirePermission("accounting.invoices.view", "accounting.approvals.view"), async (c) => c.json(await settings()));
accountingRoutes.put("/settings", requirePermission("accounting.invoices.manage"), async (c) => {
  const d = await body(c, z.object({ gst: z.number().min(0).max(30), qst: z.number().min(0).max(30), paymentTermsDays: z.number().int().min(0).max(365), invoicePrefix: z.string().max(10) }));
  await setSetting("accounting", d);
  await audit("accounting.settings", { userId: auth(c).user.id });
  return c.json({ ok: true });
});

// Work to bill and invoices live in routes/invoicing.ts.

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
